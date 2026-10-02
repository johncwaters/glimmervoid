import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Session } from '../session/sessions.ts';
import { readTranscriptTaskTitle } from '../session/session-task-title.ts';
import { STATES } from '../shared/states.ts';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';
import { ProjectConfig } from '../shared/contracts/config.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';

test('transcript titles read a bounded tail and tolerate absent files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-title-'));
  try {
    const transcriptPath = path.join(directory, 'transcript.jsonl');
    await writeFile(transcriptPath, `${'x'.repeat(70000)}\n{"type":"ai-title","aiTitle":"Newest task"}\n`);
    assert.equal(await readTranscriptTaskTitle(transcriptPath), 'Newest task');
    assert.equal(await readTranscriptTaskTitle(path.join(directory, 'absent')), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session titles preserve the first prompt, deduplicate changes, and restore the latest automatic title', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project', agent: 'grok' });
  try {
    const changes: unknown[] = [];
    session.on('task-title-change', (title) => changes.push(title));
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'First task' } });
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 2, payload: { prompt: 'Later prompt' } });
    assert.equal(session.taskTitle, 'First task');
    session._titleSource.feed('\x1b]0;Run touch for grok-probe-approval.txt - grok\x07');
    assert.equal(session.taskTitle, 'Run touch for grok-probe-approval.txt');
    session.setCustomTitle('Custom');
    session.setCustomTitle('Custom');
    session._titleSource.feed('\x1b]0;Next task - grok\x07');
    assert.equal(changes.length, 3);
    session.setCustomTitle(null);
    assert.equal(session.taskTitle, 'Next task');
    assert.equal(session.taskTitleIsCustom, false);
    assert.equal(session.toSnapshot().taskTitle, 'Next task');
    assert.equal(changes.length, 4);
  } finally {
    session.destroy();
  }
});

test('Claude turn completion reads ai titles independently of the trace lane and ignores OSC task text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-title-hook-'));
  const session = new Session({ id: 's1', name: 'project', path: directory, customTitle: 'Custom' });
  try {
    const transcriptPath = path.join(directory, 'transcript.jsonl');
    await writeFile(transcriptPath, '{"type":"ai-title","aiTitle":"Claude task"}\n');
    session._transcriptPath = transcriptPath;
    session._titleSource.feed('\x1b]0;Wrong OSC task\x07');
    session.state = STATES.RUNNING;
    session.transition('task_complete');
    await session._refreshTranscriptTaskTitle();
    const changed = once(session, 'task-title-change');
    session.setCustomTitle(null);
    assert.deepEqual((await changed)[0], { taskTitle: 'Claude task', isCustom: false });
  } finally {
    session.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test('task title contracts trim, allow clearing, and reject length and control characters', () => {
  assert.equal(ClientMessage.parse({ type: 'set-session-title', id: 's1', title: ' Task ' }).title, 'Task');
  assert.equal(ClientMessage.safeParse({ type: 'set-session-title', id: 's1', title: '' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'session-title', id: 's1', taskTitle: null, isCustom: false }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'session-title', id: 's1', taskTitle: 'Task', isCustom: true }).success, true);
  assert.equal(ProjectConfig.parse({ path: '/repo', customTitle: ' Task ' }).customTitle, 'Task');
  for (const title of ['a'.repeat(121), 'Task\n', '\x00Task', '\x7fTask', '\x85Task']) {
    assert.equal(ClientMessage.safeParse({ type: 'set-session-title', id: 's1', title }).success, false);
    assert.equal(ProjectConfig.safeParse({ path: '/repo', customTitle: title }).success, false);
  }
});

test('custom title control saves and clears without replacing the session and refuses ephemeral sessions', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project' });
  try {
    const config: GlimmervoidConfig = { projects: [{ id: 's1', name: 'project', path: '/project' }] };
    const sessions = new Map([['s1', session]]);
    const server = createControlServer(controlDeps(config, {
      sessions,
      applyConfigReload: (fresh) => session.setCustomTitle(fresh.projects[0].customTitle ?? null),
    }));
    const connection = connectControl<{ type: string; message?: string }>(server);
    connection.send({ type: 'set-session-title', id: 's1', title: 'Custom' });
    assert.equal(config.projects[0].customTitle, 'Custom');
    assert.equal(session.taskTitle, 'Custom');
    assert.equal(sessions.get('s1'), session);
    connection.send({ type: 'set-session-title', id: 's1', title: '' });
    assert.equal(config.projects[0].customTitle, undefined);
    assert.equal(session.taskTitle, null);
    session.ephemeral = true;
    connection.send({ type: 'set-session-title', id: 's1', title: 'Rejected' });
    assert.equal(config.projects[0].customTitle, undefined);
    assert.equal(connection.sent.at(-1)?.type, 'error');
  } finally {
    session.destroy();
  }
});

test('a fresh restart drops automatic titles from the previous conversation and keeps the custom title', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project', agent: 'grok' });
  try {
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'Old task' } });
    session._titleSource.feed('\x1b]0;Old OSC task - grok\x07');
    session._taskTitleSources.aiTitle = 'Old AI task';
    session._updateTaskTitle();
    session._prepareRestart({ fresh: false });
    assert.equal(session.taskTitle, 'Old AI task');
    session._prepareRestart({ fresh: true });
    assert.equal(session.taskTitle, null);
    session.setCustomTitle('Custom');
    session._prepareRestart({ fresh: true });
    assert.deepEqual({ taskTitle: session.taskTitle, isCustom: session.taskTitleIsCustom }, { taskTitle: 'Custom', isCustom: true });
  } finally {
    session.destroy();
  }
});

test('Claude /clear drops automatic titles so the next prompt titles the new conversation, while compact keeps them', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project' });
  try {
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'Old task' } });
    session._taskTitleSources.aiTitle = 'Old AI task';
    session._updateTaskTitle();
    session.ingestHookSignal({ event: 'SessionStart', signal: 'session-start', source: 'hook', ts: 2, payload: { source: 'compact' } });
    assert.equal(session.taskTitle, 'Old AI task');
    session.ingestHookSignal({ event: 'SessionStart', signal: 'session-start', source: 'hook', ts: 3, payload: { source: 'clear' } });
    assert.equal(session.taskTitle, null);
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 4, payload: { prompt: 'New task' } });
    assert.equal(session.taskTitle, 'New task');
  } finally {
    session.destroy();
  }
});
