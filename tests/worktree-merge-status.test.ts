import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createSessionWorktreeLifecycle } from '../session/session-worktree-lifecycle.ts';
import { STATES, type SessionState } from '../shared/states.ts';
import type { GitWorkspace, MergeResult } from '../session/worktree/worktree-lifecycle-context.ts';
import { createVerificationWiring } from '../server/verification/verification-wiring.ts';

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
    projectPath,
    gitWorkspace,
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

test('a push is refused until the required checks pass on the current tree, naming the failing check', async () => {
  const run = lifecycleWithHeldMerge();
  execFileSync('git', ['init', '--quiet'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'start'], { cwd: run.projectPath });
  let mergeKeepCalls = 0;
  run.gitWorkspace.mergeKeep = async () => { mergeKeepCalls += 1; return { merged: true }; };
  let checkCommand = 'node does-not-exist.js';
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [run.projectPath]: { checks: [{ id: 'unit', command: checkCommand }], gate: { enabled: true } } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    logger: console,
  });
  verification.attachSession({
    id: 'merge-status-test',
    path: run.projectPath,
    ephemeral: false,
    hasOwnWorktree: true,
    worktreeDir: run.projectPath,
    on: () => {},
    worktreeLifecycle: run.lifecycle,
  });

  const refused = await run.lifecycle.mergeAndContinue({ force: true });
  assert.equal(refused.merged, false);
  assert.equal(refused.reason, 'checks failed: unit');
  assert.equal(mergeKeepCalls, 0);

  checkCommand = 'node --version';
  fs.writeFileSync(path.join(run.projectPath, 'changed.txt'), 'new tree\n');
  const dirtyRefusal = await run.lifecycle.mergeAndContinue({ force: true });
  assert.match(String(dirtyRefusal.reason), /^uncommitted changes/);
  execFileSync('git', ['add', '.'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'change'], { cwd: run.projectPath });
  const landed = await run.lifecycle.mergeAndContinue({ force: true });
  assert.equal(landed.merged, true);
  assert.equal(mergeKeepCalls, 1);
  run.cleanup();
});
