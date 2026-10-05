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
