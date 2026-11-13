import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { createUpdateApplyLane } from '../server/update-apply.ts';
import type { UpdateStatus } from '../shared/contracts/control-messages.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

const GIT = hasGit();

function commitFile(repositoryPath: string, fileName: string, contents: string): string {
  fs.writeFileSync(path.join(repositoryPath, fileName), contents);
  git(['add', fileName], repositoryPath);
  git(['-c', 'user.name=Glimmervoid Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', fileName], repositoryPath);
  return git(['rev-parse', 'HEAD'], repositoryPath).trim();
}

type LockfileChange = 'none' | 'at-target' | 'past-target';

function createCloneInstall(lockfileChange: LockfileChange = 'none') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-clone-update-')));
  const originPath = path.join(root, 'origin.git');
  const publisherPath = path.join(root, 'publisher');
  const packageRoot = path.join(root, 'install');
  git(['init', '-q', '--bare', '-b', 'main', originPath]);
  git(['clone', '-q', originPath, publisherPath]);
  git(['checkout', '-q', '-b', 'main'], publisherPath);
  commitFile(publisherPath, '.gitignore', 'dist/\nnode_modules/\n.glimmervoid/\n');
  commitFile(publisherPath, 'package-lock.json', '{}\n');
  const installedSha = commitFile(publisherPath, 'release.txt', 'installed\n');
  git(['push', '-q', 'origin', 'main'], publisherPath);
  git(['clone', '-q', originPath, packageRoot]);
  fs.mkdirSync(path.join(packageRoot, 'dist'));
  fs.writeFileSync(path.join(packageRoot, 'dist', 'built-from'), installedSha);
  fs.mkdirSync(path.join(packageRoot, 'node_modules'));
  const landedSha = commitFile(publisherPath, 'landed.txt', 'landed by a session\n');
  if (lockfileChange === 'at-target') commitFile(publisherPath, 'package-lock.json', '{"changed":"at-target"}\n');
  const targetSha = commitFile(publisherPath, 'release.txt', 'target\n');
  const landedAfterSha = commitFile(publisherPath, 'landed-after.txt', 'landed after the target\n');
  const pastTargetSha = lockfileChange === 'past-target'
    ? commitFile(publisherPath, 'package-lock.json', '{"changed":"past-target"}\n')
    : landedAfterSha;
  git(['push', '-q', 'origin', 'main'], publisherPath);
  const fakeBinPath = path.join(root, 'bin');
  fs.mkdirSync(fakeBinPath);
  fs.writeFileSync(path.join(fakeBinPath, 'npm'), '#!/bin/sh\nmkdir -p dist && git rev-parse HEAD > dist/built-from\ncase " $* " in *" ci "*) mkdir -p node_modules && git rev-parse HEAD > node_modules/installed-from ;; esac\n', { mode: 0o755 });
  return { root, packageRoot, installedSha, landedSha, targetSha, pastTargetSha, fakeBinPath };
}

function availableUpdate(install: ReturnType<typeof createCloneInstall>): UpdateStatus {
  return {
    updateAvailable: true,
    current: '1.0.0',
    latest: '1.0.1',
    currentSha: install.installedSha,
    latestSha: install.targetSha,
    releaseUrl: null,
    command: 'git pull --ff-only && npm ci && npm run build',
    flavor: 'clone',
    platform: 'darwin',
    installedBranch: 'main',
    upstream: 'origin/main',
    isTreeClean: true,
    lastCheckAt: 0,
    channel: 'release',
    reason: null,
    deprecation: null,
    journalSummary: null,
    applyRefusal: null,
  };
}

async function stageThenMoveCheckout(install: ReturnType<typeof createCloneInstall>, movedHeadSha: string) {
  const lane = createUpdateApplyLane({
    gitWorkspace: createGitWorkspace({ log: { warn() {} } }),
    packageRoot: install.packageRoot,
    journalPath: path.join(install.root, 'update-journal.json'),
    getUpdateStatus: () => availableUpdate(install),
    getUpdateChannel: () => 'release',
    broadcastControl: () => {},
    logger: { log: () => {}, warn: () => {} },
    platform: 'darwin',
  });
  lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  const staged = await lane.applyUpdate();
  assert.equal(staged.ok, true, staged.message);
  git(['fetch', '-q', 'origin'], install.packageRoot);
  git(['merge', '-q', '--ff-only', movedHeadSha], install.packageRoot);
  await lane.handOffStagedUpdate();
  await lane.stop();
  return lane;
}

function withFakeNpmOnPath<T>(fakeBinPath: string, run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinPath}${path.delimiter}${originalPath ?? ''}`;
  return run().finally(() => { process.env.PATH = originalPath; });
}

test('a staged clone update applies at hand-off after a session fast-forwarded the checkout toward the target', { skip: !GIT }, async () => {
  const install = createCloneInstall();
  try {
    const lane = await withFakeNpmOnPath(install.fakeBinPath, () => stageThenMoveCheckout(install, install.landedSha));
    assert.equal(lane.getJournal().state, 'succeeded', lane.getJournal().reason ?? '');
    assert.equal(git(['rev-parse', 'HEAD'], install.packageRoot).trim(), install.targetSha);
    assert.equal(fs.readFileSync(path.join(install.packageRoot, 'dist', 'built-from'), 'utf8').trim(), install.targetSha);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a staged clone update rebuilds at the checkout when sessions moved it past the target before hand-off', { skip: !GIT }, async () => {
  const install = createCloneInstall();
  try {
    const lane = await withFakeNpmOnPath(install.fakeBinPath, () => stageThenMoveCheckout(install, install.pastTargetSha));
    assert.equal(lane.getJournal().state, 'succeeded', lane.getJournal().reason ?? '');
    assert.equal(git(['rev-parse', 'HEAD'], install.packageRoot).trim(), install.pastTargetSha);
    assert.equal(fs.readFileSync(path.join(install.packageRoot, 'dist', 'built-from'), 'utf8').trim(), install.pastTargetSha);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { lockfileChange: 'at-target', name: 'the target changed package-lock.json', expectedInstalledFrom: 'targetSha' },
  { lockfileChange: 'past-target', name: 'package-lock.json changed after the target', expectedInstalledFrom: 'pastTargetSha' },
] as const) {
  test(`a staged clone update moved past the target installs its own dependencies at hand-off when ${scenario.name}`, { skip: !GIT }, async () => {
    const install = createCloneInstall(scenario.lockfileChange);
    try {
      const lane = await withFakeNpmOnPath(install.fakeBinPath, () => stageThenMoveCheckout(install, install.pastTargetSha));
      assert.equal(lane.getJournal().state, 'succeeded', lane.getJournal().reason ?? '');
      assert.equal(fs.readFileSync(path.join(install.packageRoot, 'dist', 'built-from'), 'utf8').trim(), install.pastTargetSha);
      assert.equal(fs.readFileSync(path.join(install.packageRoot, 'node_modules', 'installed-from'), 'utf8').trim(), install[scenario.expectedInstalledFrom]);
    } finally {
      fs.rmSync(install.root, { recursive: true, force: true });
    }
  });
}
