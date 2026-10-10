import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendUpdateCheck } from '../server/backend-update.ts';
import type { UpdateStatus } from '../server/backend-update.ts';
import { decideUpdateStatus } from '../server/core/update-core.ts';
import type { ControlHandlerDeps } from '../server/control-handlers.ts';
import type { ControlMessageRecord } from '../server/control-replay-core.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';

const UPDATE_RECHECK_MS = 24 * 60 * 60 * 1000;

test('settings start and cancel automatic update checks without duplicate timers', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const config = { checkForUpdates: false };
  let checksRun = 0;
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: async () => { checksRun += 1; return null; },
    getControlClientCount: () => 1,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  context.after(() => updateCheck.stop());
  updateCheck.start();
  context.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  assert.equal(checksRun, 0);
  config.checkForUpdates = true;
  updateCheck.applySettings();
  await settle();
  assert.equal(checksRun, 1);
  updateCheck.applySettings();
  context.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  assert.equal(checksRun, 2);
  config.checkForUpdates = false;
  updateCheck.applySettings();
  config.checkForUpdates = true;
  context.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  assert.equal(checksRun, 2, 'the previous automatic timer was cancelled');
  updateCheck.applySettings();
  await settle();
  context.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  assert.equal(checksRun, 4);
});

test('scheduled update checks read the current opt-out while manual checks remain available', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const config = { checkForUpdates: true };
  let checksRun = 0;
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: async () => { checksRun += 1; return null; },
    getControlClientCount: () => 1,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  context.after(() => updateCheck.stop());
  updateCheck.start();
  await settle();
  config.checkForUpdates = false;
  context.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  assert.equal(checksRun, 1);
  await updateCheck.checkNow();
  assert.equal(checksRun, 2);
});

interface UpdateFrame {
  type: string;
  latest?: string | null;
}

function connect(deps: Partial<ControlHandlerDeps>): UpdateFrame[] {
  const server = createControlServer(controlDeps({ projects: [] }, deps));
  return connectControl<UpdateFrame>(server).sent;
}

function makeUpdateStatus(latest: string): UpdateStatus {
  return {
    ...decideUpdateStatus({
    currentVersion: '0.16.0',
    latestVersion: latest,
    installedSha: '0123456789abcdef0123456789abcdef01234567',
    latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
    flavor: 'npm-global',
    }),
    platform: 'linux',
    installedBranch: null,
    upstream: null,
    isTreeClean: null,
    lastCheckAt: 1000,
    journalSummary: null,
    applyRefusal: null,
  };
}

function makeCloneStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    ...makeUpdateStatus('0.17.0'),
    ...decideUpdateStatus({
      currentVersion: '0.16.0',
      latestVersion: '0.17.0',
      installedSha: '0123456789abcdef0123456789abcdef01234567',
      latestSha: 'fedcba9876543210fedcba9876543210fedcba98',
      flavor: 'clone',
    }),
    installedBranch: 'main',
    upstream: 'origin/main',
    isTreeClean: true,
    ...overrides,
  };
}

function makeJournal(): UpdateJournal {
  return {
    state: 'idle', fromSha: null, toSha: null, toVersion: null, channel: 'release', steps: [],
    activeStep: null, reason: null, startedAt: null, finishedAt: null,
  };
}

test('no update-status when getUpdateStatus is absent', () => {
  let sent: UpdateFrame[] = [];
  assert.doesNotThrow(() => { sent = connect({}); });
  assert.equal(sent.filter((m) => m.type === 'update-status').length, 0);
});

test('update-status replays an up-to-date result', () => {
  const status = { ...makeUpdateStatus('0.16.0'), updateAvailable: false };
  const sent = connect({ getUpdateStatus: () => status });
  assert.deepEqual(sent.filter((message) => message.type === 'update-status'), [{ type: 'update-status', ...status }]);
});

test('replays exactly one update-status frame when an update is cached', () => {
  const status = makeUpdateStatus('0.17.0');
  const sent = connect({ getUpdateStatus: () => status });
  const updates = sent.filter((m) => m.type === 'update-status');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { type: 'update-status', ...status });
});

test('update-progress replays the latest journal', () => {
  const journal = makeJournal();
  const sent = connect({ getUpdateJournal: () => journal });
  assert.deepEqual(sent.filter((message) => message.type === 'update-progress'), [{ type: 'update-progress', journal }]);
});

test('getStatus projects the latest journal summary', async () => {
  const journal = makeJournal();
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    currentVersion: '0.16.0',
    checkForUpdate: async () => makeUpdateStatus('0.17.0'),
    getUpdateJournal: () => journal,
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  journal.state = 'running';
  journal.activeStep = 'fetch';
  journal.startedAt = 2000;
  assert.deepEqual(updateCheck.getStatus()?.journalSummary, {
    state: 'running',
    activeStep: 'fetch',
    reason: null,
    startedAt: 2000,
    finishedAt: null,
  });
});

test('the recorded status carries the preflight verdict instead of leaving it to the browser', async () => {
  const journal = makeJournal();
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    currentVersion: '0.16.0',
    platform: 'linux',
    checkForUpdate: async () => makeCloneStatus(),
    getUpdateJournal: () => journal,
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  assert.equal((await updateCheck.checkNow()).applyRefusal, null);
  assert.equal(updateCheck.getStatus()?.applyRefusal, null);

  const dirty = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    currentVersion: '0.16.0',
    platform: 'linux',
    checkForUpdate: async () => makeCloneStatus({ isTreeClean: false }),
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  assert.deepEqual((await dirty.checkNow()).applyRefusal, {
    reason: 'dirty-tree',
    message: 'Commit or discard the checkout changes before updating. Check for updates again.',
  });

  const windows = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    currentVersion: '0.16.0',
    platform: 'win32',
    checkForUpdate: async () => makeCloneStatus({ platform: 'win32' }),
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  assert.equal((await windows.checkNow()).applyRefusal?.reason, 'unsupported-platform');
});

test('the apply refusal tracks the lane and re-broadcasts the status when it changes', async () => {
  const journal = makeJournal();
  let restartRequested = false;
  const broadcasts: ControlMessageRecord[] = [];
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    currentVersion: '0.16.0',
    platform: 'linux',
    checkForUpdate: async () => makeCloneStatus(),
    getUpdateJournal: () => journal,
    isRestartRequested: () => restartRequested,
    getControlClientCount: () => 0,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  assert.equal(broadcasts.length, 1);

  updateCheck.refreshApplyAvailability();
  assert.equal(broadcasts.length, 1, 'an unchanged lane broadcasts nothing');

  journal.state = 'running';
  journal.activeStep = 'fetch';
  updateCheck.refreshApplyAvailability();
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts.at(-1)?.applyRefusal, {
    reason: 'already-running',
    message: 'Wait for the current update to finish.',
  });

  journal.state = 'staged';
  journal.activeStep = null;
  updateCheck.refreshApplyAvailability();
  assert.deepEqual(broadcasts.at(-1)?.applyRefusal, {
    reason: 'already-staged',
    message: 'Restart to apply the staged update.',
  });

  journal.state = 'idle';
  restartRequested = true;
  updateCheck.refreshApplyAvailability();
  assert.deepEqual(broadcasts.at(-1)?.applyRefusal, {
    reason: 'restart-requested',
    message: 'Wait for the requested restart to finish.',
  });
  assert.equal(broadcasts.length, 4);
});

test('every check broadcasts update-status while banner logging stays deduplicated', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const broadcasts: ControlMessageRecord[] = [];
  const results = [makeUpdateStatus('0.17.0'), makeUpdateStatus('0.17.0'), makeUpdateStatus('0.18.0')];
  let checksRun = 0;
  let logs = 0;
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    currentVersion: '0.16.0',
    checkForUpdate: async () => results[checksRun++] ?? null,
    getControlClientCount: () => 1,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => { logs += 1; } },
  });

  updateCheck.start();
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  updateCheck.stop();

  assert.equal(checksRun, 3, 'the startup check plus one per recheck tick');
  assert.deepEqual(
    broadcasts.filter((message) => message.type === 'update-status').map((message) => message.latest),
    ['0.17.0', '0.17.0', '0.18.0'],
  );
  assert.equal(logs, 2);
});

test('up-to-date and failed checks are both recorded and broadcast', async () => {
  const broadcasts: ControlMessageRecord[] = [];
  const results: Array<UpdateStatus | null> = [makeUpdateStatus('0.16.0'), null];
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    currentVersion: '0.16.0',
    checkForUpdate: async () => results.shift() ?? null,
    getControlClientCount: () => 0,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
  });
  assert.equal((await updateCheck.checkNow()).updateAvailable, false);
  assert.equal((await updateCheck.checkNow()).reason, 'update-check-failed');
  assert.deepEqual(
    broadcasts.filter((message) => message.type === 'update-status').map((message) => message.reason),
    [null, 'update-check-failed'],
  );
});

function settle(): Promise<void> {
  return new Promise((resolve) => { queueMicrotask(() => queueMicrotask(() => resolve())); });
}

test('a recheck is skipped while no control client is connected', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let checksRun = 0;
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true },
    currentVersion: '0.16.0',
    checkForUpdate: async () => { checksRun += 1; return null; },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });

  updateCheck.start();
  await settle();
  t.mock.timers.tick(UPDATE_RECHECK_MS);
  await settle();
  updateCheck.stop();

  assert.equal(checksRun, 1, 'only the startup check ran: nobody is listening for the result');
});

test('checkNow forces ttl zero and returns the in-flight promise', async () => {
  let release = (_status: UpdateStatus): void => { throw new Error('the check did not expose its resolver'); };
  const seenTtls: Array<number | undefined> = [];
  const updateCheck = createBackendUpdateCheck({
    config: { checkForUpdates: true, updateChannel: 'release' },
    currentVersion: '0.16.0',
    checkForUpdate: (options) => {
      seenTtls.push(options.ttlMs);
      return new Promise((resolve) => { release = resolve; });
    },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  const first = updateCheck.checkNow();
  const second = updateCheck.checkNow();
  assert.equal(first, second);
  assert.deepEqual(seenTtls, [0]);
  release(makeUpdateStatus('0.17.0'));
  await first;
});

test('changing updateChannel clears status and triggers a forced check', async () => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: true,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: async (options) => {
      channels.push(options.updateChannel);
      return { ...makeUpdateStatus('0.17.0'), channel: options.updateChannel };
    },
    getControlClientCount: () => 0,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  config.updateChannel = 'main';
  updateCheck.applySettings();
  assert.equal(updateCheck.getStatus(), null);
  await settle();
  assert.deepEqual(channels, ['release', 'main']);
});

test('a channel change with update checks off resets status without fetching and manual checks use the new channel', async () => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: false,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: async (options) => {
      channels.push(options.updateChannel);
      return { ...makeUpdateStatus('0.17.0'), channel: options.updateChannel };
    },
    getControlClientCount: () => 1,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  await updateCheck.checkNow();
  assert.equal(updateCheck.getStatus()?.channel, 'release');
  config.updateChannel = 'main';
  updateCheck.applySettings();
  await settle();
  assert.equal(updateCheck.getStatus(), null);
  assert.deepEqual(channels, ['release'], 'the channel change started no check');
  assert.equal((await updateCheck.checkNow()).channel, 'main');
  assert.deepEqual(channels, ['release', 'main']);
  assert.equal(updateCheck.getStatus()?.channel, 'main');
});

test('turning update checks off drops a channel refresh queued behind a running check', async (context) => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: true,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const releases: Array<(status: UpdateStatus) => void> = [];
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: (options) => {
      channels.push(options.updateChannel);
      return new Promise((resolve) => { releases.push(resolve); });
    },
    getControlClientCount: () => 1,
    broadcastControl: () => {},
    logger: { log: () => {} },
  });
  context.after(() => updateCheck.stop());
  const running = updateCheck.checkNow();
  config.updateChannel = 'main';
  updateCheck.applySettings();
  config.checkForUpdates = false;
  updateCheck.applySettings();
  releases[0]?.(makeUpdateStatus('0.17.0'));
  await running;
  await settle();
  assert.deepEqual(channels, ['release'], 'the queued refresh never ran with checks off');
  assert.equal(updateCheck.getStatus(), null);
});

test('update-check delegates to the forced check lane', async () => {
  let checksRun = 0;
  const server = createControlServer(controlDeps({ projects: [] }, {
    checkNow: async () => {
      checksRun += 1;
      return makeUpdateStatus('0.17.0');
    },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-check' });
  assert.equal(checksRun, 1);
});

test('update-apply sends a named refusal to the requesting socket', async () => {
  const server = createControlServer(controlDeps({ projects: [] }, {
    applyUpdate: async () => ({ ok: false, reason: 'dirty-worktree', message: 'Commit or stash local changes.' }),
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply' });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[dirty-worktree] Commit or stash local changes.',
  });
});

test('update-apply asked to restart once staged hands off after a staged run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order: string[] = [];
  const server = createControlServer(controlDeps({ projects: [] }, {
    applyUpdate: async () => { order.push('staged'); return { ok: true, reason: null, message: '' }; },
    isStaging: () => false,
    noteRestartRequested: () => { order.push('notice'); },
    requestRestart: () => { order.push('restart'); },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: [] });
  t.mock.timers.tick(200);
  assert.deepEqual(order, ['staged', 'notice', 'restart']);
});

test('update-apply skips the restart when a session started after the operator confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let restartsRequested = 0;
  const sessions = new Map([
    ['s-confirmed', plainSession('s-confirmed')],
    ['s-started-during-staging', plainSession('s-started-during-staging')],
  ]);
  const server = createControlServer(controlDeps({ projects: [] }, {
    sessions,
    applyUpdate: async () => ({ ok: true, reason: null, message: '' }),
    isStaging: () => false,
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: ['s-confirmed'] });
  t.mock.timers.tick(200);
  assert.equal(restartsRequested, 0);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[update-restart-skipped] The update is staged, but sessions started since you confirmed. Restart when ready.',
  });
});

test('update-apply skips the restart when a confirmed session was swapped for an unconfirmed one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let restartsRequested = 0;
  const sessions = new Map([['session-b', plainSession('session-b')]]);
  const server = createControlServer(controlDeps({ projects: [] }, {
    sessions,
    applyUpdate: async () => ({ ok: true, reason: null, message: '' }),
    isStaging: () => false,
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: ['session-a'] });
  t.mock.timers.tick(200);
  assert.equal(restartsRequested, 0);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[update-restart-skipped] The update is staged, but sessions started since you confirmed. Restart when ready.',
  });
});

test('update-apply skips the restart when an agent API session started after the operator confirmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let restartsRequested = 0;
  const sessions = new Map([['s-confirmed', plainSession('s-confirmed')]]);
  const agentSessions = new Map([['agent-started-during-staging', plainSession('agent-started-during-staging')]]);
  const server = createControlServer(controlDeps({ projects: [] }, {
    sessions,
    agentSessions,
    applyUpdate: async () => ({ ok: true, reason: null, message: '' }),
    isStaging: () => false,
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: ['s-confirmed'] });
  t.mock.timers.tick(200);
  assert.equal(restartsRequested, 0);
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[update-restart-skipped] The update is staged, but sessions started since you confirmed. Restart when ready.',
  });
});

test('update-apply never restarts after a refused run or when no restart was asked for', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let restartsRequested = 0;
  let isRefused = true;
  const server = createControlServer(controlDeps({ projects: [] }, {
    applyUpdate: async () => (isRefused
      ? { ok: false, reason: 'dirty-worktree', message: 'Commit or stash local changes.' }
      : { ok: true, reason: null, message: '' }),
    isStaging: () => false,
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  await connection.send({ type: 'update-apply', restartWhenStaged: true });
  isRefused = false;
  await connection.send({ type: 'update-apply' });
  t.mock.timers.tick(200);
  assert.equal(restartsRequested, 0);
});

test('restart-server refuses while update staging is active', () => {
  let restartsRequested = 0;
  let restartNotices = 0;
  const server = createControlServer(controlDeps({ projects: [] }, {
    isStaging: () => true,
    noteRestartRequested: () => { restartNotices += 1; },
    requestRestart: () => { restartsRequested += 1; },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  connection.send({ type: 'restart-server' });
  assert.deepEqual(connection.sent.at(-1), {
    type: 'error',
    message: '[update-staging] Wait for the update staging run to finish before restarting.',
  });
  assert.equal(restartNotices, 0);
  assert.equal(restartsRequested, 0);
});

test('restart-server records the request before scheduling restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order: string[] = [];
  const server = createControlServer(controlDeps({ projects: [] }, {
    isStaging: () => false,
    noteRestartRequested: () => { order.push('notice'); },
    requestRestart: () => { order.push('restart'); },
    broadcastControl: (message) => { order.push(String(message.type)); },
  }));
  const connection = connectControl<Record<string, unknown>>(server);
  connection.send({ type: 'restart-server' });
  assert.deepEqual(order, ['notice', 'restarting']);
  t.mock.timers.tick(200);
  assert.deepEqual(order, ['notice', 'restarting', 'restart']);
});

test('a channel change queued during a check never starts another one after stop', async () => {
  const config: { checkForUpdates: boolean; updateChannel: 'release' | 'main' } = {
    checkForUpdates: true,
    updateChannel: 'release',
  };
  const channels: string[] = [];
  const broadcasts: ControlMessageRecord[] = [];
  let release = (_status: UpdateStatus): void => { throw new Error('the check did not expose its resolver'); };
  const updateCheck = createBackendUpdateCheck({
    config,
    currentVersion: '0.16.0',
    checkForUpdate: (options) => {
      channels.push(options.updateChannel);
      return new Promise((resolve) => { release = resolve; });
    },
    getControlClientCount: () => 0,
    broadcastControl: (message) => { broadcasts.push(message); },
    logger: { log: () => {} },
  });
  const first = updateCheck.checkNow();
  config.updateChannel = 'main';
  updateCheck.applySettings();
  updateCheck.stop();
  release(makeUpdateStatus('0.17.0'));
  await first;
  await settle();
  assert.deepEqual(channels, ['release'], 'the queued refresh never ran after stop');
  assert.deepEqual(broadcasts, [], 'a result arriving after stop is never recorded');
  updateCheck.applySettings();
  await settle();
  assert.deepEqual(channels, ['release'], 'a settings change after stop starts nothing');
});
