import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePrimaryReviewAction, reviewHeadline } from '../public/sidebar/review-copy-core.ts';

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
    assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason, live: true, isMergeRendered: false }), 'resolve');
  }
});

test('primary review action is merge for a diverged base or an ended parked session when merge renders', () => {
  assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason: 'base-diverged', live: true, isMergeRendered: true }), 'merge');
  assert.equal(decidePrimaryReviewAction({ status: 'pending-review', mergeReason: null, live: true, isMergeRendered: true }), 'merge');
});

test('primary review action is none when neither resolve nor merge applies', () => {
  assert.equal(decidePrimaryReviewAction({ status: 'parked', mergeReason: 'rebase-conflict', live: false, isMergeRendered: false }), 'none');
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
