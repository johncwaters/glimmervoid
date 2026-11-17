import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Session } from '../session/sessions.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { capturingPty } from './helpers/fake-pty.ts';
import { permissionRequestDecisionOf } from './helpers/permission-reply.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const QUESTION_REQUEST = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which store?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }] },
};

test('Chat reads a held question from the session status and answers it and sends prompts over the control channel', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-chat-'));
  const writes: string[] = [];
  const session = new Session({ id: 'chatty', name: 'chatty', path: projectPath, holdsQuestionsForParent: true, ptySpawn: () => capturingPty(writes) });
  const config: GlimmervoidConfig = { projects: [] };
  const approvalFrames: unknown[] = [];
  createSessionEventWiring({
    configStore: { save: (mutate) => { mutate(config); return config; } }, config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: (message) => { if (message.type === 'session-status' && 'conversationApproval' in message) approvalFrames.push(message.conversationApproval); },
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  const connection = connectControl<{ type: string; message?: string }>(createControlServer(controlDeps(config, { sessions: new Map([[session.id, session]]) })));
  try {
    await session.start();
    session.transition('first_output');
    session.transition('new_output');
    const held = session.holdConversationPermission(QUESTION_REQUEST, new AbortController().signal);
    assert.ok(held);
    const approval = session.toSnapshot().conversationApproval;
    assert.equal(approval?.kind, 'question');
    assert.equal(approval?.questions?.[0]?.question, 'Which store?');
    await new Promise((resolve) => setImmediate(resolve));

    connection.send({ type: 'answer-approval', id: session.id, requestId: approval?.requestId, answers: { 'Which store?': 'postgres' } });
    const reply = await held;
    assert.deepEqual(permissionRequestDecisionOf(reply)?.behavior, 'allow');
    assert.match(JSON.stringify(reply), /postgres/);
    assert.equal(session.toSnapshot().conversationApproval, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(approvalFrames.map((frame) => (frame === null ? null : (frame as { kind: string }).kind)), ['question', null]);

    connection.send({ type: 'answer-approval', id: session.id, requestId: approval?.requestId, answers: { 'Which store?': 'sqlite' } });
    assert.equal(connection.sent.at(-1)?.type, 'error');

    session.transition('task_complete');
    connection.send({ type: 'chat-send', id: session.id, text: 'Now add the index' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.match(writes.join(''), /Now add the index/);
    assert.equal(writes.at(-1), '\r');
  } finally {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
