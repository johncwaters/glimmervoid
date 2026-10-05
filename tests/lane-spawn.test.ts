import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLaneSpawn } from '../server/lane-spawn.ts';
import { THREAD_JUDGE_TOOLS } from '../server/team-review-thread-judge.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';

async function spawnedOptions(allowTools: readonly string[] | undefined, hasHookRouter: boolean): Promise<SessionOptions> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-lane-spawn-test-'));
  const captured: SessionOptions[] = [];
  const controller = new AbortController();
  controller.abort();
  try {
    const spawnLane = createLaneSpawn({
      laneName: 'lane-spawn-test',
      hookRouter: hasHookRouter ? { register: () => {}, unregister: () => {} } : null,
      ...(allowTools ? { allowTools } : {}),
      createSession: (options) => {
        captured.push(options);
        return new Session(options);
      },
    });
    await spawnLane({ id: `lane-spawn-test-${captured.length}`, name: 'Lane spawn test', prompt: 'Synthetic prompt', cwd, model: 'sonnet', signal: controller.signal });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
  assert.equal(captured.length, 1);
  return captured[0];
}

function toolsArgument(options: SessionOptions): string | undefined {
  const args = options.extraClaudeArgs ?? [];
  const index = args.indexOf('--tools');
  return index === -1 ? undefined : args[index + 1];
}

test('the thread judge allow list reaches the spawned session as --tools Read,Write with and without a hook router', async () => {
  for (const hasHookRouter of [true, false]) {
    const options = await spawnedOptions(THREAD_JUDGE_TOOLS, hasHookRouter);
    assert.equal(toolsArgument(options), 'Read,Write', `hookRouter: ${hasHookRouter}`);
    assert.equal((options.extraClaudeArgs ?? []).includes('--settings'), !hasHookRouter);
  }
});

test('a lane spawned without an allow list emits no --tools argument', async () => {
  for (const hasHookRouter of [true, false]) {
    const options = await spawnedOptions(undefined, hasHookRouter);
    assert.equal(toolsArgument(options), undefined, `hookRouter: ${hasHookRouter}`);
  }
});

test('standalone settings exist before start and are removed after exit, start failure, construction failure or abort', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-lane-settings-test-'));
  try {
    for (const outcome of ['exit', 'start-failure', 'construction-failure', 'abort', 'already-aborted']) {
      let settingsPath = '';
      let hasStarted = false;
      const controller = new AbortController();
      if (outcome === 'already-aborted') controller.abort();
      const spawnLane = createLaneSpawn({
        laneName: 'lane-settings-test',
        allowTools: THREAD_JUDGE_TOOLS,
        createSession: (options) => {
          const args = options.extraClaudeArgs ?? [];
          settingsPath = args[args.indexOf('--settings') + 1];
          if (outcome === 'construction-failure') throw new Error('synthetic construction failure');
          const session = new Session(options);
          session.start = async () => {
            hasStarted = true;
            assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { permissions: options.settingsPermissions });
            if (outcome === 'start-failure') throw new Error('synthetic start failure');
            if (outcome === 'abort') return controller.abort();
            session.emit('exit');
          };
          return session;
        },
      });
      const spawned = spawnLane({ id: `lane-settings-test-${outcome}`, name: 'Lane settings test', prompt: 'Synthetic prompt', cwd, signal: controller.signal });
      const shouldFail = outcome === 'start-failure' || outcome === 'construction-failure';
      if (shouldFail) await assert.rejects(spawned, /synthetic (start|construction) failure/);
      if (!shouldFail) await spawned;
      assert.ok(settingsPath);
      assert.equal(hasStarted, outcome !== 'already-aborted' && outcome !== 'construction-failure');
      await assert.rejects(fs.stat(path.dirname(settingsPath)), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a failed standalone settings write removes its directory without constructing a session', async (context) => {
  let settingsPath = '';
  let hasConstructedSession = false;
  context.mock.method(fs, 'writeFile', async (filePath: string) => {
    settingsPath = filePath;
    throw new Error('synthetic settings write failure');
  });
  const spawnLane = createLaneSpawn({
    laneName: 'lane-settings-write-test',
    createSession: (options) => {
      hasConstructedSession = true;
      return new Session(options);
    },
  });
  await assert.rejects(spawnLane({ id: 'lane-settings-write-test', name: 'Lane settings test', prompt: 'Synthetic prompt', cwd: os.tmpdir() }), /synthetic settings write failure/);
  assert.equal(hasConstructedSession, false);
  assert.ok(settingsPath);
  await assert.rejects(fs.stat(path.dirname(settingsPath)), { code: 'ENOENT' });
});
