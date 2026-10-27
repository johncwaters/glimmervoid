import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createIntegrationRefWatcher } from '../detection/integration-ref-watch.ts';
import { SHORT_NAMES_AVAILABLE, shortPathOf } from './helpers/short-path.ts';
import { waitFor, waitForFsWatchToArm } from './helpers/wait-for.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EVENT_DEADLINE_MS = 5000;
const QUIET_WINDOW_MS = 300;

function fakeCommonGitDir(branches = ['develop']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-irw-'));
  const logsHeads = path.join(dir, 'logs', 'refs', 'heads');
  fs.mkdirSync(logsHeads, { recursive: true });
  for (const b of branches) {
    const p = path.join(logsHeads, b);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '0000 init\n', 'utf8');
  }
  const append = (b: string, line: string) => fs.appendFileSync(path.join(logsHeads, b), `${line}\n`, 'utf8');
  return { dir, append, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('fires (debounced, coalesced) when the integration branch reflog is appended', async () => {
  const fx = fakeCommonGitDir(['develop']);
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: fx.dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 200 });
  try {
    assert.equal(w.start(), true, 'started over a real reflog dir');
    assert.equal(w.active, true);
    await waitForFsWatchToArm();
    calls = 0;

    for (let i = 0; i < 4; i++) fx.append('develop', `move ${i}`);
    await waitFor(() => calls >= 1, 'the watcher fired', EVENT_DEADLINE_MS);
    await wait(QUIET_WINDOW_MS);
    assert.equal(calls, 1, 'the burst coalesced into exactly one onChange');

    fx.append('develop', 'later move');
    await waitFor(() => calls >= 2, 'the watcher fired', EVENT_DEADLINE_MS);
    assert.equal(calls, 2, 'a subsequent move fires again');
  } finally {
    w.stop();
    fx.cleanup();
  }
});

test('the watcher survives a commonGitDir under an 8.3 short parent', { skip: !SHORT_NAMES_AVAILABLE }, async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-irw-shortbase-'));
  const dir = shortPathOf(outer);
  assert.ok(dir, 'the volume mints an 8.3 alias');
  const logsHeads = path.join(dir, 'logs', 'refs', 'heads');
  fs.mkdirSync(logsHeads, { recursive: true });
  fs.writeFileSync(path.join(logsHeads, 'develop'), '0000 init\n', 'utf8');
  let calls = 0;
  const w = createIntegrationRefWatcher({ commonGitDir: dir, branch: 'develop', onChange: () => { calls++; }, debounceMs: 50 });
  try {
    assert.equal(w.start(), true, 'started over the short-path reflog dir');
    await waitForFsWatchToArm();
    calls = 0;
    fs.appendFileSync(path.join(logsHeads, 'develop'), 'move\n', 'utf8');
    await waitFor(() => calls >= 1, 'the watcher fired', EVENT_DEADLINE_MS);
    assert.equal(calls, 1, 'fires normally instead of aborting on the short-path prefix');
  } finally {
    w.stop();
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
