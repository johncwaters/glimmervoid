import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../server/git/git-exec.ts';

test('a command that ignores SIGTERM is killed soon after its timeout', { skip: process.platform === 'win32' }, async () => {
  const startedAt = performance.now();

  const result = await runCommand(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - startedAt < 5_000);
});
