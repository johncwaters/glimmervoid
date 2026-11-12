import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionWorktreeLifecycle } from '../session/session-worktree-lifecycle.ts';
import { STATES, type SessionState } from '../shared/states.ts';
import type { GitWorkspace, MergeResult } from '../session/worktree/worktree-lifecycle-context.ts';

function lifecycleWithHeldMerge(hasUnmergedWork = true) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-merge-status-'));
  let sessionState: SessionState = STATES.IDLE;
  let releaseMerge: (outcome: MergeResult) => void = () => {};
  const heldMerge = () => new Promise<MergeResult>((resolve) => { releaseMerge = resolve; });
  const gitWorkspace: GitWorkspace = {
    create: () => { throw new Error('not used'); },
    populate: () => {},
    hasUnmergedWork: () => hasUnmergedWork,
    discard: () => {},
    mergeBack: heldMerge,
    mergeKeep: heldMerge,
    rebaseOnly: async () => ({ rebased: false }),
  };
  const lifecycle = createSessionWorktreeLifecycle({
    id: 'merge-status-test',
    projectPath,
    gitWorkspace,
    autoRebase: false,
    port: {
      state: () => ({ state: sessionState, isDestroyed: false, isTeardownPending: false, hasLivePty: true }),
      emit: () => {},
      recordDecision: () => {},
      deliver: () => ({ ok: true, kind: "pasted" }),
    },
  });
  lifecycle.adoptWorktree({ worktreeDir: projectPath, branch: 'session-branch', base: 'main', watch: false, emit: false });
  return {
    lifecycle,
    exitAgent: () => { sessionState = STATES.DONE; },
    releaseMerge: (outcome: MergeResult) => releaseMerge(outcome),
    cleanup: () => fs.rmSync(projectPath, { recursive: true, force: true }),
  };
}

test('a merge outcome lands whether the agent stays alive or exits while the merge runs', async () => {
  const parkedRun = lifecycleWithHeldMerge();
  const parkedMerge = parkedRun.lifecycle.mergeAndContinue();
  parkedRun.exitAgent();
  await parkedRun.lifecycle.settleOnExit();
  parkedRun.releaseMerge({ merged: false, parked: true, reason: 'conflict', conflicts: ['a.ts'] });
  await parkedMerge;
  assert.equal(parkedRun.lifecycle.snapshot().mergeStatus, 'parked');
  assert.deepEqual(parkedRun.lifecycle.snapshot().mergeConflicts, ['a.ts']);
  parkedRun.cleanup();

  const mergedRun = lifecycleWithHeldMerge();
  const fullMerge = mergedRun.lifecycle.mergeWorktree();
  mergedRun.exitAgent();
  await mergedRun.lifecycle.settleOnExit();
  mergedRun.releaseMerge({ merged: true });
  await fullMerge;
  assert.equal(mergedRun.lifecycle.snapshot().mergeStatus, 'merged');
  mergedRun.cleanup();

  const discardedRun = lifecycleWithHeldMerge(false);
  const mergeDuringDiscard = discardedRun.lifecycle.mergeWorktree();
  discardedRun.exitAgent();
  await discardedRun.lifecycle.settleOnExit();
  discardedRun.releaseMerge({ merged: true });
  await mergeDuringDiscard;
  assert.equal(discardedRun.lifecycle.snapshot().mergeStatus, 'merged');
  discardedRun.cleanup();

  const liveRun = lifecycleWithHeldMerge();
  const liveMerge = liveRun.lifecycle.mergeWorktree();
  liveRun.releaseMerge({ merged: true });
  await liveMerge;
  assert.equal(liveRun.lifecycle.snapshot().mergeStatus, 'merged');
  liveRun.cleanup();
});
