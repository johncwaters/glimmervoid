import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Session } from '../session/sessions.ts';
import { createCustomAdapter } from '../session/adapters/custom.ts';
import { HookRouter } from '../detection/hook-source.ts';
import { createSessionEventWiring } from '../server/session/session-event-wiring.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';
import { capturingPty, exitablePty } from './helpers/fake-pty.ts';
import { permissionRequestDecisionOf } from './helpers/permission-reply.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

const QUESTION_REQUEST = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which store?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }] },
};

const ATTACHED_FILE = '2026-11-18T10-00-00-000Z-0a1b2c3d.png';
const SECOND_ATTACHED_FILE = '2026-11-18T10-00-01-000Z-0a1b2c3e.png';

test('Chat reads a held question from the session status and answers it and sends prompts over the control channel', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-chat-'));
  const writes: string[] = [];
  const session = new Session({ id: 'chatty', name: 'chatty', path: projectPath, holdsQuestionsForParent: true, chatUploadsDirectory: projectPath, ptySpawn: () => capturingPty(writes) });
  const sentAttachments: string[][] = [];
  session.on('chat-attachments-sent', (sent: { files: string[] }) => sentAttachments.push(sent.files));
  const config: GlimmervoidConfig = { projects: [] };
  const approvalFrames: unknown[] = [];
  const outboxFrames: string[][] = [];
  createSessionEventWiring({
    configStore: { save: (mutate) => { mutate(config); return config; } }, config, recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: (message) => {
      if (message.type !== 'session-status') return;
      if ('conversationApproval' in message) approvalFrames.push(message.conversationApproval);
      if ('chatOutbox' in message && Array.isArray(message.chatOutbox)) outboxFrames.push(message.chatOutbox.map((entry: { text: string; state: string }) => `${entry.text}:${entry.state}`));
    },
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {}, noteOperatorActivity: () => {} },
    attachSessionPrLink: () => {}, closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  const connection = connectControl<{ type: string; message?: string; ok?: boolean; error?: string }>(createControlServer(controlDeps(config, { sessions: new Map([[session.id, session]]) })));
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

    const heldToDismiss = session.holdConversationPermission(QUESTION_REQUEST, new AbortController().signal);
    assert.ok(heldToDismiss);
    const dismissedRequestId = session.toSnapshot().conversationApproval?.requestId;
    session.transition('prompt_detected');
    assert.equal(session.state, 'WAITING');
    const errorsBeforeAllow = connection.sent.filter((sent) => sent.type === 'error').length;
    connection.send({ type: 'decide-approval', id: session.id, requestId: dismissedRequestId, decision: 'allow' });
    assert.equal(connection.sent.filter((sent) => sent.type === 'error').length, errorsBeforeAllow + 1);
    connection.send({ type: 'decide-approval', id: session.id, requestId: dismissedRequestId, decision: 'deny' });
    const dismissal = permissionRequestDecisionOf(await heldToDismiss);
    assert.equal(dismissal?.behavior, 'deny');
    assert.equal(dismissal?.interrupt, true);
    await once(session, 'state-change');
    assert.equal(session.state, 'COMPLETE');
    session.transition('new_output');
    assert.equal(session.toSnapshot().conversationApproval, null);

    const outboxOf = () => session.toSnapshot().chatOutbox.map((entry) => `${entry.text}:${entry.state}`);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
    const writesBeforeHeldSend = writes.length;
    connection.send({ type: 'chat-send', id: session.id, text: 'Mid-turn thought', attachments: [ATTACHED_FILE] });
    assert.equal(connection.sent.at(-1)?.ok, true);
    connection.send({ type: 'chat-send', id: session.id, text: 'Second thought', attachments: [SECOND_ATTACHED_FILE] });
    assert.deepEqual(outboxOf(), ['Mid-turn thought:held', 'Second thought:held']);
    assert.equal(writes.length, writesBeforeHeldSend);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(outboxFrames.at(-1), outboxOf());

    connection.send({ type: 'chat-cancel', id: session.id, entryId: session.toSnapshot().chatOutbox[1]?.entryId, requestId: 'cancel-second' });
    assert.deepEqual((connection.sent.at(-1) as { cancelledTexts?: string[] }).cancelledTexts, ['Second thought']);
    assert.deepEqual((connection.sent.at(-1) as { cancelledAttachments?: string[] }).cancelledAttachments, [SECOND_ATTACHED_FILE]);

    session.transition('task_complete');
    await settle();
    assert.ok(writes.join('').includes(`${path.join(projectPath, ATTACHED_FILE)} Mid-turn thought`));
    assert.deepEqual(sentAttachments, [[ATTACHED_FILE]]);
    assert.doesNotMatch(writes.join(''), /Second thought/);
    assert.equal(writes.at(-1), '\r');
    assert.deepEqual(outboxOf(), ['Mid-turn thought:submitted']);
    session.noteChatPromptRecorded();
    assert.deepEqual(outboxOf(), []);
    session.transition('new_output');
    session.transition('task_complete');

    connection.send({ type: 'chat-send', id: session.id, text: 'Typed over' });
    session.noteOperatorInput('x');
    await settle();
    assert.match(session.toSnapshot().chatOutbox[0]?.failure ?? '', /typed in the terminal/);
    connection.send({ type: 'chat-send', id: session.id, text: 'Waits behind the failure' });
    await settle();
    assert.deepEqual(outboxOf(), ['Typed over:failed', 'Waits behind the failure:held']);
    connection.send({ type: 'chat-cancel', id: session.id, entryId: session.toSnapshot().chatOutbox[0]?.entryId, requestId: 'cancel-failed' });
    assert.deepEqual((connection.sent.at(-1) as { cancelledTexts?: string[] }).cancelledTexts, ['Typed over', 'Waits behind the failure']);

    connection.send({ type: 'chat-send', id: session.id, text: 'Lands in a held input box' });
    await settle();
    assert.equal(session.toSnapshot().chatOutbox[0]?.state, 'failed');
    assert.match(session.toSnapshot().chatOutbox[0]?.failure ?? '', /input box/);

    session.cancelChatMessage(session.toSnapshot().chatOutbox[0]?.entryId ?? '');
    session.transition('new_output');
    connection.send({ type: 'chat-send', id: session.id, text: 'Held while snoozed' });
    session.setResumeConversation('0f0e0d0c-0b0a-4908-8706-050403020100');
    assert.equal(session.snooze().ok, true);
    await settle();
    assert.equal(session.state, 'DORMANT');
    assert.deepEqual(outboxOf(), ['Held while snoozed:held']);
    const replacement = new Session({ id: 'chatty', name: 'chatty', path: projectPath, ptySpawn: () => capturingPty([]) });
    replacement.adoptChatOutbox(session.chatOutboxEntries);
    assert.deepEqual(replacement.toSnapshot().chatOutbox.map((entry) => entry.text), ['Held while snoozed']);
    replacement.destroy();

    connection.send({ type: 'chat-send', id: 'gone-session', text: 'Hello?', requestId: 'send-gone' });
    const refused = connection.sent.at(-1);
    assert.equal(refused?.type, 'chat-send-result');
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /no longer exists/);
  } finally {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('Chat switches the model between turns, keeping the conversation and the session instructions, and refuses mid-turn or for another agent', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-model-'));
  const writes: string[] = [];
  const session = new Session({ id: 'modeled', name: 'modeled', path: projectPath, ptySpawn: () => capturingPty(writes) });
  const config: GlimmervoidConfig = { projects: [{ id: 'modeled', name: 'modeled', path: projectPath, agentSetup: { agent: 'claude-code', model: 'sonnet', options: [], instructions: 'Keep diffs small' } }] };
  const reloads: GlimmervoidConfig[] = [];
  const connection = connectControl<{ type: string; ok?: boolean; error?: string }>(createControlServer(controlDeps(config, {
    sessions: new Map([[session.id, session]]),
    applyConfigReload: (freshConfig) => { reloads.push(structuredClone(freshConfig)); },
  })));
  const switchTo = async (setup: unknown) => {
    connection.send({ type: 'switch-session-model', id: session.id, requestId: `switch-${reloads.length}`, setup });
    await new Promise((resolve) => setImmediate(resolve));
    return connection.sent.at(-1);
  };
  try {
    await session.start();
    session.setResumeConversation('0f0e0d0c-0b0a-4908-8706-050403020100');
    session.transition('first_output');
    session.transition('new_output');
    const midTurn = await switchTo({ agent: 'claude-code', model: 'opus', options: [] });
    assert.equal(midTurn?.ok, false);
    assert.match(midTurn?.error ?? '', /mid-turn/);

    const writesBeforeHeldSend = writes.length;
    connection.send({ type: 'chat-send', id: session.id, text: 'Mid-turn thought' });
    assert.equal(connection.sent.at(-1)?.ok, true);
    assert.equal(writes.length, writesBeforeHeldSend);

    session.transition('task_complete');
    const promptInFlight = await switchTo({ agent: 'claude-code', model: 'opus', options: [] });
    assert.equal(promptInFlight?.ok, false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(writes.at(-1), '\r');
    session.transition('new_output');
    session.transition('task_complete');

    const otherAgent = await switchTo({ agent: 'codex', model: 'gpt-5', options: [] });
    assert.equal(otherAgent?.ok, false);
    assert.equal(reloads.length, 0);

    const switched = await switchTo({ agent: 'claude-code', model: 'opus', options: [] });
    assert.equal(switched?.type, 'switch-session-model-result');
    assert.equal(switched?.ok, true);
    const saved = reloads.at(-1)?.projects[0];
    assert.deepEqual(saved?.agentSetup, { agent: 'claude-code', model: 'opus', options: [], instructions: 'Keep diffs small' });
    assert.equal(saved?.resumeSessionId, '0f0e0d0c-0b0a-4908-8706-050403020100');
  } finally {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('a Chat message waits for the Claude startup hook instead of typing into a startup screen, clears when a turn starts for it, and fails a message no turn takes while holding the next', async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-chat-ready-by-hook-'));
  const writes: string[] = [];
  const session = new Session({ id: 'booting', name: 'booting', path: projectPath, hookRouter: new HookRouter(), getHookPort: () => 41234, ptySpawn: () => capturingPty(writes) });
  t.after(() => {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  await session.start();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const outboxOf = () => session.toSnapshot().chatOutbox.map((entry) => `${entry.text}:${entry.state}`);
  const advance = async (waitMs: number) => {
    for (let elapsedMs = 0; elapsedMs < waitMs; elapsedMs += 250) {
      t.mock.timers.tick(250);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  session._handlePtyData('Quick safety check: do you trust this folder?');
  assert.equal(session.state, 'STARTING');
  session.queueChatMessage('Sent while the dialog is up');
  await advance(45_000);
  assert.equal(session.state, 'IDLE');
  assert.equal(writes.join('').includes('Sent while the dialog is up'), false);
  assert.deepEqual(outboxOf(), ['Sent while the dialog is up:held']);

  session.ingestHookSignal({ event: 'SessionStart', signal: 'session-start', source: 'hook', ts: 1, payload: { source: 'startup' } });
  await advance(1_000);
  assert.ok(writes.join('').includes('Sent while the dialog is up'));
  assert.deepEqual(outboxOf(), ['Sent while the dialog is up:submitted']);
  await advance(10_000);
  session.transition('new_output');
  assert.deepEqual(outboxOf(), []);
  session.transition('task_complete');
  session.transition('user_dismiss');

  writes.length = 0;
  session.queueChatMessage('Eaten by a mid-session dialog');
  session.queueChatMessage('Sent behind the eaten one');
  await advance(1_000);
  const replacement = new Session({ id: 'recreated', name: 'recreated', path: projectPath, ptySpawn: () => capturingPty([]) });
  t.after(() => replacement.destroy());
  replacement.adoptChatOutbox(session.chatOutboxEntries);
  assert.deepEqual(replacement.toSnapshot().chatOutbox.map((entry) => `${entry.text}:${entry.state}`), ['Eaten by a mid-session dialog:failed', 'Sent behind the eaten one:held']);
  await advance(19_000);
  assert.deepEqual(outboxOf(), ['Eaten by a mid-session dialog:failed', 'Sent behind the eaten one:held']);
  assert.equal(writes.join('').includes('Sent behind the eaten one'), false);
  const [notTaken] = session.toSnapshot().chatOutbox;
  assert.deepEqual(session.cancelChatMessage(notTaken.entryId).map((entry) => entry.text), ['Eaten by a mid-session dialog', 'Sent behind the eaten one']);

  session.queueChatMessage('Sent before a child report');
  await advance(1_000);
  session.deliver('Child report', { when: 'ready', submit: true });
  await advance(1_000);
  session.transition('new_output');
  assert.deepEqual(outboxOf(), []);
});

test('a Claude session whose startup hook never arrives becomes ready at the degraded-detection deadline', async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-chat-hook-deadline-'));
  const session = new Session({ id: 'hookless', name: 'hookless', path: projectPath, hookRouter: new HookRouter(), getHookPort: () => 41234, ptySpawn: () => capturingPty([]) });
  t.after(() => {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  await session.start();
  t.mock.timers.tick(31_000);
  session._handlePtyData('Claude Code');
  t.mock.timers.tick(29_000);
  assert.equal(session.state, 'STARTING');
  t.mock.timers.tick(1_000);
  assert.equal(session.state, 'IDLE');
});

test('a Claude session that exits cleanly from a startup dialog ends done instead of staying starting', async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-chat-dialog-exit-'));
  const pty = exitablePty();
  const session = new Session({ id: 'declined', name: 'declined', path: projectPath, hookRouter: new HookRouter(), getHookPort: () => 41234, ptySpawn: () => pty });
  t.after(() => {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  await session.start();
  session._handlePtyData('Quick safety check: do you trust this folder?');
  pty.fireExit(0);
  assert.equal(session.state, 'DONE');
});

test('a Chat message to an agent with no turn signal clears after the wait instead of turning failed', async (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-chat-no-signal-'));
  const adapter = createCustomAdapter({ id: 'aider', label: 'Aider', command: 'aider', args: [] });
  const session = new Session({ id: 'silent', name: 'silent', path: projectPath, adapter, ptySpawn: () => capturingPty([]) });
  t.after(() => {
    session.destroy();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });
  await session.start();
  session.transition('first_output');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

  session.queueChatMessage('Answered with no hooks');
  for (let elapsedMs = 0; elapsedMs < 17_000; elapsedMs += 250) {
    t.mock.timers.tick(250);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(session.toSnapshot().chatOutbox, []);
});
