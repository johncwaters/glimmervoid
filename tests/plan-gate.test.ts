import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAgentIngressApp } from '../server/backend/backend-http.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { PLAN_GATE_HOOK_EVENT } from '../shared/contracts/plan-gate.ts';
import { recordingSessionFactory } from './helpers/fake-session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const PLAN_REQUEST = { hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\n1. Add the store' } };

test('the dashboard approves or rejects a held Claude plan only while the plan gate is on', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-plan-gate-'));
  const factory = recordingSessionFactory();
  const session = factory.makeSession({ id: 'planner', name: 'planner', path: projectPath });
  const config: GlimmervoidConfig = { projects: [{ id: 'planner', name: 'planner', path: projectPath }], planGate: { enabled: false } };
  const planGateFrames: unknown[] = [];
  const currentPlanGate = () => session.planGate;
  createSessionEventWiring({
    configStore: { save: (mutate) => { mutate(config); return config; } }, config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: (message) => { if (message.type === 'session-status' && 'planGate' in message) planGateFrames.push(message.planGate); },
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  const app = createAgentIngressApp({
    allowedHosts: [],
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: (id) => factory.created.find((created) => created.id === id) ?? null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    isPlanGateOn: () => config.planGate?.enabled === true,
  });
  const server = http.createServer(app);
  const connection = connectControl<{ type: string; message?: string }>(createControlServer(controlDeps(config, { sessions: new Map([[session.id, session]]) })));
  try {
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    await listenOnLoopback(server);
    const postPlan = () => fetch(`http://127.0.0.1:${boundPort(server)}/hook/${session.id}/${PLAN_GATE_HOOK_EVENT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(PLAN_REQUEST),
    });

    const ungated = await postPlan();
    assert.equal(ungated.status, 200);
    assert.equal(await ungated.text(), '');
    assert.equal(currentPlanGate(), null);

    config.planGate = { enabled: true };
    const rejected = postPlan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(currentPlanGate()?.status, 'pending');
    assert.equal(currentPlanGate()?.planText, '# Plan\n\n1. Add the store');
    connection.send({ type: 'plan-decision', id: session.id, decision: 'reject', feedback: 'Use Postgres' });
    const rejectedReply = await (await rejected).json();
    assert.equal(rejectedReply.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(rejectedReply.hookSpecificOutput.decision.message, /Use Postgres/);
    assert.equal(currentPlanGate()?.status, 'rejected');

    const approved = postPlan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    connection.send({ type: 'plan-decision', id: session.id, decision: 'approve' });
    assert.deepEqual((await (await approved).json()).hookSpecificOutput.decision, { behavior: 'allow' });

    connection.send({ type: 'plan-decision', id: session.id, decision: 'approve' });
    assert.equal(connection.sent.at(-1)?.type, 'error');

    const released = postPlan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    connection.send({ type: 'plan-decision', id: session.id, decision: 'terminal' });
    assert.equal(await (await released).text(), '');
    assert.equal(currentPlanGate(), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(planGateFrames.map((frame) => (frame === null ? null : (frame as { status: string }).status)), ['pending', 'rejected', 'pending', 'approved', 'pending', null]);

    const answeredInTerminal = postPlan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    session._approvals.releaseAfterHookEvent('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: PLAN_REQUEST.tool_input });
    assert.equal(await (await answeredInTerminal).text(), '');
    assert.equal(currentPlanGate(), null);

    const exitedWhileHeld = postPlan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    session._approvals.releaseAll();
    assert.equal(await (await exitedWhileHeld).text(), '');
    assert.equal(currentPlanGate(), null);
    connection.send({ type: 'plan-decision', id: session.id, decision: 'approve' });
    assert.equal(connection.sent.at(-1)?.type, 'error');
  } finally {
    await closeServer(server);
    for (const created of factory.created) created.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
