import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import {
  INITIAL_SETTINGS_STATE,
  applyOptimisticAddedRepoRoots,
  applyOptimisticSettingsPatch,
  applySettingsServerMessage,
} from '../public/state/settings-core.ts';
import type { SettingsCollectionState } from '../public/state/settings-core.ts';

function createDraft(
  payload: SettingsCollectionState['payload'] = {},
  serverRevision = 0,
  optimisticRevision = 0,
): SettingsCollectionState {
  return { payload: structuredClone(payload), serverRevision, optimisticRevision };
}

test('applySettingsServerMessage replaces payload, increments serverRevision, and resets optimisticRevision', () => {
  let state = createDraft({ checkForUpdates: false }, 1, 2);
  const helpers = {
    replace(next: SettingsCollectionState) {
      state = structuredClone(next);
    },
  };

  applySettingsServerMessage(
    state,
    { type: 'settings-updated', seq: 1, settings: { checkForUpdates: true, repoRoots: ['/repos'] } } as ServerMessage,
    helpers,
  );
  assert.equal(state.serverRevision, 2);
  assert.equal(state.optimisticRevision, 0);
  assert.deepEqual(state.payload, { checkForUpdates: true, repoRoots: ['/repos'] });

  applySettingsServerMessage(
    state,
    { type: 'settings', settings: { checkForUpdates: false } } as ServerMessage,
    helpers,
  );
  assert.equal(state.serverRevision, 3);
  assert.equal(state.optimisticRevision, 0);
  assert.deepEqual(state.payload, { checkForUpdates: false });
});

test('applyOptimisticSettingsPatch merges nested blocks and workflow rule toggles without clobbering siblings', () => {
  const draft = createDraft({
    sessionOrder: ['a', 'b'],
    teamReview: { enabled: true, skill: 'old-skill' },
    workflows: {
      enabled: true,
      rules: [
        { id: 'r1', name: 'Rule 1', enabled: false, repos: ['org/repo'], trigger: 'pr', actions: [] },
        { id: 'r2', name: 'Rule 2', enabled: true, repos: ['org/repo'], trigger: 'pr', actions: [] },
      ],
    },
  }, 4, 0);

  applyOptimisticSettingsPatch(draft, {
    sessionOrder: ['b', 'a'],
    teamReview: { skill: 'new-skill' },
    workflows: { rules: [{ id: 'r1', enabled: true }] },
  });

  assert.equal(draft.serverRevision, 4);
  assert.equal(draft.optimisticRevision, 1);
  assert.deepEqual(draft.payload.sessionOrder, ['b', 'a']);
  assert.deepEqual(draft.payload.teamReview, { enabled: true, skill: 'new-skill' });
  assert.deepEqual(draft.payload.workflows, {
    enabled: true,
    rules: [
      { id: 'r1', name: 'Rule 1', enabled: true, repos: ['org/repo'], trigger: 'pr', actions: [] },
      { id: 'r2', name: 'Rule 2', enabled: true, repos: ['org/repo'], trigger: 'pr', actions: [] },
    ],
  });
});

test('applyOptimisticAddedRepoRoots appends deduplicated roots and bumps optimisticRevision only when changed', () => {
  const draft = createDraft({ repoRoots: ['/work/a'] }, INITIAL_SETTINGS_STATE.serverRevision, INITIAL_SETTINGS_STATE.optimisticRevision);
  applyOptimisticAddedRepoRoots(draft, ['/work/a', '/work/b']);
  assert.equal(draft.serverRevision, 0);
  assert.equal(draft.optimisticRevision, 1);
  assert.deepEqual(draft.payload.repoRoots, ['/work/a', '/work/b']);

  applyOptimisticAddedRepoRoots(draft, ['/work/a']);
  assert.equal(draft.optimisticRevision, 1);
});
