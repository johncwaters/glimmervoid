import test from 'node:test';
import assert from 'node:assert/strict';

import type { UpdateJournal, UpdateRunState } from '../shared/contracts/update-journal.ts';
import { appendTail, beginRun, beginStep, finishStep, markStaged, planSteps } from '../server/core/update-apply-core.ts';
import {
  IDLE_UPDATE_REQUEST,
  installedUpdateText,
  lastUpdateCheckText,
  latestUpdateDetails,
  projectUpdateProgress,
  reduceUpdateRequest,
  shouldAutoCheckUpdates,
  updateBanner,
  updateControls,
  updateSummary,
} from '../public/updates-view-core.ts';
import type { UpdateStatusView } from '../public/updates-view-core.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const LATEST_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

function status(overrides: UpdateStatusView = {}): UpdateStatusView {
  return {
    updateAvailable: true,
    current: '0.24.0',
    latest: '0.25.0',
    currentSha: SHA,
    latestSha: LATEST_SHA,
    releaseUrl: 'https://example.test/releases/0.25.0',
    command: 'git pull --ff-only',
    flavor: 'clone',
    platform: 'linux',
    installedBranch: 'main',
    upstream: 'origin/main',
    isTreeClean: true,
    lastCheckAt: 1_000,
    channel: 'release',
    behindCount: null,
    reason: null,
    journalSummary: null,
    applyRefusal: null,
    ...overrides,
  };
}

function journal(state: UpdateRunState, reason: string | null = null): UpdateJournal {
  return {
    state,
    fromSha: SHA,
    toSha: LATEST_SHA,
    toVersion: '0.25.0',
    channel: 'release',
    steps: [{
      id: 'fetch',
      status: state === 'running' ? 'running' : 'succeeded',
      startedAt: 1_000,
      finishedAt: state === 'running' ? null : 2_000,
      outputTail: ['fetching origin', 'received objects'],
    }],
    activeStep: state === 'running' ? 'fetch' : null,
    reason,
    startedAt: 1_000,
    finishedAt: state === 'running' ? null : 2_000,
  };
}

function idleJournal(): UpdateJournal {
  return {
    state: 'idle',
    fromSha: null,
    toSha: null,
    toVersion: null,
    channel: 'release',
    steps: [],
    activeStep: null,
    reason: null,
    startedAt: null,
    finishedAt: null,
  };
}

function journalStagingWithSilentActiveStep(): UpdateJournal {
  const started = beginRun(idleJournal(), {
    stepIds: planSteps({ lockfileChanged: true }),
    fromSha: SHA,
    toSha: LATEST_SHA,
    toVersion: '0.25.0',
    channel: 'release',
    now: 1_000,
  });
  const fetching = beginStep(started, { stepId: 'fetch', now: 1_000 });
  const fetchOutput = {
    ...fetching,
    steps: fetching.steps.map((step) => step.id === 'fetch'
      ? { ...step, outputTail: appendTail(step.outputTail, 'fetching origin\nreceived objects\n') }
      : step),
  };
  const fetched = finishStep(fetchOutput, { stepId: 'fetch', now: 2_000 });
  return beginStep(fetched, { stepId: 'stage', now: 2_000 });
}

test('updateControls shows only the one action the update state calls for', () => {
  const dirty = { reason: 'dirty-tree', message: 'Commit or discard the checkout changes before updating. Check for updates again.' };
  const npmGlobal = { reason: 'unsupported-flavor', message: 'Use the install command because dashboard updates require a clone.' };
  const alreadyCheckedOut = { reason: 'target-already-checked-out', message: 'The checkout already contains the update target. Restart to run it.' };
  const cases: { name: string; input: Parameters<typeof updateControls>[0]; expected: ReturnType<typeof updateControls> }[] = [
    { name: 'no status yet', input: { status: null }, expected: { actions: ['check'], note: null, command: null } },
    { name: 'up to date', input: { status: status({ updateAvailable: false }) }, expected: { actions: ['check'], note: null, command: null } },
    { name: 'applicable update', input: { status: status() }, expected: { actions: ['update'], note: null, command: null } },
    { name: 'downloading', input: { status: status(), journal: journal('running') }, expected: { actions: [], note: null, command: null } },
    { name: 'request in flight', input: { status: status(), request: { requested: true, failure: null } }, expected: { actions: [], note: null, command: null } },
    { name: 'ready to restart', input: { status: status(), journal: journal('staged') }, expected: { actions: ['restart'], note: null, command: null } },
    { name: 'refused checkout', input: { status: status({ applyRefusal: dirty }) }, expected: { actions: ['check'], note: dirty.message, command: null } },
    { name: 'install command', input: { status: status({ applyRefusal: npmGlobal }) }, expected: { actions: ['check'], note: npmGlobal.message, command: 'git pull --ff-only' } },
    { name: 'already checked out', input: { status: status({ applyRefusal: alreadyCheckedOut }) }, expected: { actions: ['restart'], note: alreadyCheckedOut.message, command: null } },
    { name: 'unsent request', input: { status: status(), request: { requested: false, failure: 'Not connected to the server. Reconnecting.' } }, expected: { actions: [], note: 'Not connected to the server. Reconnecting.', command: null } },
  ];
  for (const entry of cases) assert.deepEqual(updateControls(entry.input), entry.expected, entry.name);
});

test('reduceUpdateRequest locks on a sent request and unlocks on the answering frame', () => {
  const sent = reduceUpdateRequest(IDLE_UPDATE_REQUEST, 'request-sent');
  assert.deepEqual(sent, { requested: true, failure: null });
  assert.deepEqual(reduceUpdateRequest(sent, 'progress-frame'), IDLE_UPDATE_REQUEST);
  assert.deepEqual(reduceUpdateRequest(sent, 'error-frame'), IDLE_UPDATE_REQUEST);
  assert.equal(reduceUpdateRequest(IDLE_UPDATE_REQUEST, 'error-frame'), IDLE_UPDATE_REQUEST);
});

test('reduceUpdateRequest reports an unsent request and clears it on the next frame', () => {
  const unsent = reduceUpdateRequest(IDLE_UPDATE_REQUEST, 'request-unsent');
  assert.deepEqual(unsent, { requested: false, failure: 'Not connected to the server. Reconnecting.' });
  assert.deepEqual(reduceUpdateRequest(unsent, 'status-frame'), { requested: false, failure: null });
  assert.equal(reduceUpdateRequest(IDLE_UPDATE_REQUEST, 'status-frame'), IDLE_UPDATE_REQUEST);
  assert.deepEqual(reduceUpdateRequest(unsent, 'request-sent'), { requested: true, failure: null });
});

test('updateBanner prompts a restart once ready and keeps the command only where the install shape rules the dashboard out', () => {
  assert.deepEqual(updateBanner(status()), { mode: 'link', text: 'Update available: v0.24.0 to v0.25.0' });
  assert.deepEqual(updateBanner(status({ journalSummary: { ...journal('running'), state: 'running' } })), {
    mode: 'link',
    text: 'Downloading v0.25.0 in the background.',
  });
  assert.deepEqual(updateBanner(status({ journalSummary: { ...journal('staged'), state: 'staged' } })), {
    mode: 'restart',
    text: 'v0.25.0 is ready. Restart to update, or it installs on the next start.',
  });
  assert.equal(updateBanner(status({
    applyRefusal: { reason: 'unsupported-flavor', message: 'Use the install command because dashboard updates require a clone.' },
  })).mode, 'command');
  assert.equal(updateBanner(status({
    applyRefusal: { reason: 'unsupported-platform', message: 'Use the install command because dashboard updates are unavailable on Windows.' },
  })).mode, 'command');
  assert.equal(updateBanner(status({
    applyRefusal: { reason: 'dirty-tree', message: 'Commit or discard the checkout changes before updating. Check for updates again.' },
  })).mode, 'link');
  assert.equal(updateBanner(status({ applyRefusal: undefined })).mode, 'command');
  assert.equal(updateBanner(null).mode, 'command');
});

test('projectUpdateProgress falls back to the last spoken step while the active one is silent', () => {
  const projection = projectUpdateProgress(journalStagingWithSilentActiveStep());
  assert.deepEqual(projection, {
    state: 'running',
    terminalLine: null,
    steps: [
      { id: 'fetch', label: 'Fetch', status: 'succeeded' },
      { id: 'stage', label: 'Stage', status: 'running' },
      { id: 'install', label: 'Install dependencies', status: 'pending' },
      { id: 'build', label: 'Build', status: 'pending' },
    ],
    outputTail: ['fetching origin', 'received objects'],
    outputStepId: 'fetch',
    outputStepLabel: 'Fetch',
  });
  assert.equal(projectUpdateProgress(null), null);
});

test('projectUpdateProgress leaves the tail unlabelled while the active step is the one speaking', () => {
  const projection = projectUpdateProgress(journal('running'));
  assert.equal(projection?.outputStepId, 'fetch');
  assert.equal(projection?.outputStepLabel, null);
});

test('projectUpdateProgress stays quiet once the run needs nothing from the operator', () => {
  const staged = markStaged(journalStagingWithSilentActiveStep(), { now: 3_000 });
  assert.equal(projectUpdateProgress(staged), null);
  for (const state of ['idle', 'succeeded', 'discarded'] as const) assert.equal(projectUpdateProgress(journal(state)), null, state);
});

test('projectUpdateProgress keeps the steps and output beside one reason-bearing line for a stopped run', () => {
  const cases: { state: UpdateRunState; reason: string | null; line: string }[] = [
    { state: 'failed', reason: 'build timed out', line: 'Update failed: build timed out.' },
    { state: 'interrupted', reason: 'interrupted', line: 'Update interrupted: interrupted.' },
  ];
  for (const entry of cases) {
    assert.deepEqual(projectUpdateProgress(journal(entry.state, entry.reason)), {
      state: entry.state,
      terminalLine: entry.line,
      steps: [{ id: 'fetch', label: 'Fetch', status: 'succeeded' }],
      outputTail: ['fetching origin', 'received objects'],
      outputStepId: 'fetch',
      outputStepLabel: 'Fetch',
    });
  }
});

test('update identity rows show installed state, latest metadata and main-channel distance', () => {
  assert.equal(installedUpdateText(status()), 'v0.24.0, commit 0123456 on main, clean checkout');
  assert.equal(
    installedUpdateText(status({ current: null, installedBranch: null, isTreeClean: false })),
    'Unknown version, commit 0123456, uncommitted local changes',
  );
  assert.equal(latestUpdateDetails(status()).label, 'v0.25.0');
  assert.deepEqual(latestUpdateDetails(status({
    latest: null,
    channel: 'main',
    behindCount: 3,
  })), {
    label: 'commit fedcba9',
    behind: '3 commits behind',
    releaseUrl: 'https://example.test/releases/0.25.0',
  });
});

test('lastUpdateCheckText explains disabled checks, unknown flavor and failures', () => {
  assert.equal(lastUpdateCheckText({ status: status(), checkForUpdates: false, relativeTime: '1m ago' }), 'Update checks are off.');
  assert.equal(lastUpdateCheckText({ status: status({ flavor: 'unknown' }), relativeTime: '1m ago' }), 'The install flavor is unknown.');
  assert.equal(lastUpdateCheckText({ status: status({ reason: 'update-check-failed' }), relativeTime: '1m ago' }), 'The last update check failed.');
  assert.equal(lastUpdateCheckText({ status: status(), relativeTime: '1m ago' }), '1m ago');
});

test('lastUpdateCheckText explains when the checkout already contains the release', () => {
  assert.equal(
    lastUpdateCheckText({
      status: status({ reason: 'release-already-checked-out', updateAvailable: false }),
      relativeTime: '1m ago',
    }),
    'The checkout already contains the latest release. Restart to run it.',
  );
});

test('updateSummary names the running and target versions in one headline', () => {
  assert.deepEqual(updateSummary(status(), null), {
    tone: 'available',
    headline: 'Update available: v0.24.0 to v0.25.0.',
  });
  assert.deepEqual(updateSummary(status({ latest: null, channel: 'main', behindCount: 1 }), null), {
    tone: 'available',
    headline: 'Update available: v0.24.0 to commit fedcba9 (1 commit behind).',
  });
  assert.deepEqual(updateSummary(status({ updateAvailable: false, latest: '0.24.0' }), null), {
    tone: 'current',
    headline: 'Up to date. Running v0.24.0.',
  });
  assert.deepEqual(updateSummary(status({ updateAvailable: false, reason: 'fetch-failed' }), null), {
    tone: 'unknown',
    headline: 'Running v0.24.0. The last check did not finish.',
  });
  assert.deepEqual(updateSummary(null, null), { tone: 'unknown', headline: 'No update check has run yet.' });
});

test('updateSummary follows the update run over the last check', () => {
  assert.deepEqual(updateSummary(status(), journal('running')), {
    tone: 'running',
    headline: 'Downloading v0.25.0 in the background. Glimmervoid keeps running.',
  });
  assert.deepEqual(updateSummary(status({ updateAvailable: false }), journal('staged')), {
    tone: 'staged',
    headline: 'v0.25.0 is ready. Restart to update now, or it installs on the next start.',
  });
});

test('shouldAutoCheckUpdates checks on open only when the last check is stale and checks are on', () => {
  const tenMinutes = 10 * 60_000;
  assert.equal(shouldAutoCheckUpdates({ status: null, now: 5_000, lastAutoCheckAt: null }), true);
  assert.equal(shouldAutoCheckUpdates({ status: status({ lastCheckAt: 1_000 }), now: 1_000 + tenMinutes - 1, lastAutoCheckAt: null }), false);
  assert.equal(shouldAutoCheckUpdates({ status: status({ lastCheckAt: 1_000 }), now: 1_000 + tenMinutes, lastAutoCheckAt: null }), true);
  assert.equal(shouldAutoCheckUpdates({ status: null, now: 5_000, lastAutoCheckAt: 4_000 }), false);
  assert.equal(shouldAutoCheckUpdates({ status: null, checkForUpdates: false, now: 5_000, lastAutoCheckAt: null }), false);
});
