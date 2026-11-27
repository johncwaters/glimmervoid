import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '../shared/contracts/control-messages.ts';
import type { PackRow, PackSourceRow, PacksStatus } from '../shared/contracts/control/pack-messages.ts';
import {
  INITIAL_PACKS_STATE,
  applyOptimisticPackApprove,
  applyOptimisticPackFolderRemove,
  applyOptimisticPackSourceEnable,
  applyOptimisticPackSourceRemove,
  applyPacksServerMessage,
} from '../public/state/packs-core.ts';
import type { PacksCollectionState } from '../public/state/packs-core.ts';

function samplePackRow(overrides: Partial<PackRow> = {}): PackRow {
  return {
    name: 'alpha-pack',
    version: 1,
    description: 'Sample pack',
    dir: '/tmp/packs/alpha-pack',
    state: 'pending',
    fingerprint: 'fp-alpha',
    files: ['pack.json'],
    needs: [],
    missingRequires: [],
    prFlows: null,
    themes: [],
    previewDataUrl: null,
    panels: [],
    launchers: [],
    sessions: null,
    statusUrls: [],
    agent: null,
    mcpServers: [],
    hooks: [],
    settings: [],
    jobs: [],
    community: null,
    errors: [],
    isPlacedByHand: false,
    ...overrides,
  };
}

function sampleSourceRow(overrides: Partial<PackSourceRow> = {}): PackSourceRow {
  return {
    url: 'https://github.com/example/packs',
    slug: 'example-packs',
    dir: '/tmp/sources/example-packs',
    isBuiltIn: false,
    packs: [
      {
        name: 'alpha-pack',
        dir: '/tmp/sources/example-packs/alpha-pack',
        isEnabled: true,
        version: 1,
        description: 'Sample pack',
        kinds: ['Panel'],
        iconDataUrl: null,
        themeSwatches: [],
        previewDataUrl: null,
      },
    ],
    error: null,
    ...overrides,
  };
}

function sampleStatus(overrides: Partial<PacksStatus> = {}): PacksStatus {
  return {
    type: 'packs-status',
    packs: [samplePackRow()],
    sources: [sampleSourceRow()],
    themes: [],
    panels: [
      {
        viewId: 'pack:alpha-pack:main',
        id: 'main',
        pack: 'alpha-pack',
        label: 'Alpha',
        entryUrl: '/packs/alpha-pack/index.html',
        iconUrl: null,
        reads: [],
        acts: [],
      },
    ],
    launchers: [
      {
        pack: 'alpha-pack',
        id: 'run',
        label: 'Run Alpha',
        agent: 'claude',
        model: null,
        effort: null,
        project: 'demo',
        disabledReason: null,
      },
    ],
    providers: [],
    warnings: [],
    ...overrides,
  };
}

function seededState(overrides: Partial<PacksStatus> = {}): PacksCollectionState {
  const state = structuredClone(INITIAL_PACKS_STATE);
  applyPacksServerMessage(state, { ...sampleStatus(overrides), seq: 1 } as ServerMessage);
  return state;
}

test('packs-core applies packs-status and optimistic approve, folder remove, source remove, and source enable/disable', () => {
  const state = seededState();
  assert.equal(state.serverRevision, 1);
  assert.equal(state.optimisticRevision, 0);
  assert.equal(state.status?.packs[0]?.state, 'pending');

  applyOptimisticPackApprove(state, 'fp-alpha');
  assert.equal(state.serverRevision, 1);
  assert.equal(state.optimisticRevision, 1);
  assert.equal(state.status?.packs[0]?.state, 'approved');

  const handPlacedState = seededState({
    packs: [samplePackRow({ name: 'hand-pack', dir: '/tmp/packs/hand-pack', isPlacedByHand: true })],
    panels: [
      {
        viewId: 'pack:hand-pack:main',
        id: 'main',
        pack: 'hand-pack',
        label: 'Hand',
        entryUrl: '/packs/hand-pack/index.html',
        iconUrl: null,
        reads: [],
        acts: [],
      },
    ],
    launchers: [],
  });
  applyOptimisticPackFolderRemove(handPlacedState, '/tmp/packs/hand-pack');
  assert.equal(handPlacedState.optimisticRevision, 1);
  assert.equal(handPlacedState.status?.packs.length, 0);
  assert.equal(handPlacedState.status?.panels.length, 0);

  const sourceRemoveState = seededState();
  applyOptimisticPackSourceRemove(sourceRemoveState, 'example-packs');
  assert.equal(sourceRemoveState.optimisticRevision, 1);
  assert.equal(sourceRemoveState.status?.sources.length, 0);
  assert.equal(sourceRemoveState.status?.packs.length, 0);
  assert.equal(sourceRemoveState.status?.panels.length, 0);
  assert.equal(sourceRemoveState.status?.launchers.length, 0);

  const handPlacedSourceRemoveState = seededState({
    packs: [samplePackRow({ name: 'alpha-pack', isPlacedByHand: true })],
  });
  applyOptimisticPackSourceRemove(handPlacedSourceRemoveState, 'example-packs');
  assert.equal(handPlacedSourceRemoveState.status?.sources.length, 0);
  assert.equal(handPlacedSourceRemoveState.status?.packs.length, 1);
  assert.equal(handPlacedSourceRemoveState.status?.panels.length, 1);
  assert.equal(handPlacedSourceRemoveState.status?.launchers.length, 1);

  const disableState = seededState();
  applyOptimisticPackSourceEnable(disableState, 'example-packs', 'alpha-pack', false);
  assert.equal(disableState.optimisticRevision, 1);
  assert.equal(disableState.status?.sources[0]?.packs[0]?.isEnabled, false);
  assert.equal(disableState.status?.packs.length, 0);
  assert.equal(disableState.status?.panels.length, 0);

  applyOptimisticPackSourceEnable(disableState, 'example-packs', 'alpha-pack', true);
  assert.equal(disableState.optimisticRevision, 2);
  assert.equal(disableState.status?.sources[0]?.packs[0]?.isEnabled, true);
});
