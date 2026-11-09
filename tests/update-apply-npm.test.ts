import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUpdateApplyLane } from '../server/update-apply.ts';
import type { UpdateStatus } from '../shared/contracts/control-messages.ts';

const TARGET_VERSION = '2.0.0';

async function refuseGit(): Promise<never> {
  throw new Error('a binary install or switch must not run git');
}

const GIT_WORKSPACE_FORBIDDEN = {
  fetchOrigin: refuseGit,
  mergeFastForwardTo: refuseGit,
  probeWorktreeDirty: refuseGit,
  removeWorktreeByPath: refuseGit,
  resetKeepTo: refuseGit,
  stageDetachedWorktree: refuseGit,
};

function availableUpdate(): UpdateStatus {
  return {
    updateAvailable: true,
    current: '1.0.0',
    latest: TARGET_VERSION,
    currentSha: null,
    latestSha: null,
    releaseUrl: null,
    command: 'glimmervoid-installer.sh',
    flavor: 'npm-global',
    platform: 'darwin',
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
    lastCheckAt: 0,
    channel: 'release',
    reason: null,
    deprecation: null,
    journalSummary: null,
    applyRefusal: null,
  };
}

function makeNpmInstall({ installerExitCode = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-binary-switch-'));
  const packageRoot = path.join(root, 'prefix', 'lib', 'node_modules', 'glimmervoid');
  fs.mkdirSync(packageRoot, { recursive: true });
  const installedMarker = path.join(root, 'installed.txt');
  const installerScript = [
    'echo "downloading glimmervoid"',
    `[ ${installerExitCode} -ne 0 ] && { echo "installer could not reach github.com" >&2; exit ${installerExitCode}; }`,
    `printf '%s' ${JSON.stringify(TARGET_VERSION)} > ${JSON.stringify(installedMarker)}`,
    '',
  ].join('\n');
  const requestedUrls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    requestedUrls.push(String(url));
    return new Response(installerScript);
  }) as typeof fetch;
  return { root, packageRoot, installedMarker, requestedUrls, fetchFn };
}

function startSwitchLane(install: ReturnType<typeof makeNpmInstall>, env: NodeJS.ProcessEnv = {}) {
  const lane = createUpdateApplyLane({
    gitWorkspace: GIT_WORKSPACE_FORBIDDEN,
    packageRoot: install.packageRoot,
    journalPath: path.join(install.root, 'update-journal.json'),
    getUpdateStatus: availableUpdate,
    getUpdateChannel: () => 'release',
    broadcastControl: () => {},
    logger: { log: () => {}, warn: () => {} },
    platform: 'darwin',
    standaloneExecutablePath: null,
    fetchFn: install.fetchFn,
    env,
  });
  lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  return lane;
}

test('an npm install in a read-only global prefix switches by running the target release installer without a restart', async () => {
  const install = makeNpmInstall();
  fs.chmodSync(install.packageRoot, 0o555);
  try {
    const lane = startSwitchLane(install);
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, true, outcome.message);
    assert.deepEqual(install.requestedUrls, [`https://github.com/johncwaters/glimmervoid/releases/download/v${TARGET_VERSION}/glimmervoid-installer.sh`]);
    assert.equal(fs.readFileSync(install.installedMarker, 'utf8'), TARGET_VERSION);
    assert.equal(lane.getJournal().state, 'succeeded');
  } finally {
    fs.chmodSync(install.packageRoot, 0o755);
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('an npm install under systemd refuses the switch and downloads nothing', async () => {
  const install = makeNpmInstall();
  try {
    const lane = startSwitchLane(install, { INVOCATION_ID: 'unit' });
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'supervised-install');
    assert.match(outcome.message, /npm uninstall -g glimmervoid/);
    assert.deepEqual(install.requestedUrls, []);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a failed installer fails the run with its output and the switch can be retried', async () => {
  const install = makeNpmInstall({ installerExitCode: 1 });
  try {
    const lane = startSwitchLane(install);
    const outcome = await lane.applyUpdate();
    assert.equal(outcome.ok, false);
    assert.equal(lane.getJournal().state, 'failed');
    assert.match(lane.getJournal().steps[0].outputTail.join('\n'), /could not reach github.com/);
    const retried = await lane.applyUpdate();
    await lane.stop();
    assert.equal(retried.ok, false);
    assert.equal(install.requestedUrls.length, 2);
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

function makeBinaryInstall({ updaterPublishes = true, installDirectoryName = 'bin', versionScript = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-binary-update-'));
  const installDirectory = path.join(root, installDirectoryName);
  fs.mkdirSync(installDirectory, { recursive: true });
  const versionFile = path.join(root, 'installed-version.txt');
  fs.writeFileSync(versionFile, '1.0.0');
  const executablePath = path.join(installDirectory, 'glimmervoid');
  fs.writeFileSync(executablePath, versionScript || `#!/bin/sh\ncat ${JSON.stringify(versionFile)}\n`, { mode: 0o755 });
  const publishedVersion = updaterPublishes ? TARGET_VERSION : '1.0.0';
  fs.writeFileSync(path.join(installDirectory, 'glimmervoid-update'), `#!/bin/sh\nprintf '%s' ${JSON.stringify(publishedVersion)} > ${JSON.stringify(versionFile)}\n`, { mode: 0o755 });
  return { root, executablePath, versionFile };
}

function startBinaryLane(install: ReturnType<typeof makeBinaryInstall>, flavor: UpdateStatus['flavor'] = 'binary') {
  const lane = createUpdateApplyLane({
    gitWorkspace: GIT_WORKSPACE_FORBIDDEN,
    packageRoot: path.join(install.root, 'snapshot'),
    journalPath: path.join(install.root, 'update-journal.json'),
    getUpdateStatus: () => ({ ...availableUpdate(), flavor, command: 'glimmervoid-update' }),
    getUpdateChannel: () => 'release',
    broadcastControl: () => {},
    logger: { log: () => {}, warn: () => {} },
    platform: 'darwin',
    standaloneExecutablePath: install.executablePath,
  });
  lane.startAfterListening({ listening: true, once: () => {}, removeListener: () => {} });
  return lane;
}

test('a standalone binary install runs the updater beside it and succeeds at hand-off without touching git', async () => {
  const install = makeBinaryInstall();
  try {
    const lane = startBinaryLane(install);
    const staged = await lane.applyUpdate();
    assert.equal(staged.ok, true, staged.message);
    assert.equal(lane.getJournal().state, 'staged');
    assert.equal(fs.readFileSync(install.versionFile, 'utf8'), TARGET_VERSION);

    await lane.handOffStagedUpdate();
    await lane.stop();
    assert.equal(lane.getJournal().state, 'succeeded');
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a standalone binary update fails while the target release has no binaries yet', async () => {
  const install = makeBinaryInstall({ updaterPublishes: false });
  try {
    const lane = startBinaryLane(install);
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /not published yet/);
    assert.equal(lane.getJournal().state, 'failed');
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a Homebrew install refuses the dashboard update and names brew upgrade', async () => {
  const install = makeBinaryInstall({ installDirectoryName: path.join('Cellar', 'glimmervoid', '1.0.0', 'bin') });
  try {
    const lane = startBinaryLane(install, 'homebrew');
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /brew upgrade glimmervoid/);
    assert.equal(fs.readFileSync(install.versionFile, 'utf8'), '1.0.0');
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});

test('a standalone binary update whose binary prints no version fails instead of claiming success', async () => {
  const install = makeBinaryInstall({ updaterPublishes: false, versionScript: '#!/bin/sh\necho warning >&2\n' });
  try {
    const lane = startBinaryLane(install);
    const outcome = await lane.applyUpdate();
    await lane.stop();
    assert.equal(outcome.ok, false);
    assert.equal(lane.getJournal().state, 'failed');
  } finally {
    fs.rmSync(install.root, { recursive: true, force: true });
  }
});
