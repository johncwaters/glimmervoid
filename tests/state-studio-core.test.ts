import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessageOf } from '../shared/contracts/control-messages.ts';
import {
  INITIAL_STUDIO_STATE,
  applyOptimisticFolderSet,
  applyOptimisticRepoBranchAgent,
  applyStudioServerMessage,
} from '../public/state/studio-core.ts';
import type { StudioCollectionState } from '../public/state/studio-core.ts';

function freshState(): StudioCollectionState {
  return structuredClone(INITIAL_STUDIO_STATE);
}

function boxesReply(overrides: Partial<ServerMessageOf<'codemap-boxes-of-response'>> = {}): ServerMessageOf<'codemap-boxes-of-response'> {
  return {
    type: 'codemap-boxes-of-response',
    id: 'orch-1',
    requestId: 'r1',
    ok: true,
    boardId: 'board-1',
    boxesBySessionId: {
      'branch-1': {
        boxIdByPath: { 'src/a.ts': 'box-a' },
        fallbackBoxId: 'box-root',
        changedBoxIds: ['box-a'],
      },
    },
    areas: [
      {
        repoKey: 'repo-1',
        repoName: 'shop',
        repoDir: '/repos/shop',
        isFolded: true,
        anchorBoxId: 'cm-251002-area-card-b5aa82e0',
        mapError: null,
        branchAgentId: 'claude-code',
      },
    ],
    boxRectById: { 'box-a': { x: 10, y: 20, width: 100, height: 60 } },
    boxChoices: [{ boxId: 'box-a', title: 'src/a', repoName: 'shop' }],
    isMapFailed: false,
    error: null,
    ...overrides,
  };
}

test('studio-core reconciles boxes, keyed lookups, digests, session removal, and optimistic overlays', () => {
  const state = freshState();

  applyStudioServerMessage(state, {
    type: 'session-added',
    id: 'orch-1',
    session: 'Orchestrator',
    path: '/studio',
    agent: 'claude-code',
    state: 'IDLE',
    stateSince: 1,
    skipPerms: false,
    saneYolo: true,
    worktree: false,
    resumeSessionId: null,
    isStudioMain: true,
    seq: 1,
  });
  assert.equal(state.shownSessionId, 'orch-1');

  applyStudioServerMessage(state, { type: 'director-digest-kept', id: 'orch-1', seq: 2 });
  assert.equal(state.digestRevisionBySessionId['orch-1'], 1);

  applyStudioServerMessage(state, boxesReply(), { watchedSessionIds: new Set(['orch-1', 'branch-1']) });
  assert.equal(state.boardId, 'board-1');
  assert.equal(state.areaByRepoKey['repo-1']?.repoName, 'shop');
  assert.equal(state.boxChoiceById['box-a']?.title, 'src/a');
  assert.deepEqual(state.changingSessionIdsByBoxId['box-a'], ['branch-1']);
  assert.deepEqual(state.changedBoxIds, ['box-a']);

  applyOptimisticFolderSet(state, 'cm-251002-area-a37e7778', true);
  assert.equal(state.areas[0]?.isFolded, false);
  assert.equal(state.areaByRepoKey['repo-1']?.isFolded, false);

  applyStudioServerMessage(
    state,
    { type: 'codemap-folder-set-result', id: 'orch-1', requestId: 'f1', ok: true, isOpen: false, error: null, appliedSeq: 3 },
    { confirmedFolderBoxId: 'cm-251002-area-a37e7778' },
  );
  assert.equal(state.areas[0]?.isFolded, true);

  applyOptimisticRepoBranchAgent(state, '/repos/shop', 'codex');
  assert.equal(state.areas[0]?.branchAgentId, 'codex');
  assert.equal(state.areaByRepoKey['repo-1']?.branchAgentId, 'codex');

  applyStudioServerMessage(state, {
    type: 'director-digests-result',
    id: 'orch-1',
    requestId: 'r2',
    ok: true,
    verdictByKey: {
      'dir-1': { chatLine: 'Done', digest: 'Updated a', fitsTask: true, misfit: null },
    },
    progressAnswers: [{ sessionId: 'orch-1', askedAt: 100, question: 'Status?', answer: 'Green' }],
    error: null,
  });
  assert.equal(state.verdictByKey['dir-1']?.digest, 'Updated a');
  assert.equal(state.progressAnswers.length, 1);

  applyStudioServerMessage(
    state,
    { type: 'studio-main-ensure-result', id: 'anchor-1', requestId: 'm1', ok: true, mainId: 'orch-2', error: null, appliedSeq: 4 },
    { liveSessionIds: new Set(['orch-1', 'orch-2']) },
  );
  assert.equal(state.shownSessionId, 'orch-2');
  assert.equal(state.pendingMainId, null);

  applyStudioServerMessage(state, { type: 'session-removed', id: 'orch-2', session: 'orch-2', seq: 5 });
  assert.equal(state.shownSessionId, null);
  assert.equal(state.boardId, null);
  assert.deepEqual(state.areas, []);
  assert.equal(state.digestRevisionBySessionId['orch-2'], undefined);

  applyStudioServerMessage(state, boxesReply({ id: 'orch-2', ok: false, error: 'gone' }));
  assert.equal(state.shownSessionId, null);

  applyStudioServerMessage(state, { type: 'session-removed', id: 'orch-1', session: 'orch-1', seq: 6 });
  assert.equal(state.digestRevisionBySessionId['orch-1'], undefined);
});
