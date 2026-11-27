import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from '../server/git/git-exec.ts';

function waitForFile(filePath: string, commandRun: Promise<unknown>): Promise<void> {
  if (fs.existsSync(filePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filePath);
    const targetName = path.basename(filePath);
    let isSettled = false;
    const finish = (error?: Error) => {
      if (isSettled) return;
      isSettled = true;
      watcher.close();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const watcher = fs.watch(dir, (_event, changedName) => {
      if (changedName !== null && String(changedName) !== targetName) return;
      if (fs.existsSync(filePath)) finish();
    });
    watcher.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    void commandRun.then(() => finish(new Error(`command exited before publishing ${filePath}`)));
    if (fs.existsSync(filePath)) finish();
  });
}

test('a command that ignores SIGTERM is killed soon after its timeout', { skip: process.platform === 'win32' }, async () => {
  const startedAt = performance.now();

  const result = await runCommand(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { timeoutMs: 300 });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - startedAt < 5_000);
});

test('an aborted command that ignores SIGTERM has exited by the time runCommand returns', { skip: process.platform === 'win32' }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-run-command-'));
  const pidFile = path.join(tempDir, 'child.pid');
  const pidTempFile = `${pidFile}.tmp`;
  const sessionClosed = new AbortController();
  const readyChild = [
    "process.on('SIGTERM', () => {});",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidTempFile)}, String(process.pid));`,
    `fs.renameSync(${JSON.stringify(pidTempFile)}, ${JSON.stringify(pidFile)});`,
    'setInterval(() => {}, 1000);',
  ].join(' ');
  try {
    const commandRun = runCommand(process.execPath, ['-e', readyChild], { timeoutMs: 60_000, signal: sessionClosed.signal });
    await waitForFile(pidFile, commandRun);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    sessionClosed.abort();

    const result = await commandRun;

    assert.equal(result.ok, false);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    sessionClosed.abort();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
