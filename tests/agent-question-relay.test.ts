import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAgentApiWiring } from '../server/agent-api-wiring.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { createAgentIngressApp } from '../server/backend/backend-http.ts';
import { DEFAULT_CONFIG } from '../server/config-store.ts';
import { createSessionDocsWiring } from '../server/session/session-docs-wiring.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import type { Session } from '../session/sessions.ts';
import { AGENT_URL_ENV, AgentReadReply } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import { capturingPty } from './helpers/fake-pty.ts';
import { recordingSessionFactory } from './helpers/fake-session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

test('a parent reads and answers held child questions through the agent API or releases them to the operator', async (context) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-question-relay-'));
  const factory = recordingSessionFactory();
  const parentWrites: string[] = [];
  const parent = factory.makeSession({ id: 'parent', name: 'parent', path: projectPath });
  parent.transition('user_start');
  parent.transition('spawn_success', { spawnCwdExists: true });
  parent.transition('first_output');
  parent.ptyProcess = capturingPty(parentWrites);
  parent._ptyAlive = true;
  const agentSessions = new Map<string, Session>();
  const wiring = createAgentApiWiring({
    config: DEFAULT_CONFIG,
    agentSessions,
    listAllSessions: () => factory.created,
    listBoardSessions: () => factory.created,
    makeSession: (project, _config, overrides) => factory.makeSession({
      ...project,
      spawnCommand: { path: process.execPath, kind: 'exe' },
      ...overrides,
    }),
    wireSessionEvents: () => {},
    closeSessionDataClients: () => {},
    broadcastControl: () => {},
    spawnGate: createSpawnGate(),
    sessionDocs: createSessionDocsWiring({ broadcastControl: () => {} }),
  });
  const app = createAgentIngressApp({
    allowedHosts: [],
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: (id) => factory.created.find((session) => session.id === id) ?? null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    getAgentApi: () => wiring,
  });
  const server = http.createServer(app);
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  try {
    await listenOnLoopback(server);
    const base = `http://127.0.0.1:${boundPort(server)}`;
    const post = (verb: string, body: object) => fetch(`${base}/agent/${parent.id}/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${parent.agentToken}` },
      body: JSON.stringify(body),
    });
    const spawned = await post('spawn', { prompt: 'Choose the store', name: 'storage' });
    assert.equal(spawned.status, 200);
    const child = [...agentSessions.values()][0];
    assert.ok(child);
    assert.equal(child.holdClaudePermission({ tool_name: 'Bash', tool_input: { command: 'pwd' } }, new AbortController().signal), null);
    child.transition('first_output');
    child.transition('new_output');
    const questions = [
      { question: 'Which store?', options: [{ label: 'sqlite' }, { label: 'postgres' }] },
      { question: 'Add an index?', options: [{ label: 'yes' }, { label: 'no' }] },
    ];
    const payload = { tool_name: 'AskUserQuestion', tool_input: { questions } };
    const held = child.holdClaudePermission(payload, new AbortController().signal);
    assert.ok(held);
    assert.match(parentWrites.join(''), new RegExp(`glimmervoid read ${child.id}`));
    child.transition('prompt_detected');
    const read = await post('read', { child: child.id });
    assert.equal(read.status, 200);
    const entries = AgentReadReply.parse(await read.json()).channels[0].entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].from, 'glimmervoid');
    assert.equal(entries[0].text, [
      `${child.name} asks:`,
      '1. Which store? [sqlite | postgres]',
      '2. Add an index? [yes | no]',
      `Answer: glimmervoid answer ${child.id} '{"Which store?":"sqlite","Add an index?":"yes"}'`,
      `Or pass it to the operator: glimmervoid answer ${child.id} --operator`,
    ].join('\n'));
    for (const answers of [
      { 'Wrong question': 'sqlite', 'Add an index?': 'yes' },
      { 'Which store?': 'sqlite' },
    ]) {
      const refused = await post('answer', { child: child.id, answers });
      assert.equal(refused.status, 409);
      const refusal = await refused.json();
      assert.match(refusal.error, /Which store\?/);
      assert.match(refusal.error, /Add an index\?/);
      assert.equal(child._conversationApproval?.kind, 'question');
    }
    const stranger = factory.makeSession({ id: 'stranger', name: 'stranger', path: projectPath });
    const unowned = await wiring.handle(stranger, 'answer', { child: child.id, toOperator: true });
    assert.equal(unowned.status, 404);
    process.env[AGENT_URL_ENV] = `${base}/agent/${parent.id}?t=${parent.agentToken}`;
    context.mock.method(console, 'log', () => {});
    const answers = { 'Which store?': 'postgres', 'Add an index?': 'no' };
    assert.equal(await runAgentApiCli(['answer', child.id, JSON.stringify(answers)]), 0);
    assert.deepEqual(await held, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { questions, answers } },
      },
    });
    assert.equal(child._conversationApproval, null);
    child.transition('new_output');
    const handedOff = child.holdClaudePermission(payload, new AbortController().signal);
    assert.ok(handedOff);
    assert.equal(await runAgentApiCli(['answer', child.name, '--operator']), 0);
    assert.equal(await handedOff, null);
    assert.equal(child._conversationApproval, null);
    child.ingestHookSignal({ signal: 'awaiting-input', source: 'hook', ts: Date.now(), promptKind: 'permission', promptToolName: 'AskUserQuestion' });
    assert.equal(child.state, STATES.WAITING);
    const operatorRead = await post('read', { child: child.id });
    const operatorNotes = AgentReadReply.parse(await operatorRead.json()).channels[0].entries;
    assert.ok(operatorNotes.some((entry) => entry.text.includes('its card is flagged for the operator')));
    child.transition('new_output');
    child.transition('prompt_detected');
    assert.equal(child.state, STATES.WAITING);
    const heldAfterWaiting = child.holdClaudePermission(payload, new AbortController().signal);
    assert.ok(heldAfterWaiting);
    const waitingFirstRead = await post('read', { child: child.id });
    const waitingFirstNotes = AgentReadReply.parse(await waitingFirstRead.json()).channels[0].entries;
    assert.deepEqual(waitingFirstNotes.map((entry) => entry.text.split('\n')[0]), [`${child.name} asks:`]);
    assert.equal(await runAgentApiCli(['answer', child.id, '--operator']), 0);
    assert.equal(await heldAfterWaiting, null);
    const tooManyQuestions = [1, 2, 3, 4, 5].map((number) => ({ question: `Question ${number}?`, options: [{ label: 'yes' }, { label: 'no' }] }));
    const heldUnparsed = child.holdClaudePermission({ tool_name: 'AskUserQuestion', tool_input: { questions: tooManyQuestions } }, new AbortController().signal);
    assert.ok(heldUnparsed);
    const unparsedRead = await post('read', { child: child.id });
    const unparsedNote = AgentReadReply.parse(await unparsedRead.json()).channels[0].entries[0].text;
    assert.doesNotMatch(unparsedNote, /Answer:/);
    assert.match(unparsedNote, new RegExp(`glimmervoid answer ${child.id} --operator`));
    const unparsedRefused = await post('answer', { child: child.id, answers: { 'Question 1?': 'yes' } });
    assert.equal(unparsedRefused.status, 409);
    assert.match((await unparsedRefused.json()).error, /toOperator set/);
    assert.equal(await runAgentApiCli(['answer', child.id, '--operator']), 0);
    assert.equal(await heldUnparsed, null);
    assert.equal(parent.holdClaudePermission(payload, new AbortController().signal), null);
    assert.equal(parent.releaseQuestionHold('missing'), false);
  } finally {
    if (previousAgentUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousAgentUrl !== undefined) process.env[AGENT_URL_ENV] = previousAgentUrl;
    for (const session of factory.created) session.destroy();
    server.closeAllConnections();
    await closeServer(server);
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
