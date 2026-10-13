import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRerereWatcher, RR_CACHE_DIR } from '../detection/rerere-watch.ts';
import { decideRerereCooldownClear } from '../session/core/rebase-gate.ts';
import { waitForFsWatchToArm } from './helpers/wait-for.ts';

function tempGitDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-rerere-'));
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function recordConflict(cacheDir: string, entry: string) {
  fs.mkdirSync(path.join(cacheDir, entry));
  fs.writeFileSync(path.join(cacheDir, entry, 'preimage'), 'conflict\n', 'utf8');
}

function recordResolution(cacheDir: string, entry: string) {
  fs.writeFileSync(path.join(cacheDir, entry, 'postimage'), 'resolved\n', 'utf8');
}

async function waitForCalls(counter: { count: number }, expected: number, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (counter.count < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return counter.count;
}

test('only a recorded resolution fires the listener, never a conflict that was recorded and then aborted', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));
  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);
  await waitForFsWatchToArm();

  recordConflict(cacheDir, 'a1b2c3');
  await settle();
  fs.rmSync(path.join(cacheDir, 'a1b2c3'), { recursive: true });
  await settle();
  assert.equal(counter.count, 0, 'an aborted rebase leaves no resolution behind, so a retry would only conflict again');

  recordConflict(cacheDir, 'a1b2c3');
  await settle();
  recordResolution(cacheDir, 'a1b2c3');
  assert.equal(await waitForCalls(counter, 1), 1);
});

test('a repo with no rr-cache yet watches for it appearing and upgrades itself', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);
  await waitForFsWatchToArm();

  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);
  await settle();
  assert.equal(counter.count, 0, 'rr-cache appears with the first conflict, which is not yet a resolution');

  recordConflict(cacheDir, 'd4e5f6');
  await settle();
  recordResolution(cacheDir, 'd4e5f6');
  assert.equal(await waitForCalls(counter, 1), 1, 'and the watch moved onto the cache itself');
});

test('a missing common gitdir declines rather than throwing', () => {
  const watcher = createRerereWatcher({ commonGitDir: null, onChange: () => {} });
  assert.equal(watcher.start(), false);
  assert.doesNotThrow(() => watcher.stop());
});

test('stop is idempotent and survives a watcher that never started', () => {
  const watcher = createRerereWatcher({ commonGitDir: path.join(os.tmpdir(), 'nope-does-not-exist'), onChange: () => {} });
  watcher.stop();
  assert.doesNotThrow(() => watcher.stop());
});

test('a recorded resolution clears a live cooldown and nothing else', () => {
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: true, teardownPending: false }),
    { clear: true, reason: 'rerere-recorded' }
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: false, teardownPending: false }),
    { clear: false, reason: 'no-cooldown' },
    'a resolution recorded while this session was never blocked is not news'
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: false, hasCooldown: true, teardownPending: false }),
    { clear: false, reason: 'disabled' }
  );
  assert.deepEqual(
    decideRerereCooldownClear({ enabled: true, hasCooldown: true, teardownPending: true }),
    { clear: false, reason: 'teardown' }
  );
});

test('an outer event that fires before rr-cache exists does not disarm the watch', async (t) => {
  const gitDir = tempGitDir();
  t.after(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  const counter = { count: 0 };
  const watcher = createRerereWatcher({ commonGitDir: gitDir, onChange: () => { counter.count += 1; }, debounceMs: 20 });
  t.after(() => watcher.stop());
  assert.equal(watcher.start(), true);
  await waitForFsWatchToArm();

  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(counter.count, 0, 'nothing to hand over to, so nothing is reported');

  const cacheDir = path.join(gitDir, RR_CACHE_DIR);
  fs.mkdirSync(cacheDir);
  await settle();
  recordConflict(cacheDir, 'a1b2c3');
  recordResolution(cacheDir, 'a1b2c3');
  assert.equal(await waitForCalls(counter, 1), 1, 'the watch was still armed and handed over to the cache itself');
});
