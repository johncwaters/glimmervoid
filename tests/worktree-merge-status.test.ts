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
  let landedExpectedHeadSha: string | null | undefined;
  run.gitWorkspace.mergeKeep = async (args) => { mergeKeepCalls += 1; landedExpectedHeadSha = args.expectedHeadSha; return { merged: true }; };
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
  assert.equal(landedExpectedHeadSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: run.projectPath }).toString().trim());
  run.cleanup();
});

test('a gate refusal that settles while another push merges leaves that merge marked as merging', async () => {
  const run = lifecycleWithHeldMerge();
  execFileSync('git', ['init', '--quiet'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'start'], { cwd: run.projectPath });
  let mergeKeepCalls = 0;
  const heldMergeKeep = run.gitWorkspace.mergeKeep;
  run.gitWorkspace.mergeKeep = (args) => { mergeKeepCalls += 1; return heldMergeKeep(args); };
  const verdictReleases: Array<(verdict: { allowed: true } | { allowed: false; reason: string }) => void> = [];
  run.lifecycle.setMergeGate(() => new Promise((resolve) => { verdictReleases.push(resolve); }));
  const untilGatesOpened = async (count: number) => { while (verdictReleases.length < count) await new Promise((resolve) => setImmediate(resolve)); };
  const firstPush = run.lifecycle.mergeAndContinue();
  const secondPush = run.lifecycle.mergeAndContinue();
  await untilGatesOpened(2);
  verdictReleases[0]({ allowed: true });
  while (run.lifecycle.snapshot().mergeStatus !== 'merging') await new Promise((resolve) => setImmediate(resolve));
  verdictReleases[1]({ allowed: false, reason: 'checks failed: unit' });
  const pushRefusedByTheGate = await Promise.race([firstPush, secondPush]);
  assert.equal(pushRefusedByTheGate.reason, 'merge-in-progress');
  assert.equal(run.lifecycle.snapshot().mergeStatus, 'merging');
  const thirdPush = await run.lifecycle.mergeAndContinue();
  assert.equal(thirdPush.reason, 'merge-in-progress');
  assert.equal(mergeKeepCalls, 1);
  run.releaseMerge({ merged: true });
  await Promise.all([firstPush, secondPush]);
  run.cleanup();
});

function gatedRepo(checks: Array<{ id: string; command: string }>, { ephemeral = false, timeoutSeconds = 300 } = {}) {
  const run = lifecycleWithHeldMerge();
  execFileSync('git', ['init', '--quiet'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'start'], { cwd: run.projectPath });
  const landing = { mergeKeepCalls: 0 };
  run.gitWorkspace.mergeKeep = async () => { landing.mergeKeepCalls += 1; return { merged: true }; };
  const verification = createVerificationWiring({
    getVerificationConfig: () => ({ repos: { [run.projectPath]: { checks, timeoutSeconds, gate: { enabled: true } } } }),
    isSessionSandboxOn: () => false,
    broadcastControl: () => {},
    logger: console,
  });
  verification.attachSession({
    id: 'merge-status-test',
    path: run.projectPath,
    ephemeral,
    hasOwnWorktree: true,
    worktreeDir: run.projectPath,
    on: () => {},
    worktreeLifecycle: run.lifecycle,
  });
  return { run, landing, verification };
}

test('a spawned child session push is refused while a required check fails', async () => {
  const { run, landing } = gatedRepo([{ id: 'unit', command: 'node does-not-exist.js' }], { ephemeral: true });
  const refused = await run.lifecycle.mergeAndContinue({ force: true });
  assert.equal(refused.reason, 'checks failed: unit');
  assert.equal(landing.mergeKeepCalls, 0);
  run.cleanup();
});

test('a pending Coherence journal does not count as uncommitted work at the merge gate', async () => {
  const { run, landing } = gatedRepo([{ id: 'unit', command: 'node --version' }]);
  fs.mkdirSync(path.join(run.projectPath, '.coherence', 'journal'), { recursive: true });
  fs.writeFileSync(path.join(run.projectPath, '.coherence', 'journal', 'turn.jsonl'), '{}\n');
  const landed = await run.lifecycle.mergeAndContinue({ force: true });
  assert.equal(landed.merged, true);
  assert.equal(landing.mergeKeepCalls, 1);
  run.cleanup();
});

test('an uncommitted edit under .coherence outside its record stores counts as uncommitted work at the merge gate', async () => {
  const { run, landing } = gatedRepo([{ id: 'gate', command: 'node .coherence/gate.js' }]);
  fs.mkdirSync(path.join(run.projectPath, '.coherence'), { recursive: true });
  fs.writeFileSync(path.join(run.projectPath, '.coherence', 'gate.js'), 'process.exit(1);\n');
  execFileSync('git', ['add', '.'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'gate'], { cwd: run.projectPath });
  fs.writeFileSync(path.join(run.projectPath, '.coherence', 'gate.js'), 'process.exit(0);\n');
  const refused = await run.lifecycle.mergeAndContinue({ force: true });
  assert.match(String(refused.reason), /^uncommitted changes/);
  assert.equal(landing.mergeKeepCalls, 0);
  run.cleanup();
});

test('a check that outlives its timeout through a grandchild is reported as timed out without waiting for the grandchild', { skip: process.platform === 'win32' }, async () => {
  const { run, landing } = gatedRepo([{ id: 'slow', command: 'node slow-check.js' }], { timeoutSeconds: 5 });
  fs.writeFileSync(path.join(run.projectPath, 'slow-check.js'), "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });\nsetTimeout(() => {}, 60000);\n");
  execFileSync('git', ['add', '.'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'slow check'], { cwd: run.projectPath });
  const startedAtMs = Date.now();
  const refused = await run.lifecycle.mergeAndContinue({ force: true });
  assert.ok(Date.now() - startedAtMs < 15000, `the gate waited ${Date.now() - startedAtMs} ms`);
  assert.match(String(refused.reason), /slow/);
  assert.equal(landing.mergeKeepCalls, 0);
  run.cleanup();
});

test('stopping verification kills a running check and the processes it started', { skip: process.platform === 'win32' }, async () => {
  const { run, verification } = gatedRepo([{ id: 'slow', command: 'node slow-check.js' }]);
  const grandchildPidFile = path.join(run.projectPath, 'grandchild.pid');
  fs.writeFileSync(path.join(run.projectPath, 'slow-check.js'), `const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });\nrequire('node:fs').writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));\nsetTimeout(() => {}, 60000);\n`);
  fs.writeFileSync(path.join(run.projectPath, '.gitignore'), 'grandchild.pid\n');
  execFileSync('git', ['add', '.'], { cwd: run.projectPath });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'slow check'], { cwd: run.projectPath });
  const pendingPush = run.lifecycle.mergeAndContinue({ force: true });
  const deadlineMs = Date.now() + 10000;
  while (!fs.existsSync(grandchildPidFile) && Date.now() < deadlineMs) await new Promise((resolve) => setTimeout(resolve, 50));
  const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'));
  verification.stop();
  await pendingPush;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
  run.cleanup();
});
