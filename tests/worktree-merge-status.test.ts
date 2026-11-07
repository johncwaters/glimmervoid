import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionWorktreeLifecycle } from '../session/session-worktree-lifecycle.ts';
import { STATES, type SessionState } from '../shared/states.ts';
import type { GitWorkspace, MergeResult } from '../session/worktree/worktree-lifecycle-context.ts';

function lifecycleWithHeldMerge() {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-merge-status-'));
  let sessionState: SessionState = STATES.IDLE;
  let releaseMerge: (outcome: MergeResult) => void = () => {};
  const heldMerge = () => new Promise<MergeResult>((resolve) => { releaseMerge = resolve; });
  const gitWorkspace: GitWorkspace = {
    create: () => { throw new Error('not used'); },
    populate: () => {},
    hasUnmergedWork: () => true,
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
      pasteText: () => ({ ok: true }),
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

test('a merge outcome lands even when the agent exits while the merge runs', async () => {
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
});
