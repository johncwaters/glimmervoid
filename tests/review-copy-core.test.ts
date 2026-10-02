import test from 'node:test';
import assert from 'node:assert/strict';
import { branchSyncActionTitle, branchSyncClickAction, branchSyncLabel, decidePrimaryReviewAction, hasReviewChanges, resyncOutcomeText, reviewHeadline, shouldShowBranchSyncLabel, shouldShowReviewHeaderCounts } from '../public/sidebar/review-copy-core.ts';

const headlineInputs = {
  status: 'pending-review',
  mergeReason: null,
  fetched: true,
  hasChanges: true,
  hasCommits: true,
  canMerge: true,
  isWorkspace: false,
  live: true,
  effectiveBase: 'main',
};

test('review headline names the merge target when changes are ready', () => {
  assert.deepEqual(reviewHeadline(headlineInputs), { text: 'Ready to merge into main' });
  assert.deepEqual(reviewHeadline({ ...headlineInputs, effectiveBase: 'trunk' }), { text: 'Ready to merge into trunk' });
  assert.deepEqual(reviewHeadline({ ...headlineInputs, effectiveBase: null }), { text: 'Ready to merge into base' });
  assert.deepEqual(reviewHeadline({ ...headlineInputs, effectiveBase: undefined }), { text: 'Ready to merge into base' });
});

test('review headline identifies a diverged base even while changes are loading', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, status: 'parked', mergeReason: 'base-diverged', fetched: false }), {
    text: 'Parked: base branch diverged',
  });
});

test('review headline identifies merge conflicts and unknown parked reasons', () => {
  for (const mergeReason of ['rebase-conflict', 'merge-conflict', 'unknown', null]) {
    assert.deepEqual(reviewHeadline({ ...headlineInputs, status: 'parked', mergeReason, hasChanges: false }), {
      text: 'Parked: merge conflict',
    });
  }
});

test('review headline keeps merging visible while changes refresh', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, status: 'merging', fetched: false, hasChanges: false }), {
    text: 'Merging',
  });
});

test('review headline keeps merged visible after the diff cache is cleared', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, status: 'merged', fetched: false, hasChanges: false }), {
    text: 'Merged',
  });
});

test('review headline waits for changes before declaring an empty worktree', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, fetched: false, hasChanges: false }), {
    text: 'Checking for changes',
  });
});

test('review headline identifies a fetched worktree without changes', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, status: 'none', hasChanges: false }), {
    text: 'No changes yet',
  });
});

test('review headline reports a workspace session without promising a merge', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, isWorkspace: true, canMerge: false }), {
    text: 'Changes in this worktree',
  });
});

test('review headline reports an ended session instead of ready to merge', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, live: false, canMerge: false }), {
    text: 'Session ended',
  });
});

test('review headline reports uncommitted only changes instead of ready to merge', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, hasCommits: false, canMerge: false }), {
    text: 'Uncommitted changes',
  });
});

test('review headline reports committed changes that cannot merge yet', () => {
  assert.deepEqual(reviewHeadline({ ...headlineInputs, canMerge: false }), {
    text: 'Not ready to merge',
  });
});

test('primary review action is resolve for a live conflict parked session', () => {
  for (const mergeReason of ['rebase-conflict', null]) {
    assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason, live: true, hasChanges: true, isMergeRendered: false }), 'resolve');
  }
});

test('primary review action is merge for a diverged base or an ended parked session when merge renders', () => {
  assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason: 'base-diverged', live: true, hasChanges: true, isMergeRendered: true }), 'merge');
  assert.equal(decidePrimaryReviewAction({ status: 'pending-review', mergeReason: null, live: true, hasChanges: true, isMergeRendered: true }), 'merge');
});

test('primary review action is none when neither resolve nor merge applies', () => {
  assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason: 'rebase-conflict', live: false, hasChanges: true, isMergeRendered: false }), 'none');
});

test('review copy names the effective base and its push action', async () => {
  const { baseLabel, mergeActionTitle, mergeTargetText, parkedStatusText } = await import('../public/sidebar/review-copy-core.ts');
  assert.equal(baseLabel('trunk'), 'trunk');
  assert.equal(baseLabel(null), 'base');
  assert.match(mergeActionTitle('trunk', 'Alt+I'), /Merge into trunk, push it/);
  assert.match(mergeActionTitle(null, 'Alt+I'), /Merge into base, push it/);
  assert.match(mergeActionTitle('trunk', 'Alt+I'), /\(Alt\+I\)$/);
  assert.equal(mergeTargetText('trunk'), 'merges into trunk');
  assert.equal(mergeTargetText(null), 'merges into base');
  assert.match(parkedStatusText('base-diverged'), /Resync the base branch by hand, then Merge again/);
});

test('H1 base-diverged park keeps Merge rendered and enabled', async () => {
  const { decideMergeAction } = await import('../public/sidebar/review-copy-core.ts');
  assert.deepEqual(decideMergeAction('parked', 'base-diverged', true), {
    isRendered: true,
    isEnabled: true,
  });
  assert.deepEqual(decideMergeAction('parked', 'rebase-conflict', true), {
    isRendered: false,
    isEnabled: false,
  });
});

test('base-diverged rendered Merge explains why it is disabled', async () => {
  const { decideMergeAction, mergeDisabledReason } = await import('../public/sidebar/review-copy-core.ts');
  assert.deepEqual(decideMergeAction('parked', 'base-diverged', false), {
    isRendered: true,
    isEnabled: false,
  });
  assert.match(mergeDisabledReason({
    status: 'parked',
    mergeReason: 'base-diverged',
    fetched: true,
    hasCommits: true,
    live: true,
    state: 'COMPLETE',
  }) ?? '', /Resync the base branch by hand/);
});

test('loading, no changes, and inactive session outrank base-diverged copy', async () => {
  const { mergeDisabledReason } = await import('../public/sidebar/review-copy-core.ts');
  const baseDiverged = {
    status: 'parked', mergeReason: 'base-diverged', fetched: true, hasCommits: true, live: true,
    state: 'COMPLETE',
  };
  assert.equal(mergeDisabledReason({ ...baseDiverged, fetched: false }), 'Checking for changes...');
  assert.equal(mergeDisabledReason({ ...baseDiverged, hasCommits: false }), null);
  assert.equal(mergeDisabledReason({ ...baseDiverged, live: false }), 'Session ended.');
});

test('empty review hides Merge while parked and merging actions remain unchanged', () => {
  const inputs = { status: 'pending-review', mergeReason: null, live: true, hasChanges: false, isMergeRendered: true };
  for (const status of ['none', 'pending-review', 'merged']) {
    assert.equal(decidePrimaryReviewAction({ ...inputs, status }), 'none');
  }
  assert.equal(decidePrimaryReviewAction({ ...inputs, status: 'merging' }), 'merge');
  assert.equal(decidePrimaryReviewAction({ ...inputs, status: 'parked' }), 'resolve');
  assert.equal(decidePrimaryReviewAction({ ...inputs, status: 'parked', mergeReason: 'base-diverged' }), 'merge');
  assert.equal(decidePrimaryReviewAction({ ...inputs, hasChanges: true }), 'merge');
});

const freshSync = { branch: 'main', upstream: 'origin/main', state: 'in-sync', ahead: 0, behind: 0, fetched: true };

test('only a fresh in-sync branch hides its visible sync label', () => {
  for (const fetched of [true, null]) {
    assert.equal(shouldShowBranchSyncLabel({ ...freshSync, fetched }), false);
  }
  assert.equal(shouldShowBranchSyncLabel({ ...freshSync, fetched: false }), true);
  for (const state of ['ahead', 'behind', 'diverged', 'no-upstream', 'unknown']) {
    assert.equal(shouldShowBranchSyncLabel({ ...freshSync, state }), true);
  }
  assert.equal(shouldShowBranchSyncLabel(null), true);
  assert.equal(shouldShowBranchSyncLabel(undefined), true);
});

test('header counts omit fetched empty worktrees and single Diff sections', () => {
  const inputs = { fetched: true, hasChanges: true, view: 'diff', committedFiles: 0, uncommittedFiles: 11 };
  assert.equal(shouldShowReviewHeaderCounts(inputs), false);
  assert.equal(shouldShowReviewHeaderCounts({ ...inputs, committedFiles: 2, uncommittedFiles: 0 }), false);
  assert.equal(shouldShowReviewHeaderCounts({ ...inputs, committedFiles: 2 }), true);
  for (const view of ['diff', 'map', 'notes']) {
    assert.equal(shouldShowReviewHeaderCounts({ ...inputs, view, hasChanges: false, uncommittedFiles: 0 }), false);
  }
  for (const view of ['map', 'notes']) {
    assert.equal(shouldShowReviewHeaderCounts({ ...inputs, view }), true);
  }
  assert.equal(shouldShowReviewHeaderCounts({ ...inputs, fetched: false, hasChanges: false, uncommittedFiles: 0 }), true);
  assert.equal(shouldShowReviewHeaderCounts({ ...inputs, uncommittedFiles: 0 }), true);
});

test('unchanged resync is silent while all other outcomes keep their copy', () => {
  const sync = { ...freshSync, action: 'none' };
  assert.equal(resyncOutcomeText(sync), null);
  assert.equal(resyncOutcomeText({ ...sync, action: 'fast-forwarded' }), 'Fast-forwarded main to origin/main.');
  assert.equal(resyncOutcomeText({ ...sync, action: 'pushed' }), 'Pushed main to origin/main.');
  assert.equal(resyncOutcomeText({ ...sync, state: 'diverged' }), 'main has diverged from origin/main. Resolve manually.');
  assert.equal(resyncOutcomeText({ ...sync, state: 'no-upstream' }), 'main has no upstream to resync against.');
  assert.equal(resyncOutcomeText({ ...sync, branch: null, upstream: null, state: 'no-upstream' }), 'The base branch has no upstream to resync against.');
  assert.equal(resyncOutcomeText({ ...sync, upstream: null, action: 'pushed' }), 'Pushed main to its upstream.');
  assert.equal(resyncOutcomeText({ ...sync, error: 'Fetch failed' }), 'Resync failed: Fetch failed');
  assert.equal(resyncOutcomeText({ ...sync, state: 'unknown' }), 'Could not determine sync status.');
});


test('branch sync tooltip names the action and supplied platform shortcut', () => {
  const sync = freshSync;
  assert.equal(branchSyncActionTitle({ ...sync, state: 'behind' }, 'cmd-U', true), 'Click to fast-forward main to origin/main (cmd-U)');
  assert.equal(branchSyncActionTitle({ ...sync, state: 'ahead' }, 'Alt+U', true), 'Click to push main to origin/main (Alt+U)');
  for (const state of ['in-sync', 'diverged', 'no-upstream', 'unknown']) {
    assert.equal(branchSyncActionTitle({ ...sync, state }, 'cmd-U', true), 'Click to fetch and check again (cmd-U)');
  }
  for (const state of ['behind', 'ahead', 'in-sync']) {
    assert.equal(branchSyncActionTitle({ ...sync, state, fetched: false }, 'cmd-U', true), 'Click to fetch and check again (cmd-U)');
  }
  for (const missingSync of [null, undefined]) {
    assert.equal(branchSyncActionTitle(missingSync, 'Alt+U', true), 'Click to fetch and check again (Alt+U)');
  }
  assert.equal(branchSyncActionTitle({ ...sync, state: 'behind', upstream: null }, 'cmd-U', true), 'Click to fast-forward main to its upstream (cmd-U)');
});

test('branch sync tooltip omits the shortcut hint when the shortcut resolves instead of resyncing', () => {
  assert.equal(branchSyncActionTitle({ ...freshSync, state: 'behind' }, 'cmd-U', false), 'Click to fast-forward main to origin/main');
  assert.equal(branchSyncActionTitle(null, 'cmd-U', false), 'Click to fetch and check again');
  assert.equal(branchSyncActionTitle({ ...freshSync, state: 'behind' }, 'cmd-U', true), 'Click to fast-forward main to origin/main (cmd-U)');
});

test('branch sync click resyncs only a fresh ahead or behind reading and rechecks otherwise', () => {
  for (const fetched of [true, null]) {
    for (const state of ['ahead', 'behind']) {
      assert.equal(branchSyncClickAction({ ...freshSync, state, fetched }), 'resync');
    }
    for (const state of ['in-sync', 'diverged', 'no-upstream', 'unknown']) {
      assert.equal(branchSyncClickAction({ ...freshSync, state, fetched }), 'recheck');
    }
  }
  for (const state of ['ahead', 'behind', 'in-sync', 'diverged', 'no-upstream', 'unknown']) {
    assert.equal(branchSyncClickAction({ ...freshSync, state, fetched: false }), 'recheck');
  }
  assert.equal(branchSyncClickAction(null), 'recheck');
  assert.equal(branchSyncClickAction(undefined), 'recheck');
});

test('branch sync tooltip promises a recheck exactly when the click rechecks', () => {
  for (const fetched of [true, null, false]) {
    for (const state of ['ahead', 'behind', 'in-sync', 'diverged', 'no-upstream', 'unknown']) {
      const sync = { ...freshSync, state, fetched };
      const promisesRecheck = branchSyncActionTitle(sync, 'cmd-U', true).startsWith('Click to fetch and check again');
      assert.equal(promisesRecheck, branchSyncClickAction(sync) === 'recheck');
    }
  }
});

test('review changes count while loading, with changed files, or with commits', () => {
  assert.equal(hasReviewChanges({ fetched: false, changedFileCount: 0, hasCommits: false }), true);
  assert.equal(hasReviewChanges({ fetched: true, changedFileCount: 0, hasCommits: false }), false);
  assert.equal(hasReviewChanges({ fetched: true, changedFileCount: 2, hasCommits: false }), true);
  assert.equal(hasReviewChanges({ fetched: true, changedFileCount: 0, hasCommits: true }), true);
});

test('branch sync labels fall back to Base branch for every state with a missing branch', () => {
  const labelsByState = {
    'no-upstream': 'Base branch: no upstream',
    unknown: 'Base branch: sync state unknown vs origin/main',
    'in-sync': 'Base branch: in sync with origin/main',
    ahead: 'Base branch: 2 ahead of origin/main',
    behind: 'Base branch: 3 behind origin/main',
    diverged: 'Base branch: 2 ahead, 3 behind origin/main',
  };
  for (const branch of [null, '']) {
    for (const [state, label] of Object.entries(labelsByState)) {
      assert.equal(branchSyncLabel({ ...freshSync, branch, state, ahead: 2, behind: 3 }), label);
    }
  }
  assert.equal(branchSyncLabel({ ...freshSync, upstream: null, state: 'no-upstream' }), 'main: no upstream');
  assert.equal(branchSyncLabel({ ...freshSync, upstream: null, state: 'behind', behind: 3 }), 'main: 3 behind its upstream');
  assert.equal(branchSyncLabel(null), null);
});
