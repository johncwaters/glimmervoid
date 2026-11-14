import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createCloneJobs } from '../server/repository-clone.ts';

const FAKE_GIT = `#!/bin/sh
target=""; for a in "$@"; do target="$a"; done
trap 'exit 143' TERM
echo "Cloning into '$target'..." >&2
i=0; while [ $i -lt 6 ]; do printf 'Receiving objects:  %s%% (%s/10)\\r' $((i*10)) $i >&2; sleep 0.1; i=$((i+1)); done
case "$target" in *broken*) echo "fatal: repository not found" >&2; exit 128;; esac
mkdir -p "$target/.git"; exit 0
`;

function waitUntil(isReached: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadlineAtMs = performance.now() + 15_000;
    const poll = setInterval(() => {
      if (!isReached() && performance.now() < deadlineAtMs) return;
      clearInterval(poll);
      if (isReached()) resolve();
      if (!isReached()) reject(new Error('the clone jobs never reached the awaited state'));
    }, 20);
  });
}

test('clone jobs run two at a time with progress, a cancel removes the partial folder, and a failure keeps its error', { skip: process.platform === 'win32' }, async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-clone-jobs-')));
  const cloneRoot = path.join(scratch, 'repos');
  const binDir = path.join(scratch, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'git'), FAKE_GIT, { mode: 0o755 });
  const pathBefore = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${pathBefore}`;
  const logLines: string[] = [];
  const clonedRoots: string[] = [];
  const mostCloningAtOnce = { count: 0 };
  const seenProgress = new Set<string>();
  try {
    const jobs = createCloneJobs({ cloneRootFor: async () => cloneRoot, tokenFor: async () => 'secret-token', onCloned: (root) => clonedRoots.push(root), log: (line) => logLines.push(line) });
    const stateOf = (name: string) => jobs.list().find((job) => job.name === name)?.state;
    jobs.onChange(() => {
      mostCloningAtOnce.count = Math.max(mostCloningAtOnce.count, jobs.list().filter((job) => job.state === 'cloning').length);
      for (const job of jobs.list()) seenProgress.add(job.progress);
    });
    const refusal = jobs.start(['https://github.com/acme/one', 'https://github.com/acme/two', 'https://github.com/acme/broken', 'https://github.com/acme/four', '--upload-pack=x']);
    assert.match(String(refusal), /is not a repository URL/);
    assert.deepEqual(jobs.list().map((job) => job.state), ['cloning', 'cloning', 'queued', 'queued']);
    jobs.cancel('https://github.com/acme/four');
    await waitUntil(() => fs.existsSync(path.join(cloneRoot, 'two')) && seenProgress.has('Receiving objects 10%'));
    jobs.cancel('https://github.com/acme/two');
    await waitUntil(() => jobs.list().every((job) => job.state !== 'queued' && job.state !== 'cloning'));
    assert.deepEqual([stateOf('acme/one'), stateOf('acme/two'), stateOf('acme/broken'), stateOf('acme/four')], ['done', 'cancelled', 'failed', 'cancelled']);
    assert.equal(mostCloningAtOnce.count, 2);
    assert.deepEqual(fs.readdirSync(cloneRoot), ['one']);
    assert.match(jobs.list().find((job) => job.name === 'acme/broken')?.error ?? '', /repository not found/);
    assert.deepEqual(clonedRoots, [cloneRoot]);
    assert.deepEqual(logLines.map((line) => line.replace(/ in \d+ s$/, '')).sort(), ['[clone] cancelled acme/four', '[clone] cancelled acme/two', '[clone] failed acme/broken: git clone https://github.com/acme/broken failed: fatal: repository not found', '[clone] finished acme/one', '[clone] started acme/broken', '[clone] started acme/one', '[clone] started acme/two']);
    assert.equal(JSON.stringify([logLines, jobs.list()]).includes('secret-token'), false);
  } finally {
    process.env.PATH = pathBefore;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
