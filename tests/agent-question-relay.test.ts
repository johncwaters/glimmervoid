import './helpers/isolate-home.ts';
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
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import { createSpawnGate } from '../server/spawn-gate.ts';
import type { Session } from '../session/sessions.ts';
import { AGENT_URL_ENV, AgentReadReply } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import { capturingPty } from './helpers/fake-pty.ts';
import { recordingSessionFactory } from './helpers/fake-session.ts';
import { createQuestionManager, createQuestionManagerLane } from '../server/question-manager/question-manager.ts';
import type { LaneSpawn } from '../server/lanes/lane-spawn.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';

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

test('the question manager answers a covered question only in a session switched on for it and leaves risky questions to the operator', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-question-manager-'));
  const settings = { rules: [{ name: 'store choice', question: 'store', pick: ['SQLite'] }] };
  const manager = createQuestionManager({ getSettings: () => settings });
  const factory = recordingSessionFactory();
  const session = factory.makeSession({ id: 'managed', name: 'managed', path: projectPath, questionManager: manager.forSession({ projectPath, isOn: true }) });
  const switchedOff = factory.makeSession({ id: 'switched-off', name: 'switched-off', path: projectPath, questionManager: manager.forSession({ projectPath, isOn: false }) });
  const codex = factory.makeSession({ id: 'codex', name: 'codex', path: projectPath, agent: 'codex', questionManager: manager.forSession({ projectPath, isOn: true }) });
  const askPayload = (question: string) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, options: [{ label: 'sqlite' }, { label: 'postgres' }] }] } });
  const questionStatus = (question: string) => ({ signal: 'awaiting-input', source: 'hook' as const, ts: Date.now(), promptKind: 'permission', promptToolName: 'AskUserQuestion', event: 'PermissionRequest', payload: askPayload(question) });
  const answeredEvents: unknown[] = [];
  session.on('manager-decision', (detail) => answeredEvents.push(detail));
  try {
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    session.transition('new_output');
    const runningState = session.state;
    session.ingestHookSignal(questionStatus('Which store?'));
    const answered = await session.holdClaudePermission(askPayload('Which store?'), new AbortController().signal);
    assert.deepEqual(answered?.hookSpecificOutput.decision, {
      behavior: 'allow',
      updatedInput: { questions: askPayload('Which store?').tool_input.questions, answers: { 'Which store?': 'sqlite' } },
    });
    assert.equal(session.state, runningState);
    assert.equal(answeredEvents.length, 1);
    const managerEntries = () => session.auditLog.filter((entry) => entry.kind === 'question-manager');
    assert.deepEqual(managerEntries().map((entry) => [entry.outcome, entry.rule]), [['answered', 'store choice']]);
    session.ingestHookSignal(questionStatus('Delete the sqlite store?'));
    assert.equal(await session.holdClaudePermission(askPayload('Delete the sqlite store?'), new AbortController().signal), null);
    assert.equal(session.state, STATES.WAITING);
    assert.match(String(managerEntries().at(-1)?.reason), /delete/i);
    assert.equal(await switchedOff.holdClaudePermission(askPayload('Which store?'), new AbortController().signal), null);
    const codexAsk = { tool_name: 'request_user_input', tool_input: { questions: [{ header: 'Store', id: 'store', question: 'Which store?', options: [{ label: 'sqlite', description: '' }, { label: 'postgres', description: '' }] }] } };
    codex.transition('user_start');
    codex.transition('spawn_success', { spawnCwdExists: true });
    codex.transition('first_output');
    codex.transition('new_output');
    const codexRunningState = codex.state;
    codex.ingestHookSignal({ signal: 'awaiting-input', source: 'hook', ts: Date.now(), promptKind: 'elicitation', event: 'pretooluse', payload: codexAsk });
    const denied = await codex.holdQuestionTool(codexAsk, new AbortController().signal);
    assert.equal(denied?.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(String(denied?.hookSpecificOutput.permissionDecisionReason), /Which store\?: sqlite/);
    assert.equal(codex.state, codexRunningState);
    assert.equal(session.holdQuestionTool(codexAsk, new AbortController().signal), null);
  } finally {
    for (const created of factory.created) created.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('the operator switches the question manager per session over the control channel, and the switch is saved with the session', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-question-manager-switch-'));
  const settings = { rules: [{ name: 'store choice', question: 'store', pick: ['SQLite'] }] };
  const manager = createQuestionManager({ getSettings: () => settings });
  const factory = recordingSessionFactory();
  const offeredPort = () => manager.forSession({ projectPath, isOn: false });
  const session = factory.makeSession({ id: 'operator', name: 'operator', path: projectPath, questionManager: offeredPort() });
  const lane = factory.makeSession({ id: 'lane', name: 'lane', path: projectPath, ephemeral: true, questionManager: offeredPort() });
  const child = factory.makeSession({ id: 'child', name: 'child', path: projectPath, holdsQuestionsForParent: true, questionManager: offeredPort() });
  const grok = factory.makeSession({ id: 'grok', name: 'grok', path: projectPath, agent: 'grok', questionManager: offeredPort() });
  const config: GlimmervoidConfig = { projects: [{ id: 'operator', name: 'operator', path: projectPath }, { id: 'lane', name: 'lane', path: projectPath }] };
  const statusFrames: Record<string, unknown>[] = [];
  createSessionEventWiring({
    configStore: { save: (mutate) => { mutate(config); return config; } }, config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: (message) => { if (message.type === 'session-status') statusFrames.push(message); },
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  const connection = connectControl<{ type: string; message?: string }>(createControlServer(controlDeps(config, { sessions: new Map(factory.created.map((created) => [created.id, created])) })));
  const askPayload = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which store?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }] } };
  const answerOf = async () => (await session.holdClaudePermission(askPayload, new AbortController().signal))?.hookSpecificOutput.decision.behavior ?? null;
  try {
    session.transition('user_start');
    session.transition('spawn_success', { spawnCwdExists: true });
    session.transition('first_output');
    session.transition('new_output');
    assert.equal(session.isQuestionManagerOn, false);
    assert.equal(await answerOf(), null);
    connection.send({ type: 'set-session-question-manager', id: 'operator', isOn: true });
    assert.equal(session.isQuestionManagerOn, true);
    assert.equal(config.projects[0].questionManagerOn, true);
    assert.equal(await answerOf(), 'allow');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusFrames.at(-1)?.isQuestionManagerOn, true);
    connection.send({ type: 'set-session-question-manager', id: 'operator', isOn: false });
    assert.equal('questionManagerOn' in config.projects[0], false);
    assert.equal(await answerOf(), null);
    for (const unoffered of [lane, child, grok]) {
      assert.equal(unoffered.isQuestionManagerOn, null);
      connection.send({ type: 'set-session-question-manager', id: unoffered.id, isOn: true });
      assert.equal(connection.sent.at(-1)?.type, 'error');
      assert.equal(unoffered.isQuestionManagerOn, null);
    }
    assert.equal('questionManagerOn' in config.projects[1], false);
  } finally {
    for (const created of factory.created) created.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('the manager lane answers from a plain-language rule only with exact labels and yields to the operator', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-question-manager-lane-'));
  const settings = { rules: [{ name: 'readme length', question: 'README', pick: ['short'] }, 'Prefer the database the project already runs.'] };
  const laneResults: unknown[] = [
    { rule: 1, answers: [{ question: 'question-1', labels: ['POSTGRES'] }] },
    { rule: 1, answers: [{ question: 'question-1', labels: ['whichever is faster'] }] },
    { rule: 1, answers: [{ question: 'question-1', labels: ['sqlite'] }, { question: 'question-2', labels: ['long'] }] },
  ];
  const laneQuestionTexts: string[] = [];
  const spawnLane: LaneSpawn = async ({ cwd, signal }) => {
    laneQuestionTexts.push(fs.readFileSync(path.join(cwd, 'untrusted.json'), 'utf8'));
    const laneResult = laneResults.shift();
    if (laneResult === undefined) {
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
      return;
    }
    fs.writeFileSync(path.join(cwd, 'manager-result.json'), JSON.stringify(laneResult));
  };
  const managerLane = createQuestionManagerLane(spawnLane);
  const manager = createQuestionManager({ getSettings: () => settings, getLane: () => managerLane });
  const factory = recordingSessionFactory();
  const session = factory.makeSession({ id: 'lane-managed', name: 'lane-managed', path: projectPath, questionManager: manager.forSession({ projectPath, isOn: true }) });
  const askPayload = (question: string) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question, options: [{ label: 'sqlite' }, { label: 'postgres' }] }] } });
  const managerEntries = () => session.auditLog.filter((entry) => entry.kind === 'question-manager');
  try {
    const answered = await session.holdClaudePermission(askPayload('Which store?'), new AbortController().signal);
    assert.deepEqual(answered?.hookSpecificOutput.decision, {
      behavior: 'allow',
      updatedInput: { questions: askPayload('Which store?').tool_input.questions, answers: { 'Which store?': 'postgres' } },
    });
    assert.match(laneQuestionTexts[0] ?? '', /Which store\?/);
    assert.deepEqual(managerEntries().map((entry) => [entry.outcome, entry.by]), [['answered', 'manager']]);
    assert.match(String(managerEntries()[0]?.rule), /^rule 1: Prefer the database/);
    assert.equal(await session.holdClaudePermission(askPayload('Which cache?'), new AbortController().signal), null);
    assert.match(String(managerEntries().at(-1)?.reason), /exact option labels/);
    const readmeQuestion = { question: 'How long should the README be?', options: [{ label: 'short' }, { label: 'long' }] };
    const mixedAsk = { tool_name: 'AskUserQuestion', tool_input: { questions: [readmeQuestion, ...askPayload('Which store?').tool_input.questions] } };
    const mixed = await session.holdClaudePermission(mixedAsk, new AbortController().signal);
    assert.deepEqual(mixed?.hookSpecificOutput.decision, {
      behavior: 'allow',
      updatedInput: { questions: mixedAsk.tool_input.questions, answers: { 'How long should the README be?': 'short', 'Which store?': 'sqlite' } },
    });
    assert.doesNotMatch(laneQuestionTexts[2] ?? '', /README/);
    const heldUntilTyping = session.holdClaudePermission(askPayload('Which queue?'), new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));
    session.noteOperatorInput('a');
    assert.equal(await heldUntilTyping, null);
    assert.match(String(managerEntries().at(-1)?.reason), /typed/);
    const heldUntilPaste = session.holdClaudePermission(askPayload('Which broker?'), new AbortController().signal);
    await new Promise((resolve) => setImmediate(resolve));
    session.noteOperatorDraft();
    assert.equal(await heldUntilPaste, null);
  } finally {
    for (const created of factory.created) created.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
