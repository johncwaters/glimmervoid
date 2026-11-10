import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from '../server/git/git-exec.ts';

const PID_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-run-command-')), 'child.pid');

test('a command that ignores SIGTERM is killed soon after its timeout', { skip: process.platform === 'win32' }, async () => {
  const startedAt = performance.now();

  const result = await runCommand(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - startedAt < 5_000);
});

test('an aborted command that ignores SIGTERM has exited by the time runCommand returns', { skip: process.platform === 'win32' }, async () => {
  const sessionClosed = new AbortController();
  const stubbornChild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  setTimeout(() => sessionClosed.abort(), 300);

  const result = await runCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(PID_FILE)}, String(process.pid)); ${stubbornChild}`], { timeoutMs: 60_000, signal: sessionClosed.signal });
  const childPid = Number(fs.readFileSync(PID_FILE, 'utf8'));

  assert.equal(result.ok, false);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});
