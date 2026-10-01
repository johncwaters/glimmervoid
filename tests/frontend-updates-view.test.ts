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
  updateActionAvailability,
  updateBannerMode,
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

test('updateActionAvailability enables the update when the server reports no refusal', () => {
  assert.deepEqual(updateActionAvailability({ status: status() }), {
    update: { enabled: true, reason: null },
    restart: { enabled: true, reason: null },
  });
});

test('updateActionAvailability renders the server refusal verbatim and derives none of its own', () => {
  const cases: { status: UpdateStatusView; reason: string }[] = [
    {
      status: status({ applyRefusal: { reason: 'unsupported-flavor', message: 'Use the install command because dashboard updates require a clone.' } }),
      reason: 'Use the install command because dashboard updates require a clone.',
    },
    {
      status: status({ applyRefusal: { reason: 'checkout-changed', message: 'The checkout moved since the last check. Check for updates again.' } }),
      reason: 'The checkout moved since the last check. Check for updates again.',
    },
    {
      status: status({ applyRefusal: { reason: 'already-staged', message: 'Restart to apply the staged update.' } }),
      reason: 'Restart to apply the staged update.',
    },
    {
      status: status({
        applyRefusal: {
          reason: 'target-already-checked-out',
          message: 'The checkout already contains the update target. Restart to run it.',
        },
      }),
      reason: 'The checkout already contains the update target. Restart to run it.',
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(updateActionAvailability({ status: entry.status }).update, { enabled: false, reason: entry.reason });
  }
  const contradicted = status({
    updateAvailable: false,
    flavor: 'npm-global',
    platform: 'win32',
    isTreeClean: false,
    installedBranch: null,
    upstream: 'fork/main',
    latestSha: null,
    reason: 'branch-diverged',
    applyRefusal: null,
  });
  assert.deepEqual(updateActionAvailability({ status: contradicted }).update, { enabled: true, reason: null });
});

test('updateActionAvailability keeps only the conditions the browser alone knows', () => {
  assert.deepEqual(updateActionAvailability({ status: null }).update, {
    enabled: false,
    reason: 'Update status unavailable. Check for updates.',
  });
  const requested = updateActionAvailability({ status: status(), request: { requested: true, failure: null } });
  assert.deepEqual(requested.update, { enabled: false, reason: 'Wait for the current update to finish.' });
  assert.deepEqual(requested.restart, { enabled: false, reason: 'Wait for update staging to finish.' });
  const unsent = updateActionAvailability({ status: status(), request: { requested: false, failure: 'Not connected to the server. Reconnecting.' } });
  assert.deepEqual(unsent.update, { enabled: false, reason: 'Not connected to the server. Reconnecting.' });
  assert.deepEqual(unsent.restart, { enabled: true, reason: null });
});

test('updateActionAvailability disables Restart while staging runs and leaves it live once staged', () => {
  assert.deepEqual(updateActionAvailability({ status: status(), journal: journal('running') }).restart, {
    enabled: false,
    reason: 'Wait for update staging to finish.',
  });
  assert.deepEqual(updateActionAvailability({ status: status(), journal: journal('running') }).update, {
    enabled: false,
    reason: 'Wait for the current update to finish.',
  });
  assert.deepEqual(updateActionAvailability({ status: status(), journal: journal('staged') }).restart, {
    enabled: true,
    reason: null,
  });
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

test('updateBannerMode keeps the command only where the install shape rules the dashboard out', () => {
  assert.equal(updateBannerMode(status()), 'link');
  assert.equal(updateBannerMode(status({
    applyRefusal: { reason: 'unsupported-flavor', message: 'Use the install command because dashboard updates require a clone.' },
  })), 'command');
  assert.equal(updateBannerMode(status({
    applyRefusal: { reason: 'unsupported-platform', message: 'Use the install command because dashboard updates are unavailable on Windows.' },
  })), 'command');
  assert.equal(updateBannerMode(status({
    applyRefusal: { reason: 'dirty-tree', message: 'Commit or discard the checkout changes before updating. Check for updates again.' },
  })), 'link');
  assert.equal(updateBannerMode(status({ applyRefusal: undefined })), 'command');
  assert.equal(updateBannerMode(null), 'command');
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

test('projectUpdateProgress keeps the steps and the output beside a terminal reason line', () => {
  const staged = markStaged(journalStagingWithSilentActiveStep(), { now: 3_000 });
  const projection = projectUpdateProgress(staged);
  assert.equal(projection?.terminalLine, 'Update staged. Restart to hand it off.');
  assert.deepEqual(projection?.steps.map((step) => step.id), ['fetch', 'stage', 'install', 'build']);
  assert.deepEqual(projection?.outputTail, ['fetching origin', 'received objects']);
  assert.equal(projection?.outputStepLabel, 'Fetch');
});

test('projectUpdateProgress renders each terminal journal state as one reason-bearing line', () => {
  const cases: { state: UpdateRunState; reason: string | null; line: string }[] = [
    { state: 'staged', reason: null, line: 'Update staged. Restart to hand it off.' },
    { state: 'succeeded', reason: null, line: 'Update succeeded at restart.' },
    { state: 'failed', reason: 'build timed out', line: 'Update failed: build timed out.' },
    { state: 'discarded', reason: 'restarted without handoff', line: 'Update discarded: restarted without handoff.' },
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

test('lastUpdateCheckText explains a release whose npx package is not attached yet', () => {
  assert.equal(
    lastUpdateCheckText({
      status: status({ flavor: 'npx', reason: 'release-asset-pending', updateAvailable: false }),
      relativeTime: '1m ago',
    }),
    'A new release is out, but its npx package is not attached yet. The next check offers it.',
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
    headline: 'Updating to v0.25.0. Glimmervoid keeps running until the restart.',
  });
  assert.deepEqual(updateSummary(status({ updateAvailable: false }), journal('staged')), {
    tone: 'staged',
    headline: 'v0.25.0 is staged. Restart to finish updating.',
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
