import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import type { GlimmervoidConfig } from '../server/config-store.ts';

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

test('a fresh Claude restart never rereads the previous conversation transcript title', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-title-fresh-'));
  const session = new Session({ id: 's1', name: 'project', path: directory });
  try {
    const previousTranscriptPath = path.join(directory, 'previous.jsonl');
    await writeFile(previousTranscriptPath, '{"type":"ai-title","aiTitle":"Previous conversation task"}\n');
    session._transcriptPath = previousTranscriptPath;
    await session._refreshTranscriptTaskTitle();
    assert.equal(session.taskTitle, 'Previous conversation task');
    session._prepareRestart({ fresh: true });
    await session._refreshTranscriptTaskTitle();
    assert.equal(session.taskTitle, null);
  } finally {
    session.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sessions retain and emit only the last five cleaned substantive prompts from the lowercased hook route event', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project' });
  try {
    const emittedPrompts: string[] = [];
    session.on('task-prompt', ({ prompt }: { prompt: string }) => emittedPrompts.push(prompt));
    for (let index = 0; index < 7; index++) {
      session.ingestHookSignal({ event: 'userpromptsubmit', signal: 'resume', source: 'hook', ts: index, payload: { prompt: `<pasted_content id="x">Hidden</pasted_content> Implement task number ${index}` } });
    }
    session.ingestHookSignal({ event: 'userpromptsubmit', signal: 'resume', source: 'hook', ts: 8, payload: { prompt: 'yes please continue' } });
    assert.equal(emittedPrompts.length, 7);
    assert.deepEqual(session.recentTaskPrompts, emittedPrompts.slice(-5));
    assert.equal(session.taskTitle, 'Implement task number 0');
    assert.equal(session.taskTitlePromptRevision, 7);
  } finally {
    session.destroy();
  }
});

test('a later prompt never replaces the settled title, and keep, replace and invalid refinements settle it', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project', initialPrompt: 'First task prompt' });
  try {
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'Latest substantive task prompt' } });
    assert.equal(session.taskTitle, 'First task prompt');
    session.applyTaskTitleRefinement({ action: 'keep' });
    assert.equal(session.taskTitle, 'First task prompt');
    session.applyTaskTitleRefinement({ action: 'replace', title: 'Refined task title' });
    assert.equal(session.taskTitle, 'Refined task title');
    session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 2, payload: { prompt: 'Another substantive task prompt' } });
    assert.equal(session.taskTitle, 'Refined task title');
    session.applyTaskTitleRefinement({ action: 'invalid' });
    assert.equal(session.taskTitle, 'Refined task title');
    session.setCustomTitle('Custom');
    session.applyTaskTitleRefinement({ action: 'replace', title: 'New refined title' });
    assert.equal(session.taskTitle, 'Custom');
    session.setCustomTitle(null);
    assert.equal(session.taskTitle, 'New refined title');
  } finally {
    session.destroy();
  }
});

for (const reset of ['clear', 'fresh'] as const) {
  test(`${reset} resets prompt history and refined titles while preserving custom titles`, () => {
    const session = new Session({ id: 's1', name: 'project', path: '/project' });
    try {
      session.ingestHookSignal({ event: 'UserPromptSubmit', signal: 'resume', source: 'hook', ts: 1, payload: { prompt: 'Old substantive task prompt' } });
      session.applyTaskTitleRefinement({ action: 'replace', title: 'Old refined title' });
      session.setCustomTitle('Custom');
      const priorRevision = session.taskTitlePromptRevision;
      if (reset === 'clear') session.ingestHookSignal({ event: 'SessionStart', signal: 'session-start', source: 'hook', ts: 2, payload: { source: 'clear' } });
      if (reset === 'fresh') session._prepareRestart({ fresh: true });
      assert.deepEqual(session.recentTaskPrompts, []);
      assert.ok(session.taskTitlePromptRevision > priorRevision);
      assert.equal(session.taskTitle, 'Custom');
      session.setCustomTitle(null);
      assert.equal(session.taskTitle, null);
    } finally {
      session.destroy();
    }
  });
}
