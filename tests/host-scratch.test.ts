import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hostScratchRoot, makeHostScratchDirectory, sweepOrphanedHostScratch } from '../server/host-scratch.ts';

const sharedTestHome = process.env.GLIMMERVOID_HOME;
let privateHome = '';

before(async () => {
  assert.ok(sharedTestHome, 'isolate-home must set GLIMMERVOID_HOME');
  privateHome = await mkdtemp(path.join(sharedTestHome, 'host-scratch-'));
  process.env.GLIMMERVOID_HOME = privateHome;
});

after(async () => {
  process.env.GLIMMERVOID_HOME = sharedTestHome;
  await rm(privateHome, { recursive: true, force: true });
});

test('sweep removes only a stale listed-prefix folder and spares hooks, unknown names and scratch made by this process', async () => {
  const scratchRoot = hostScratchRoot();
  const staleListedFolder = 'check-Ab12Cd';
  const hooksFolder = 'glimmervoid-hooks';
  const unknownNameFolder = 'operator-notes';
  await mkdir(path.join(scratchRoot, staleListedFolder), { recursive: true });
  await mkdir(path.join(scratchRoot, hooksFolder), { recursive: true });
  await mkdir(path.join(scratchRoot, unknownNameFolder), { recursive: true });
  const liveScratchFolder = path.basename(await makeHostScratchDirectory('check-'));

  await sweepOrphanedHostScratch();

  const remainingFolders = (await readdir(scratchRoot)).sort();
  assert.deepEqual(remainingFolders, [liveScratchFolder, hooksFolder, unknownNameFolder].sort());
});
