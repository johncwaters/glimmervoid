import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUpdateApplyLane } from '../server/update-apply.ts';
import type { UpdateStatus } from '../shared/contracts/control-messages.ts';

const TARGET_VERSION = '2.0.0';

async function refuseGit(): Promise<never> {
  throw new Error('an npm global update must not run git');
}

const GIT_WORKSPACE_FORBIDDEN = {
  fetchOrigin: refuseGit,
  mergeFastForwardTo: refuseGit,
  probeWorktreeDirty: refuseGit,
  removeWorktreeByPath: refuseGit,
  resetKeepTo: refuseGit,
  stageDetachedWorktree: refuseGit,
};

function writePackage(packagePath: string, version: string): void {
  fs.mkdirSync(path.join(packagePath, 'dist', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: 'glimmervoid', version }));
  fs.writeFileSync(
    path.join(packagePath, 'dist', 'bin', 'glimmervoid.js'),
    `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)});\n`,
  );
}

function makeInstall({ npmExitCode = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-npm-update-'));
  const installFolder = path.join(root, 'prefix', 'lib', 'node_modules');
  const packageRoot = path.join(installFolder, 'glimmervoid');
  writePackage(packageRoot, '1.0.0');
  const publishedPackage = path.join(root, 'published');
  writePackage(publishedPackage, TARGET_VERSION);
  const nodeBin = path.join(root, 'node-bin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  fs.writeFileSync(path.join(nodeBin, 'npm'), [
    '#!/bin/sh',
    `[ ${npmExitCode} -ne 0 ] && { echo "npm ERR! registry unreachable" >&2; exit ${npmExitCode}; }`,
    'while [ "$1" != "--prefix" ]; do shift; done',
    'mkdir -p "$2/lib/node_modules"',
    `cp -R ${JSON.stringify(publishedPackage)} "$2/lib/node_modules/glimmervoid"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { root, installFolder, packageRoot, nodePath: path.join(nodeBin, 'node') };
}

function availableUpdate(): UpdateStatus {
  return {
    updateAvailable: true,
    current: '1.0.0',
    latest: TARGET_VERSION,
    currentSha: null,
    latestSha: null,
    releaseUrl: null,
    command: `npm install -g glimmervoid@${TARGET_VERSION}`,
    flavor: 'npm-global',
    platform: 'darwin',
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
    lastCheckAt: 0,
    channel: 'experimental',
    reason: null,
    deprecation: null,
    journalSummary: null,
    applyRefusal: null,
  };
}

function startLane(install: ReturnType<typeof makeInstall>) {
  const lane = createUpdateApplyLane({
    gitWorkspace: GIT_WORKSPACE_FORBIDDEN,
    packageRoot: install.packageRoot,
    journalPath: path.join(install.root, 'update-journal.json'),
    getUpdateStatus: availableUpdate,
    getUpdateChannel: () => 'experimental',
    broadcastControl: () => {},
    logger: { log: () => {}, warn: () => {} },
    platform: 'darwin',
    nodePath: install.nodePath,
  });
  lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  return lane;
}

function installedVersion(packagePath: string): string {
  return (JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')) as { version: string }).version;
}

test('an npm global install stages the channel version, swaps it in at hand-off, and drops the old copy once the new server listens', async () => {
  const install = makeInstall();
  try {
    const lane = startLane(install);
    const staged = await lane.applyUpdate();
    assert.equal(staged.ok, true, staged.message);
    assert.equal(lane.getJournal().state, 'staged');
    assert.equal(installedVersion(install.packageRoot), '1.0.0');

    await lane.handOffStagedUpdate();
    await lane.stop();
    assert.equal(lane.getJournal().state, 'succeeded');
    assert.equal(installedVersion(install.packageRoot), TARGET_VERSION);
    const previousPackagePath = path.join(install.installFolder, '.glimmervoid-update', 'previous');
    assert.equal(installedVersion(previousPackagePath), '1.0.0');

    const successor = startLane(install);
    await successor.whenIdle();
    assert.equal(fs.existsSync(previousPackagePath), false);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a failed npm install fails the run with npm output and leaves the live install untouched', async () => {
  const install = makeInstall({ npmExitCode: 1 });
  try {
    const lane = startLane(install);
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, false);
    const journal = lane.getJournal();
    assert.equal(journal.state, 'failed');
    assert.match(journal.steps.flatMap((step) => step.outputTail).join('\n'), /registry unreachable/);
    assert.equal(installedVersion(install.packageRoot), '1.0.0');
    assert.equal(fs.existsSync(path.join(install.installFolder, '.glimmervoid-update', 'stage')), false);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('an npm global install whose folder is not writable refuses before downloading', async () => {
  const install = makeInstall();
  fs.chmodSync(install.installFolder, 0o555);
  try {
    const lane = startLane(install);
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.reason, 'install-not-writable');
    assert.match(outcome.message, new RegExp(install.installFolder));
    assert.equal(lane.getNpmGlobalInstall()?.isWritable, false);
    assert.equal(lane.getJournal().state, 'idle');
  } finally {
    fs.chmodSync(install.installFolder, 0o755);
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});
