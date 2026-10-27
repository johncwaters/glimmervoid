import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execFileAsync } from '../server/child-process-safe.ts';

import { createGitWorkspace, createGitWorkspaceSync } from '../server/git/git-workspace.ts';
import type { WorkspaceHandle } from '../server/git/git-workspace.ts';
import { comparableDirectoryPath, isSameDirectoryPath } from '../shared/canonical-paths.ts';
import { hasGit, git } from './helpers/git-fixture.ts';

function makeNodeModulesJunction(projectPath: string, wtDir: string): boolean {
  execFileSync('cmd', ['/c', 'mklink', '/J', path.join(wtDir, 'node_modules'), path.join(projectPath, 'node_modules')], { stdio: 'ignore' });
  return fs.existsSync(path.join(wtDir, 'node_modules'));
}

const GIT = hasGit();
const WIN = process.platform === 'win32';

function branchOf(workspace: WorkspaceHandle): string {
  if (!workspace.branch) throw new Error('this worktree carries no branch');
  return workspace.branch;
}

function initRepoOnMain(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { git(['init', '-b', 'main'], dir); } catch { git(['init'], dir); }
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Glimmervoid Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
  return dir;
}

function initRepoOnDevelop(): string {
  const dir = initRepoOnMain('glimmervoid-sess-');
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  return dir;
}

function initRepoMainOnly(): string {
  return initRepoOnMain('glimmervoid-mainonly-');
}

function initRepoMainWithDevelop(): { dir: string; developSha: string } {
  const dir = initRepoOnMain('glimmervoid-base-');
  git(['branch', 'develop'], dir);
  git(['checkout', 'develop'], dir);
  fs.writeFileSync(path.join(dir, 'on-develop.txt'), 'dev\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'develop only'], dir);
  const developSha = git(['rev-parse', 'develop'], dir).trim();
  git(['checkout', 'main'], dir);
  return { dir, developSha };
}


test('untrusted staging and removal run git with hooks pointed at the null device and only the supplied env, on the serialized queue', async () => {
  const calls: Array<{ args: string[]; cwd: string; replaceEnv?: Record<string, string> }> = [];
  const gitWorkspace = createGitWorkspace({
    git: (args, cwd, extra) => {
      calls.push({ args, cwd, replaceEnv: extra?.replaceEnv });
      return '';
    },
  });
  const sha = 'a'.repeat(40);
  const replaceEnv = { PATH: '/usr/bin', CI: '1' };
  const hookless = ['-c', `core.hooksPath=${os.devNull}`];
  const staging = gitWorkspace.stageDetachedWorktree({ owner: 'lane:test', projectPath: '/repo', worktreePath: '/checks', sha, disableHooks: true, replaceEnv });
  const removal = gitWorkspace.removeWorktreeByPath({ projectPath: '/repo', cwd: '/checks', disableHooks: true, replaceEnv, cause: 'session' });
  const pruning = gitWorkspace.pruneWorktrees({ projectPath: '/repo', disableHooks: true, replaceEnv });
  assert.equal((await staging).ok, true);
  assert.equal((await removal).ok, true);
  assert.equal((await pruning).ok, true);
  assert.deepEqual(calls, [
    { args: [...hookless, 'worktree', 'add', '--detach', '/checks', sha], cwd: '/repo', replaceEnv },
    { args: [...hookless, 'worktree', 'remove', '--force', '/checks'], cwd: '/repo', replaceEnv },
    { args: [...hookless, 'worktree', 'list', '--porcelain'], cwd: '/repo', replaceEnv },
    { args: [...hookless, 'worktree', 'prune'], cwd: '/repo', replaceEnv },
    { args: [...hookless, 'worktree', 'list', '--porcelain'], cwd: '/repo', replaceEnv },
    { args: [...hookless, 'worktree', 'prune'], cwd: '/repo', replaceEnv },
  ]);
});

test('stageDetachedWorktree refuses a non-lowercase full sha without running git', async () => {
  const calls: string[][] = [];
  const gitWorkspace = createGitWorkspace({ git: (args) => { calls.push(args); return ''; } });
  const staged = await gitWorkspace.stageDetachedWorktree({ owner: 'lane:test', projectPath: '/repo', worktreePath: '/stage', sha: 'A'.repeat(40) });
  assert.equal(staged.ok, false);
  assert.deepEqual(calls, []);
});

test('stageIsolatedCheckout refuses a non-lowercase full sha or base sha without running git', async () => {
  const calls: string[][] = [];
  const gitWorkspace = createGitWorkspace({ git: (args) => { calls.push(args); return ''; } });
  const badSha = await gitWorkspace.stageIsolatedCheckout({ projectPath: '/repo', checkoutPath: '/stage', sha: 'A'.repeat(40), baseSha: 'b'.repeat(40) });
  const badBase = await gitWorkspace.stageIsolatedCheckout({ projectPath: '/repo', checkoutPath: '/stage', sha: 'a'.repeat(40), baseSha: 'main' });
  assert.equal(badSha.ok, false);
  assert.equal(badBase.ok, false);
  assert.deepEqual(calls, []);
});

test('stageIsolatedCheckout does not import refs or remotes from configured Git templates', { skip: !GIT }, async (context) => {
  const repo = initRepoOnMain('glimmervoid-isolated-');
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = git(['rev-parse', 'HEAD'], repo).trim();
  const templateDir = path.join(repo, 'template');
  fs.mkdirSync(path.join(templateDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(templateDir, 'refs', 'heads', 'leaked'), `${sha}\n`);
  fs.writeFileSync(path.join(templateDir, 'config'), '[remote "origin"]\nurl = https://example.com/repo.git\n');
  const checkoutPath = path.join(repo, 'checkout');
  const gitWorkspace = createGitWorkspace({
    git: async (args, cwd) => {
      const { stdout } = await execFileAsync('git', ['-c', `init.templateDir=${templateDir}`, ...args], { cwd, encoding: 'utf8' });
      return stdout;
    },
  });
  const staged = await gitWorkspace.stageIsolatedCheckout({ projectPath: repo, checkoutPath, sha, baseSha: sha });
  assert.equal(staged.ok, true, staged.err ?? 'checkout staging failed');
  assert.equal(git(['remote'], checkoutPath).trim(), '');
  assert.deepEqual(git(['for-each-ref', '--format=%(refname)'], checkoutPath).trim().split('\n'), ['refs/benchmark/base', 'refs/heads/review']);
});

test('stageIsolatedCheckout refuses an existing destination without changing its repository', { skip: !GIT }, async (context) => {
  const repo = initRepoOnMain('glimmervoid-isolated-existing-');
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sha = git(['rev-parse', 'HEAD'], repo).trim();
  const staged = await createGitWorkspace({}).stageIsolatedCheckout({ projectPath: repo, checkoutPath: repo, sha, baseSha: sha });
  assert.equal(staged.ok, false);
  assert.match(staged.err ?? '', /EEXIST/);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], repo).trim(), 'main');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'objects', 'info', 'alternates')), false);
});

test('discardSessionBranch removes a dead session worktree and branch so the same session id starts again from the current base', { skip: !GIT }, async (context) => {
  const repo = initRepoOnMain('glimmervoid-discard-session-');
  const worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-discard-session-wt-'));
  context.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreeBase, { recursive: true, force: true });
  });
  const gitWorkspace = createGitWorkspace({});
  const sessionArgs = { projectPath: repo, owner: 'lane:test', teamId: 'session', label: 'factory-work-0000beef', baseBranch: 'main', worktreeBase };
  const first = await gitWorkspace.create(sessionArgs);
  assert.equal(first.isGit, true);
  fs.writeFileSync(path.join(repo, 'merged.txt'), 'merged\n', 'utf8');
  git(['add', 'merged.txt'], repo);
  git(['commit', '-m', 'merged ticket'], repo);
  const currentBase = git(['rev-parse', 'HEAD'], repo).trim();
  assert.equal((await gitWorkspace.create(sessionArgs)).reason, 'branch-in-use');
  const discarded = await gitWorkspace.discardSessionBranch({ projectPath: repo, teamId: 'session', label: 'factory-work-0000beef', worktreeBase });
  assert.equal(discarded.ok, true, discarded.err ?? 'discard failed');
  const second = await gitWorkspace.create(sessionArgs);
  assert.equal(second.isGit, true);
  assert.equal(second.baseSha, currentBase);
  assert.equal((await gitWorkspace.discardSessionBranch({ projectPath: repo, teamId: 'session', label: 'factory-work-missing', worktreeBase })).ok, true);
});

test('discardSessionBranch refuses an operator worktree or the main checkout holding the session branch and leaves both untouched', { skip: !GIT }, async (context) => {
  const repo = initRepoOnMain('glimmervoid-discard-foreign-');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-discard-foreign-scratch-'));
  context.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const gitWorkspace = createGitWorkspace({});
  const worktreeBase = path.join(scratch, 'worktrees');
  const sessionArgs = { projectPath: repo, teamId: 'session', label: 'factory-work-0000beef', worktreeBase };
  const created = await gitWorkspace.create({ owner: 'lane:test', ...sessionArgs, baseBranch: 'main' });
  const sessionBranch = branchOf(created);
  git(['worktree', 'remove', '--force', created.cwd], repo);
  const operatorWorktree = path.join(scratch, 'operator-salvage');
  git(['worktree', 'add', operatorWorktree, sessionBranch], repo);
  fs.writeFileSync(path.join(operatorWorktree, 'salvaged-fix.ts'), 'export const salvaged = true;\n', 'utf8');
  const operatorRefusal = await gitWorkspace.discardSessionBranch(sessionArgs);
  assert.equal(operatorRefusal.ok, false);
  assert.match(operatorRefusal.err ?? '', /operator-salvage/);
  assert.equal(fs.existsSync(path.join(operatorWorktree, 'salvaged-fix.ts')), true);
  git(['worktree', 'remove', '--force', operatorWorktree], repo);
  git(['checkout', sessionBranch], repo);
  fs.mkdirSync(path.join(scratch, 'shared-node-modules'));
  fs.symlinkSync(path.join(scratch, 'shared-node-modules'), path.join(repo, 'node_modules'), 'junction');
  const mainCheckoutRefusal = await gitWorkspace.discardSessionBranch(sessionArgs);
  assert.equal(mainCheckoutRefusal.ok, false);
  assert.match(mainCheckoutRefusal.err ?? '', /main checkout/);
  assert.equal(fs.lstatSync(path.join(repo, 'node_modules')).isSymbolicLink(), true);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), sessionBranch);
});

test('mergeFastForwardTo refuses an invalid target sha without running git', async () => {
  const calls: string[][] = [];
  const gitWorkspace = createGitWorkspace({ git: (args) => { calls.push(args); return ''; } });
  const merged = await gitWorkspace.mergeFastForwardTo({ projectPath: '/repo', expectedHead: 'a'.repeat(40), sha: 'b'.repeat(39) });
  assert.equal(merged.ok, false);
  assert.equal(merged.outcome, 'invalid-target-sha');
  assert.deepEqual(calls, []);
});

test('resetKeepTo refuses an invalid target sha without running git', async () => {
  const calls: string[][] = [];
  const gitWorkspace = createGitWorkspace({ git: (args) => { calls.push(args); return ''; } });
  const reset = await gitWorkspace.resetKeepTo({ projectPath: '/repo', sha: 'c'.repeat(39) });
  assert.equal(reset.ok, false);
  assert.deepEqual(calls, []);
});

test('mergeKeep (real git): lands on develop yet keeps the worktree alive for a second round', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'cont', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);

    fs.writeFileSync(path.join(ws.cwd, 'a.js'), 'one\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'round 1'], ws.cwd);
    const r1 = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r1.merged, true);
    assert.equal(r1.kept, true);
    assert.ok(fs.existsSync(path.join(repo, 'a.js')), 'round 1 landed on develop');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'session branch preserved');
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'worktree clean after merge');
    const developTip = git(['rev-parse', 'develop'], repo).trim();
    assert.equal(git(['rev-parse', branchOf(ws)], repo).trim(), developTip, 'develop == session branch tip');
    assert.equal(r1.baseSha, developTip, 'baseSha reports the new develop tip the worktree sits on');

    fs.writeFileSync(path.join(ws.cwd, 'b.js'), 'two\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'round 2'], ws.cwd);
    const r2 = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r2.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'b.js')), 'round 2 landed on develop too');
    assert.ok(fs.existsSync(path.join(repo, 'a.js')), 'round 1 file still present on develop');
    assert.ok(fs.existsSync(ws.cwd), 'worktree still alive after the second merge');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeKeep (real git): committed work merges; uncommitted work is preserved, never landed on develop', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'split', baseBranch: 'develop' });

    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'shipped\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'committed.js')), 'committed work landed on develop');
    assert.ok(!fs.existsSync(path.join(repo, 'wip.js')), 'uncommitted work did NOT land on develop');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives in the worktree');

    assert.equal(fs.readFileSync(path.join(ws.cwd, 'wip.js'), 'utf8').replace(/\r\n/g, '\n'), 'work in progress\n', 'restored intact');
    assert.ok(git(['status', '--porcelain'], ws.cwd).includes('wip.js'), 'and it is still uncommitted after the merge');
    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeKeep (real git): restores its own saved work when another stash entry lands on the shared stack mid-merge', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    let hasOtherSessionStashed = false;
    const gw = createGitWorkspace({
      git: (args, cwd) => {
        const isRebaseStart = args.includes('rebase') && !args.includes('--abort');
        if (isRebaseStart && !hasOtherSessionStashed) {
          fs.writeFileSync(path.join(repo, 'other-session.js'), 'other session work\n', 'utf8');
          git(['stash', 'push', '--include-untracked', '-m', 'other-session'], repo);
          hasOtherSessionStashed = true;
        }
        return git(args, cwd);
      },
    });
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'stackrace', baseBranch: 'develop' });

    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'shipped\n', 'utf8');
    git(['add', 'committed.js'], ws.cwd); git(['commit', '-m', 'committed work'], ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const r = await gw.mergeKeep({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(hasOtherSessionStashed, true);
    assert.equal(r.merged, true);
    assert.equal(r.restoreConflict, false);
    assert.equal(fs.readFileSync(path.join(ws.cwd, 'wip.js'), 'utf8').replace(/\r\n/g, '\n'), 'work in progress\n');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'other-session.js')), 'another session\'s stash never lands in this worktree');

    const stashSubjects = git(['stash', 'list', '--format=%gs'], repo).trim().split('\n');
    assert.equal(stashSubjects.length, 1, 'only the other entry remains on the stack');
    assert.match(stashSubjects[0], /: other-session$/);
    assert.equal(git(['show', 'stash@{0}^3:other-session.js'], repo).replace(/\r\n/g, '\n'), 'other session work\n');
    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): only-uncommitted work cannot merge and is preserved (parked)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'wiponly', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'wip\n', 'utf8');

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved (uncommitted work is never destroyed)');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'the uncommitted file survives');
    assert.ok(!fs.existsSync(path.join(repo, 'wip.js')), 'nothing landed on develop');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): Coherence journals land with committed work, other uncommitted files park without a commit', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'mixed', baseBranch: 'develop' });
    const activityPath = path.join('.coherence', 'runs', 'x.jsonl');
    const decisionPath = path.join('.coherence', 'journal', 'x.jsonl');
    const committedActivity = '{"event":"start"}\n';
    const committedDecision = '{"decision":"keep session journals"}\n';
    fs.mkdirSync(path.join(ws.cwd, '.coherence', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(ws.cwd, '.coherence', 'journal'), { recursive: true });
    fs.writeFileSync(path.join(ws.cwd, activityPath), committedActivity, 'utf8');
    fs.writeFileSync(path.join(ws.cwd, decisionPath), committedDecision, 'utf8');
    fs.writeFileSync(path.join(ws.cwd, 'committed.js'), 'done\n', 'utf8');
    git(['add', 'committed.js', '.coherence'], ws.cwd);
    git(['commit', '-m', 'committed work and journals'], ws.cwd);
    const sessionCommit = git(['rev-parse', 'HEAD'], ws.cwd).trim();
    const uncommittedActivity = '{"event":"stop"}\n';
    const uncommittedDecision = '{"decision":"commit journals with work"}\n';
    fs.appendFileSync(path.join(ws.cwd, activityPath), uncommittedActivity, 'utf8');
    fs.appendFileSync(path.join(ws.cwd, decisionPath), uncommittedDecision, 'utf8');
    fs.writeFileSync(path.join(ws.cwd, '.coherence', 'runs', 'subagent.jsonl'), '{"event":"subagent-stop"}\n', 'utf8');
    fs.writeFileSync(path.join(ws.cwd, 'wip.js'), 'work in progress\n', 'utf8');
    git(['add', 'wip.js'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'uncommitted-changes');
    assert.equal(r.committed, false);
    assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), sessionCommit);
    assert.ok(fs.existsSync(ws.cwd), 'worktree preserved (never torn down while dirty)');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'wip.js')), 'uncommitted work survives');
    assert.ok(!fs.existsSync(path.join(repo, 'committed.js')), 'nothing merged while dirty (commit/discard the wip first)');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'parked branch preserved');
    git(['reset', 'HEAD', '--', 'wip.js'], ws.cwd);
    fs.rmSync(path.join(ws.cwd, 'wip.js'));

    if (!WIN) {
      const journalLinkPath = path.join(ws.cwd, '.coherence', 'runs', 'link.jsonl');
      fs.symlinkSync('x.jsonl', journalLinkPath);
      const refusedLink = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
      assert.equal(refusedLink.reason, 'uncommitted-changes');
      assert.equal(refusedLink.parked, true);
      assert.equal(git(['rev-parse', 'HEAD'], ws.cwd).trim(), sessionCommit);
      fs.unlinkSync(journalLinkPath);
    }

    const hooksDirectory = path.join(repo, '.git', 'reject-commit-hooks');
    fs.mkdirSync(hooksDirectory);
    fs.writeFileSync(path.join(hooksDirectory, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(['config', 'core.hooksPath', hooksDirectory], repo);

    const merged = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(merged.reason, null);
    assert.equal(merged.merged, true);
    assert.equal(fs.readFileSync(path.join(repo, 'committed.js'), 'utf8'), 'done\n');
    assert.equal(git(['show', 'develop:.coherence/journal/x.jsonl'], repo).replace(/\r\n/g, '\n'), committedDecision + uncommittedDecision);
    assert.equal(git(['show', 'develop:.coherence/runs/x.jsonl'], repo).replace(/\r\n/g, '\n'), committedActivity + uncommittedActivity);
    assert.equal(git(['show', 'develop:.coherence/runs/subagent.jsonl'], repo).replace(/\r\n/g, '\n'), '{"event":"subagent-stop"}\n');
    assert.equal(git(['rev-list', '--count', `${sessionCommit}..develop`], repo).trim(), '1');
    assert.equal(git(['log', '-1', '--format=%s', 'develop'], repo).trim(), 'chore: record Coherence journal');
    assert.deepEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'develop'], repo).trim().split('\n'), [
      '.coherence/journal/x.jsonl', '.coherence/runs/subagent.jsonl', '.coherence/runs/x.jsonl',
    ]);
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed after journals land');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): a NEW committed file lands on develop via rebase+ff, worktree cleaned', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'abc', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop', 'worktree forks off the integration branch');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 42;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'add feature'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.equal(r.branch, null);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the committed file landed on develop');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim(), 'develop');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
    assert.equal(git(['branch', '--list', branchOf(ws)], repo).trim(), '', 'session branch deleted');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): rebases onto a moved develop, then ff (both commits present)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'm1', baseBranch: 'develop' });

    fs.writeFileSync(path.join(repo, 'other.js'), 'other\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'develop advances'], repo);

    fs.writeFileSync(path.join(ws.cwd, 'session.js'), 'session\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'session work'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'session.js')), 'session change landed on develop');
    assert.ok(fs.existsSync(path.join(repo, 'other.js')), 'the concurrent develop commit is preserved');
    assert.equal(git(['status', '--porcelain'], repo).trim(), '', 'working tree clean');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack (real git): a rebase conflict parks the branch and leaves develop untouched', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'base\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'seed conflict file'], repo);

    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'cflt', baseBranch: 'develop' });

    fs.writeFileSync(path.join(repo, 'conflict.txt'), 'develop-side\n', 'utf8');
    git(['add', '-A'], repo); git(['commit', '-m', 'develop edits'], repo);
    const developSha = git(['rev-parse', 'develop'], repo).trim();

    fs.writeFileSync(path.join(ws.cwd, 'conflict.txt'), 'session-side\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'conflicting'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, false);
    assert.equal(r.parked, true);
    assert.equal(r.reason, 'rebase-conflict');
    assert.ok(git(['branch', '--list', branchOf(ws)], repo).trim(), 'parked branch still exists');
    assert.ok(fs.existsSync(ws.cwd), 'parked worktree preserved for manual resolution');
    assert.equal(git(['rev-parse', 'develop'], repo).trim(), developSha, 'develop untouched by the failed merge');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], ws.cwd).trim(), branchOf(ws), 'worktree back on its branch (rebase aborted cleanly)');
    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): a committed but CLEAN worktree reports work (the branch -D hazard)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'ahead', baseBranch: 'develop' });
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), false,
      'a fresh worktree holds nothing: discardable');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 1;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'session work'], ws.cwd);
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'committing leaves the tree clean');

    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'a commit the integration branch lacks IS work');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): uncommitted changes report work; a merged-away branch does not', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'dirty', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'scratch.txt'), 'wip\n', 'utf8');
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'an untracked new file counts: it is usually the whole deliverable');

    fs.rmSync(path.join(ws.cwd, 'scratch.txt'));
    fs.writeFileSync(path.join(ws.cwd, 'landed.js'), 'module.exports = 2;\n', 'utf8');
    git(['add', '-A'], ws.cwd); git(['commit', '-m', 'work'], ws.cwd);
    git(['merge', '--ff-only', branchOf(ws)], repo);
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), false,
      'work already on the integration branch is not work: the empty worktree may be discarded');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): untracked Coherence journals alone are not work, a real file beside them is', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'journals', baseBranch: 'develop' });
    const workArgs = { projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' };
    for (const journal of ['runs', 'journal', 'work']) {
      fs.mkdirSync(path.join(ws.cwd, '.coherence', journal), { recursive: true });
      fs.writeFileSync(path.join(ws.cwd, '.coherence', journal, '22222222-2222-4222-8222-222222222222.jsonl'), '{}\n', 'utf8');
    }
    assert.equal(await gw.hasUnmergedWork(workArgs), false);
    assert.deepEqual((await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' })).map((worktree) => worktree.hasWork), [false]);
    assert.equal((await gw.probeWorktreeDirty({ projectPath: repo, cwd: ws.cwd, branch: branchOf(ws) })).dirty, false);

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'module.exports = 3;\n', 'utf8');
    assert.equal(await gw.hasUnmergedWork(workArgs), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): an unresolvable integration branch reports work (fails safe)', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'safe', baseBranch: 'develop' });

    git(['config', `branch.${ws.branch}.glimmervoid-integration`, 'no-such-branch'], repo);
    assert.equal(await gw.hasUnmergedWork({ projectPath: repo, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), true,
      'a failed rev-list keeps the worktree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('hasUnmergedWork: an unusable workspace (no branch, not a repo) reports work rather than guessing', async () => {
  const gw = createGitWorkspace({ git: () => { throw new Error('git must not be reached'); } });
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: null }), true);
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: { cwd: 'C:/wt', isGit: false, branch: 'b' } }), true);
  assert.equal(await gw.hasUnmergedWork({ projectPath: 'C:/proj', workspace: { cwd: 'C:/wt', isGit: true } }), true);
});

test('discard is junction-safe: the real node_modules survives worktree teardown', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP ME\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'nm', baseBranch: 'develop' });
    assert.equal(makeNodeModulesJunction(repo, ws.cwd), true, 'junction created');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'sentinel.txt')), 'junction resolves to the real node_modules');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });

    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt')), 'the REAL node_modules sentinel survived teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeBack is junction-safe: the real node_modules survives a successful merge, and the junction is never committed', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'sentinel.txt'), 'KEEP\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'nm2', baseBranch: 'develop' });
    makeNodeModulesJunction(repo, ws.cwd);
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', 'feature.js'], ws.cwd); git(['commit', '-m', 'feat'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'sentinel.txt')), 'real node_modules survived');
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the feature landed on develop');
    assert.equal(git(['ls-files', 'node_modules'], repo).trim(), '', 'the node_modules junction was never committed (gitignored)');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (baseBranch): forks off the named branch even when the main checkout is on another branch', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'x1', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, developSha, 'forked off develop HEAD, not main');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'on-develop.txt')), 'worktree contains the develop-only commit');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim(), 'main', 'operator checkout untouched (still on main)');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (baseBranch): a missing local integration branch is auto-created from local main', { skip: !GIT }, async () => {
  const repo = initRepoMainOnly();
  try {
    const mainSha = git(['rev-parse', 'main'], repo).trim();
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'x2', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, mainSha, 'new develop branch was seeded from main');
    assert.equal(git(['rev-parse', '--verify', '--quiet', 'refs/heads/develop'], repo).trim(), mainSha, 'local develop branch now exists, pointing at main');
    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (baseBranch): a missing local integration branch prefers an existing origin/<branch> remote-tracking ref over main', { skip: !GIT }, async () => {
  const repo = initRepoMainOnly();
  try {
    const firstSha = git(['rev-parse', 'main'], repo).trim();
    fs.writeFileSync(path.join(repo, 'second.txt'), 'second\n', 'utf8');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'second commit'], repo);
    const secondSha = git(['rev-parse', 'main'], repo).trim();
    assert.notEqual(firstSha, secondSha);
    git(['update-ref', 'refs/remotes/origin/develop', firstSha], repo);

    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'x3', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(ws.base, 'develop');
    assert.equal(ws.baseSha, firstSha, 'seeded from origin/develop, not the newer main');
    assert.equal(git(['rev-parse', '--verify', '--quiet', 'refs/heads/develop'], repo).trim(), firstSha);
    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (baseBranch): a branch name git refuses to create still returns reason:no-base-branch and creates no worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'x4', baseBranch: 'bad..name' });
    assert.equal(ws.isGit, false);
    assert.equal(ws.reason, 'no-base-branch');
    assert.equal(git(['worktree', 'list'], repo).trim().split(/\r?\n/).length, 1, 'no extra worktree created');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (real git): stamps the fork-base marker on the branch; branch delete drops it', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'mark1', baseBranch: 'develop' });
    assert.equal(ws.isGit, true);
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], repo).trim(), 'develop');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
    assert.throws(() => git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], repo), 'git drops branch.<name>.* config on branch delete');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): resolves integrationBranch from the marker, not the passed value, and computes hasWork against it', { skip: !GIT }, async () => {
  const { dir, developSha } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'markresolve', baseBranch: 'develop' });
    assert.equal(ws.baseSha, developSha, 'worktree HEAD sits exactly on develop, no extra commits');

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: 'main' });
    assert.equal(entry.integrationBranch, 'develop', 'resolved from the marker, not the passed integrationBranch');
    assert.equal(entry.hasWork, false, 'hasWork computed against the marker branch (develop), not the passed one (main)');

    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (real git): creating the same session branch twice returns branch-in-use on the second attempt', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws1 = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'dup2', baseBranch: 'develop' });
    assert.equal(ws1.isGit, true);

    const ws2 = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'dup2', baseBranch: 'develop' });
    assert.equal(ws2.isGit, false);
    assert.equal(ws2.reason, 'branch-in-use');

    assert.ok(isSameDirectoryPath(ws2.conflictPath, ws1.cwd),
      `conflictPath ${ws2.conflictPath} names the first worktree ${ws1.cwd}`);

    await gw.discard({ projectPath: repo, workspace: ws1, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('create (worktreeBase + shareList): worktree lives under the base and gets the gitignored context', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));

  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.omc/\n.env\n', 'utf8');
  git(['add', '.gitignore'], repo); git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.omc'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.omc', 'memory.json'), '{"k":1}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'ctx', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env', 'tracked.txt', '.absent'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd.startsWith(base), 'worktree lives under the configured base, not system-temp');
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'dep.txt')), 'node_modules junctioned in');
    assert.ok(fs.existsSync(path.join(ws.cwd, '.omc', 'memory.json')), '.omc junctioned in');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', '.env copied in');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'a NON-ignored entry is refused (no merge leak)');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules survived (junction-safe)');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'real .omc survived (junction-safe)');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('populate re-shares stripped junctions into a surviving worktree (adopt-after-failed-removal)', { skip: !GIT || !WIN }, async () => {
  const repo = initRepoOnDevelop();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n', 'utf8');
  git(['add', '.gitignore'], repo); git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  try {
    const gw = createGitWorkspace();
    const shareList = ['node_modules', '.env', 'tracked.txt'];
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'strip', baseBranch: 'develop',
      worktreeBase: base, shareList,
    });
    assert.equal(ws.isGit, true);

    fs.rmSync(path.join(ws.cwd, 'node_modules'), { recursive: false, force: true });
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'node_modules')), 'junction stripped');

    await gw.populate({ projectPath: repo, wtDir: ws.cwd, shareList });
    assert.ok(fs.existsSync(path.join(ws.cwd, 'node_modules', 'dep.txt')), 'junction re-shared');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', 'existing copy untouched');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'an entry git does not IGNORE is still refused');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules untouched');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function initRepoWithLocalContext(ignoreText = 'node_modules\n.omc\n.env\n') {
  const repo = initRepoOnDevelop();
  fs.writeFileSync(path.join(repo, '.gitignore'), ignoreText, 'utf8');
  git(['add', '.gitignore'], repo);
  git(['commit', '-m', 'ignore local context'], repo);
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'real dep\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.omc'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.omc', 'memory.json'), '{"k":1}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  return repo;
}

test('create (worktreeBase + shareList, POSIX): dirs are SYMLINKED in, files copied, and teardown never follows the link', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'posixctx', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env', 'tracked.txt', '.absent'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(ws.cwd.startsWith(base), 'worktree lives under the configured base');

    const linked = path.join(ws.cwd, 'node_modules');
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true, 'a shared DIR is a symlink, not a copy');
    assert.equal(fs.realpathSync(linked), fs.realpathSync(path.join(repo, 'node_modules')), 'and it points at the real one');
    assert.ok(fs.existsSync(path.join(linked, 'dep.txt')), 'the link resolves to the real content');
    assert.equal(fs.lstatSync(path.join(ws.cwd, '.omc')).isSymbolicLink(), true, '.omc symlinked in');
    assert.equal(fs.lstatSync(path.join(ws.cwd, '.env')).isSymbolicLink(), false, 'a shared FILE is copied, never linked');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', '.env copied in');
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'tracked.txt')), 'a NON-ignored entry is refused (no merge leak)');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });

    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'the REAL node_modules survived teardown');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'the REAL .omc survived teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('populate (POSIX): a link the share list no longer names is removed, never its target, and a listed link stays', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'retired', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc'],
    });
    assert.equal(fs.lstatSync(path.join(ws.cwd, 'node_modules')).isSymbolicLink(), true);

    await gw.populate({ projectPath: repo, wtDir: ws.cwd, shareList: ['.omc'] });

    assert.ok(!fs.existsSync(path.join(ws.cwd, 'node_modules')), 'the retired node_modules link is gone');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'the main checkout node_modules is untouched');
    assert.equal(fs.lstatSync(path.join(ws.cwd, '.omc')).isSymbolicLink(), true, 'a listed link stays');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mergeBack (POSIX): the shared symlink is never staged by `git add -A`, and the real dir survives the merge', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'posixstage', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc'],
    });
    assert.equal(fs.lstatSync(path.join(ws.cwd, 'node_modules')).isSymbolicLink(), true, 'symlink in place');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    assert.equal(git(['ls-files', 'node_modules', '.omc'], ws.cwd).trim(), '', '`git add -A` staged neither symlink');
    git(['commit', '-m', 'feat'], ws.cwd);

    const r = await gw.mergeBack({ projectPath: repo, workspace: ws, targetBranch: 'develop' });
    assert.equal(r.merged, true);
    assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'the feature landed on develop');
    assert.equal(git(['ls-files', 'node_modules', '.omc'], repo).trim(), '', 'nothing symlinked was ever committed');
    assert.ok(!fs.existsSync(ws.cwd), 'worktree removed');
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'real node_modules survived the merge teardown');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('create (shareList, POSIX): a trailing-slash ignore pattern cannot cover a symlink, so the share is refused', { skip: !GIT || WIN }, async () => {
  const repo = initRepoWithLocalContext('node_modules/\n.omc/\n.env\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-wtroot-'));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test',
      projectPath: repo, teamId: 'session', label: 'posixslash', baseBranch: 'develop',
      worktreeBase: base, shareList: ['node_modules', '.omc', '.env'],
    });
    assert.equal(ws.isGit, true);
    assert.ok(!fs.existsSync(path.join(ws.cwd, 'node_modules')), 'the unignorable link is removed, not left to be committed');
    assert.ok(!fs.existsSync(path.join(ws.cwd, '.omc')), 'same for .omc');
    assert.equal(fs.readFileSync(path.join(ws.cwd, '.env'), 'utf8'), 'SECRET=1\n', 'a COPIED file is unaffected: the pattern matches it either way');
    assert.equal(warnings.filter((w) => w.includes('not sharing')).length, 2, 'each refusal is named so the operator can fix their .gitignore');

    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'x\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    assert.equal(git(['ls-files', 'node_modules', '.omc'], ws.cwd).trim(), '', 'nothing outside the repo can be staged');

    await gw.discard({ projectPath: repo, workspace: ws, cause: 'session' });
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'dep.txt')), 'the real node_modules is untouched by the refusal');
    assert.ok(fs.existsSync(path.join(repo, '.omc', 'memory.json')), 'and so is the real .omc');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listSessionWorktrees flags uncommitted work; removeWorktreeByPath removes a specific worktree', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const clean = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'clean', baseBranch: 'develop' });
    const dirty = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'dirty', baseBranch: 'develop' });
    fs.writeFileSync(path.join(dirty.cwd, 'wip.js'), 'work in progress\n', 'utf8');

    const byId = Object.fromEntries(
      (await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' })).map((w) => [w.id, w]),
    );
    assert.equal(byId.clean.hasWork, false, 'a clean worktree has no work');
    assert.equal(byId.dirty.hasWork, true, 'uncommitted changes count as work');

    await gw.removeWorktreeByPath({ projectPath: repo, cwd: clean.cwd, branch: clean.branch, cause: 'session' });
    assert.ok(!fs.existsSync(clean.cwd), 'removeWorktreeByPath removes a specific worktree');
    assert.ok(fs.existsSync(path.join(dirty.cwd, 'wip.js')), 'the unmerged change is untouched');

    await gw.removeWorktreeByPath({ projectPath: repo, cwd: dirty.cwd, branch: dirty.branch, cause: 'session' });
    assert.ok(!fs.existsSync(dirty.cwd));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('an automatic removal keeps protected or freshly touched session work, journals each removal first, and skips one it cannot journal', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-removals-'));
  const journalPath = path.join(journalDir, 'removals.jsonl');
  const unwritableJournalPath = path.join(journalPath, 'removals.jsonl');
  let nowMs = Date.now();
  const removalGuard = { protectedSessionIds: () => new Set(['configured']), now: () => nowMs };
  const log = { warn: () => {} };
  try {
    const gw = createGitWorkspace({ removalGuard: { ...removalGuard, journalPath }, log });
    const configured = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'configured', baseBranch: 'develop' });
    const idle = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'idle', baseBranch: 'develop' });

    const keptConfigured = await gw.removeWorktreeByPath({ projectPath: repo, cwd: configured.cwd, branch: configured.branch, cause: 'branch-gc' });
    const keptFresh = await gw.removeWorktreeByPath({ projectPath: repo, cwd: idle.cwd, branch: idle.branch, cause: 'branch-gc' });
    assert.equal(keptConfigured.removalKept, 'protected-session');
    assert.equal(keptFresh.removalKept, 'recently-touched');
    assert.equal(fs.existsSync(idle.cwd), true);
    assert.equal(fs.existsSync(journalPath), false);

    nowMs += 25 * 60 * 60 * 1000;
    assert.equal((await gw.removeWorktreeByPath({ projectPath: repo, cwd: idle.cwd, branch: idle.branch, cause: 'branch-gc' })).ok, true);
    assert.equal(fs.existsSync(idle.cwd), false);
    const records = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ cause, kind, path: removedPath, sessionId }) => ({ cause, kind, removedPath, sessionId })), [
      { cause: 'branch-gc', kind: 'worktree', removedPath: idle.cwd, sessionId: 'idle' },
    ]);

    const unjournaled = createGitWorkspace({ removalGuard: { ...removalGuard, journalPath: unwritableJournalPath }, log });
    const refused = await unjournaled.removeWorktreeByPath({ projectPath: repo, cwd: configured.cwd, branch: configured.branch, cause: 'session' });
    assert.equal(refused.removalKept, 'removal-record-unwritten');
    assert.equal(fs.existsSync(configured.cwd), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(journalDir, { recursive: true, force: true });
  }
});

test('listWorktrees reports Claude agent worktree locks, dirtiness, tips, and preserves session listing', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const firstWorktree = path.join(repo, '.claude', 'worktrees', 'agent-one');
  const secondWorktree = path.join(repo, '.claude', 'worktrees', 'agent-two');
  try {
    fs.mkdirSync(path.dirname(firstWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-one', firstWorktree], repo);
    git(['worktree', 'add', '-b', 'worktree-agent-two', secondWorktree], repo);
    fs.writeFileSync(path.join(secondWorktree, 'dirty.txt'), 'dirty\n', 'utf8');
    git(['worktree', 'lock', firstWorktree], repo);
    const gitWorkspace = createGitWorkspace();
    const sessionListingBefore = await gitWorkspace.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    const sessionListingAfter = await gitWorkspace.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    assert.deepEqual(sessionListingAfter, sessionListingBefore);
    assert.deepEqual(listed.map((worktree) => ({ branch: worktree.branch, locked: worktree.locked, dirty: worktree.dirty })), [
      { branch: 'worktree-agent-one', locked: true, dirty: false },
      { branch: 'worktree-agent-two', locked: false, dirty: true },
    ]);
    assert.equal(listed[0]?.tipSha, git(['rev-parse', 'worktree-agent-one'], repo).trim());
    assert.deepEqual(await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['glimmervoid/session/'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' }), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listWorktrees emits a cwd a live session path can be compared against', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const worktreeParent = path.join(repo, '.claude', 'worktrees');
  const linkedParent = path.join(repo, 'linked-worktrees');
  try {
    fs.mkdirSync(worktreeParent, { recursive: true });
    fs.symlinkSync(worktreeParent, linkedParent, 'junction');
    const worktreeThroughLink = path.join(linkedParent, 'agent-linked');
    git(['worktree', 'add', '-b', 'worktree-agent-linked', worktreeThroughLink], repo);
    const gitWorkspace = createGitWorkspace();
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    assert.deepEqual(listed.map((worktree) => worktree.cwd), [await comparableDirectoryPath(worktreeThroughLink)]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listWorktrees never offers the main checkout even when it sits on a cleanup prefix', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const linkedWorktree = path.join(repo, '.claude', 'worktrees', 'agent-one');
  try {
    git(['branch', '-m', 'develop', 'worktree-agent-main-checkout'], repo);
    fs.mkdirSync(path.dirname(linkedWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-one', linkedWorktree], repo);
    const gitWorkspace = createGitWorkspace();
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'worktree-agent-main-checkout', configuredIntegrationBranch: 'worktree-agent-main-checkout' });
    assert.deepEqual(listed.map((worktree) => worktree.branch), ['worktree-agent-one']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listWorktrees reports a hand-deleted worktree as prunable and never prunes it', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const vanishedWorktree = path.join(repo, '.claude', 'worktrees', 'agent-gone');
  const adminDir = path.join(repo, '.git', 'worktrees');
  try {
    fs.mkdirSync(path.dirname(vanishedWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-gone', vanishedWorktree], repo);
    const adminEntriesBefore = fs.readdirSync(adminDir);
    fs.rmSync(vanishedWorktree, { recursive: true, force: true });
    const gitWorkspace = createGitWorkspace();
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    const relisted = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    assert.deepEqual(listed.map((worktree) => ({ branch: worktree.branch, prunable: worktree.prunable, dirty: worktree.dirty })), [
      { branch: 'worktree-agent-gone', prunable: true, dirty: null },
    ]);
    assert.deepEqual(relisted, listed);
    assert.deepEqual(fs.readdirSync(adminDir), adminEntriesBefore);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listWorktrees keeps a worktree whose directory is only temporarily gone', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const worktreeDir = path.join(repo, '.claude', 'worktrees', 'agent-unmounted');
  const parkedDir = path.join(repo, '.claude', 'parked');
  try {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-unmounted', worktreeDir], repo);
    fs.renameSync(worktreeDir, parkedDir);
    const gitWorkspace = createGitWorkspace();
    await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    fs.renameSync(parkedDir, worktreeDir);
    assert.equal(git(['rev-parse', '--is-inside-work-tree'], worktreeDir).trim(), 'true');
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    assert.deepEqual(listed.map((worktree) => ({ branch: worktree.branch, prunable: worktree.prunable, dirty: worktree.dirty })), [
      { branch: 'worktree-agent-unmounted', prunable: false, dirty: false },
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('the cleanup listing sees untracked files that status.showUntrackedFiles hides', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  const agentWorktree = path.join(repo, '.claude', 'worktrees', 'agent-untracked');
  try {
    fs.mkdirSync(path.dirname(agentWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-untracked', agentWorktree], repo);
    git(['config', 'status.showUntrackedFiles', 'no'], repo);
    fs.writeFileSync(path.join(agentWorktree, 'scratch.txt'), 'work in progress\n', 'utf8');
    const gitWorkspace = createGitWorkspace();
    const listed = await gitWorkspace.listWorktrees({ projectPath: repo, prefixes: ['worktree-agent-'], integrationBranch: 'develop', configuredIntegrationBranch: 'develop' });
    assert.deepEqual(listed.map((worktree) => ({ branch: worktree.branch, dirty: worktree.dirty })), [
      { branch: 'worktree-agent-untracked', dirty: true },
    ]);
    assert.deepEqual(await gitWorkspace.probeWorktreeDirty({ projectPath: repo, cwd: agentWorktree, branch: 'worktree-agent-untracked' }), {
      ok: true,
      dirty: true,
      headSha: git(['rev-parse', 'HEAD'], agentWorktree).trim(),
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('listSessionWorktrees flags a parked (committed-ahead) worktree as work even when its working tree is clean', { skip: !GIT }, async () => {
  const repo = initRepoOnDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repo, teamId: 'session', label: 'parked', baseBranch: 'develop' });
    fs.writeFileSync(path.join(ws.cwd, 'feature.js'), 'done\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);
    assert.equal(git(['status', '--porcelain'], ws.cwd).trim(), '', 'working tree is clean');

    const listed = await gw.listSessionWorktrees({ projectPath: repo, integrationBranch: 'develop' });
    assert.equal(listed[0].hasWork, true, 'commits ahead of develop count as work');
    await gw.removeWorktreeByPath({ projectPath: repo, cwd: ws.cwd, branch: ws.branch, cause: 'session' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function initRepoWithAbsorbedDevelop(): string {
  const dir = initRepoOnMain('glimmervoid-stale-marker-');
  git(['branch', 'develop'], dir);
  fs.writeFileSync(path.join(dir, 'landed.txt'), 'landed\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'landed on main after develop was abandoned'], dir);
  return dir;
}

test('listSessionWorktrees (real git): an unconfigured base migrates a marker whose branch main already absorbed', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'stale', baseBranch: 'develop' });
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(), 'develop');

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main', 'develop is an ancestor of main, so the base follows the default');
    assert.equal(entry.hasWork, false, 'hasWork computed against main, not the abandoned develop');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(), 'main', 'marker rewritten');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git, sync): the startup reconcile path migrates the stale marker too', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'stalesync', baseBranch: 'develop' });
    const [entry] = createGitWorkspaceSync().listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(), 'main');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): a marker whose branch holds commits main lacks is kept even when unconfigured', { skip: !GIT }, async () => {
  const { dir } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'keepmarker', baseBranch: 'develop' });
    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'develop', 'develop is not an ancestor of main, so retargeting would show its commits as session work');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(), 'develop');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('create (real git): a branch-in-use adoption with no configured base reports the migrated marker', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'inuse', baseBranch: 'develop' });
    const adopted = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'inuse', baseBranch: 'main', configuredIntegrationBranch: null });
    assert.equal(adopted.reason, 'branch-in-use');
    assert.equal(adopted.base, 'main');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasUnmergedWork (real git): an already-resolved base argument does not block the migration of a stale marker', { skip: !GIT }, async () => {
  const dir = initRepoWithAbsorbedDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'unmerged', baseBranch: 'develop' });
    assert.equal(
      await gw.hasUnmergedWork({ projectPath: dir, workspace: ws, integrationBranch: 'develop', configuredIntegrationBranch: null }),
      false,
      'the worktree holds nothing main lacks',
    );
    assert.equal(
      git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(),
      'main',
      'the resolved base argument is a fallback, never a configured branch that pins the marker',
    );
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSessionWorktrees (real git): a marker whose branch was deleted migrates to the detected default', { skip: !GIT }, async () => {
  const { dir } = initRepoMainWithDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: dir, teamId: 'session', label: 'gonebase', baseBranch: 'develop' });
    git(['branch', '-D', 'develop'], dir);
    fs.writeFileSync(path.join(ws.cwd, 'session.txt'), 'work\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);

    const [entry] = await gw.listSessionWorktrees({ projectPath: dir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'main', 'a marker that no longer resolves cannot measure anything');
    assert.equal(entry.hasWork, true, 'the commit counts against the default branch');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], dir).trim(), 'main');
    await gw.discard({ projectPath: dir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initCloneWithOriginOnlyDevelop(): { rootDir: string; repoDir: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-origin-marker-'));
  const seedDir = initRepoMainWithDevelop().dir;
  const remoteDir = path.join(rootDir, 'origin.git');
  const repoDir = path.join(rootDir, 'repository');
  git(['clone', '--bare', seedDir, remoteDir], rootDir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteDir);
  git(['clone', remoteDir, repoDir], rootDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Glimmervoid Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  git(['branch', 'develop', 'origin/develop'], repoDir);
  fs.rmSync(seedDir, { recursive: true, force: true });
  return { rootDir, repoDir };
}

test('listSessionWorktrees (real git): a marker branch alive only on origin keeps the marker', { skip: !GIT }, async () => {
  const { rootDir, repoDir } = initCloneWithOriginOnlyDevelop();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repoDir, teamId: 'session', label: 'originbase', baseBranch: 'develop' });
    git(['branch', '-D', 'develop'], repoDir);
    fs.writeFileSync(path.join(ws.cwd, 'session.txt'), 'work\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);

    const [entry] = await gw.listSessionWorktrees({ projectPath: repoDir, integrationBranch: null });
    assert.equal(entry.integrationBranch, 'develop', 'the base stays a plain branch name that a later create can fork from');
    assert.equal(entry.hasWork, true, 'the session commit is measured against the remote-tracking ref that resolved');
    assert.equal(git(['config', '--get', `branch.${ws.branch}.glimmervoid-integration`], repoDir).trim(), 'develop', 'marker left alone');
    assert.throws(
      () => git(['rev-parse', '--verify', '--quiet', 'refs/heads/origin/develop'], repoDir),
      Error,
      'no local branch was fabricated under the remote-tracking short name',
    );
    await gw.discard({ projectPath: repoDir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function initCloneWithPrefixedRemoteBranches(): { rootDir: string; repoDir: string; remoteDir: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-branch-gc-'));
  const seedDir = initRepoOnMain('glimmervoid-branch-gc-seed-');
  for (const branchName of ['worktree-agent-123', 'glimmervoid/session/abc', 'release/x']) git(['branch', branchName], seedDir);
  const remoteDir = path.join(rootDir, 'origin.git');
  const repoDir = path.join(rootDir, 'repository');
  git(['clone', '--bare', seedDir, remoteDir], rootDir);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteDir);
  git(['clone', remoteDir, repoDir], rootDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Glimmervoid Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  fs.rmSync(seedDir, { recursive: true, force: true });
  return { rootDir, repoDir, remoteDir };
}

test('hasUnmergedWork and both listSessionWorktrees (real git): commits pushed to origin main while local main is behind are landed', { skip: !GIT }, async () => {
  const { rootDir, repoDir } = initCloneWithPrefixedRemoteBranches();
  try {
    const gw = createGitWorkspace();
    const ws = await gw.create({ owner: 'lane:test', projectPath: repoDir, teamId: 'session', label: 'landedonorigin', baseBranch: 'main' });
    fs.writeFileSync(path.join(ws.cwd, 'session.txt'), 'work\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'session work'], ws.cwd);
    const workArgs = { projectPath: repoDir, workspace: ws, integrationBranch: 'main', configuredIntegrationBranch: null };
    assert.equal(await gw.hasUnmergedWork(workArgs), true);

    git(['push', 'origin', 'HEAD:main'], ws.cwd);
    assert.notEqual(git(['rev-parse', 'main'], repoDir).trim(), git(['rev-parse', 'origin/main'], repoDir).trim());

    assert.equal(await gw.hasUnmergedWork(workArgs), false);
    const [asyncEntry] = await gw.listSessionWorktrees({ projectPath: repoDir, integrationBranch: null });
    assert.equal(asyncEntry.hasWork, false);
    const [syncEntry] = createGitWorkspaceSync().listSessionWorktrees({ projectPath: repoDir, integrationBranch: null });
    assert.equal(syncEntry.hasWork, false);

    fs.writeFileSync(path.join(ws.cwd, 'more.txt'), 'more\n', 'utf8');
    git(['add', '-A'], ws.cwd);
    git(['commit', '-m', 'unpushed work'], ws.cwd);
    assert.equal(await gw.hasUnmergedWork(workArgs), true);
    await gw.discard({ projectPath: repoDir, workspace: ws, cause: 'session' });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('listRemoteBranches (real git): lists every prefixed remote branch and nothing else', { skip: !GIT }, async () => {
  const { rootDir, repoDir } = initCloneWithPrefixedRemoteBranches();
  try {
    const listed = await createGitWorkspace().listRemoteBranches({
      projectPath: repoDir,
      prefixes: ['glimmervoid/session/', 'worktree-agent-'],
    });
    if (!('branches' in listed)) throw new Error('listing a cloned repository returns branches');
    assert.deepEqual(listed.branches.map((remoteBranch) => remoteBranch.name).sort(), ['glimmervoid/session/abc', 'worktree-agent-123']);
    for (const remoteBranch of listed.branches) assert.match(remoteBranch.tipSha, /^[0-9a-f]{7,}$/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('deleteRemoteBranch (real git): a remote tip that moved after the listing is never deleted', { skip: !GIT }, async () => {
  const { rootDir, repoDir, remoteDir } = initCloneWithPrefixedRemoteBranches();
  try {
    const gitWorkspace = createGitWorkspace();
    const listedTipSha = git(['rev-parse', 'refs/remotes/origin/glimmervoid/session/abc'], repoDir).trim();
    fs.writeFileSync(path.join(repoDir, 'later.txt'), 'later\n', 'utf8');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'work pushed after the listing'], repoDir);
    git(['push', 'origin', 'HEAD:refs/heads/glimmervoid/session/abc'], repoDir);
    const movedTipSha = git(['rev-parse', 'HEAD'], repoDir).trim();

    const refused = await gitWorkspace.deleteRemoteBranch({ projectPath: repoDir, name: 'glimmervoid/session/abc', tipSha: listedTipSha, cause: 'session' });

    assert.equal(refused.ok, false);
    assert.equal(git(['rev-parse', 'refs/heads/glimmervoid/session/abc'], remoteDir).trim(), movedTipSha);

    const deleted = await gitWorkspace.deleteRemoteBranch({ projectPath: repoDir, name: 'glimmervoid/session/abc', tipSha: movedTipSha, cause: 'session' });

    assert.equal(deleted.ok, true);
    assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/glimmervoid/session/abc'], remoteDir), Error);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a session based on a pull request branch forks from its origin tip and a branch missing on origin is never seeded from main', { skip: !GIT }, async (context) => {
  const upstream = initRepoOnMain('glimmervoid-pr-upstream-');
  git(['checkout', '-b', 'feature/pr-branch'], upstream);
  fs.writeFileSync(path.join(upstream, 'feature.txt'), 'pr work\n', 'utf8');
  git(['add', '-A'], upstream);
  git(['commit', '-m', 'pr work'], upstream);
  const pullRequestHead = git(['rev-parse', 'HEAD'], upstream).trim();
  git(['checkout', 'main'], upstream);
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pr-checkout-'));
  git(['clone', '--quiet', upstream, checkout], os.tmpdir());
  const worktreeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pr-worktrees-'));
  context.after(() => {
    for (const dir of [upstream, checkout, worktreeBase]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const workspace = createGitWorkspace();

  const missing = await workspace.seedBranchFromOrigin({ projectPath: checkout, name: 'not-on-origin' });
  assert.equal(missing.ok, false);
  assert.equal(git(['branch', '--list', 'not-on-origin'], checkout).trim(), '');

  const seeded = await workspace.seedBranchFromOrigin({ projectPath: checkout, name: 'feature/pr-branch' });
  assert.equal(seeded.ok, true);
  assert.equal(seeded.out, pullRequestHead);
  const session = await workspace.create({ owner: 'lane:test', projectPath: checkout, teamId: 'session', label: 'pr-session', baseBranch: 'feature/pr-branch', worktreeBase });
  assert.equal(session.isGit, true);
  assert.equal(session.base, 'feature/pr-branch');
  assert.equal(git(['rev-parse', 'HEAD'], session.cwd).trim(), pullRequestHead);

  git(['checkout', 'feature/pr-branch'], upstream);
  fs.writeFileSync(path.join(upstream, 'feature.txt'), 'pr work pushed later\n', 'utf8');
  git(['commit', '-am', 'more pr work'], upstream);
  const fastForwardedHead = git(['rev-parse', 'HEAD'], upstream).trim();
  const fastForwarded = await workspace.seedBranchFromOrigin({ projectPath: checkout, name: 'feature/pr-branch' });
  assert.equal(fastForwarded.out, fastForwardedHead);
  assert.equal(git(['rev-parse', 'refs/heads/feature/pr-branch'], checkout).trim(), fastForwardedHead);

  fs.writeFileSync(path.join(upstream, 'feature.txt'), 'pr work rewritten\n', 'utf8');
  git(['commit', '--amend', '-am', 'rewritten pr work'], upstream);
  git(['checkout', 'main'], upstream);
  const forcePushed = await workspace.seedBranchFromOrigin({ projectPath: checkout, name: 'feature/pr-branch' });
  assert.equal(forcePushed.ok, false);
  assert.equal(git(['rev-parse', 'refs/heads/feature/pr-branch'], checkout).trim(), fastForwardedHead);
});

test('a checkout in the Glimmervoid home survives a git worktree prune run where its folder cannot be seen', { skip: !GIT }, async (context) => {
  const repo = initRepoOnMain('glimmervoid-lock-');
  const realGlimmervoidHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-lock-home-'));
  const glimmervoidHome = `${realGlimmervoidHome}-link`;
  fs.symlinkSync(realGlimmervoidHome, glimmervoidHome);
  context.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(glimmervoidHome, { force: true });
    fs.rmSync(realGlimmervoidHome, { recursive: true, force: true });
  });
  const workspace = createGitWorkspace({ glimmervoidHome });
  const controlCheckout = path.join(glimmervoidHome, 'factory', 'project', 'control');
  fs.mkdirSync(path.dirname(controlCheckout), { recursive: true });
  const sha = git(['rev-parse', 'HEAD'], repo).trim();
  assert.equal((await workspace.stageDetachedWorktree({ owner: 'lane:test', projectPath: repo, worktreePath: controlCheckout, sha })).ok, true);

  fs.renameSync(controlCheckout, `${controlCheckout}-out-of-sight`);
  git(['worktree', 'prune'], repo);
  assert.equal((await createGitWorkspace({ glimmervoidHome: repo }).pruneWorktrees({ projectPath: repo })).ok, true);
  fs.renameSync(`${controlCheckout}-out-of-sight`, controlCheckout);
  assert.equal(git(['rev-parse', 'HEAD'], controlCheckout).trim(), sha);

  fs.renameSync(realGlimmervoidHome, `${realGlimmervoidHome}-out-of-sight`);
  assert.equal((await workspace.pruneWorktrees({ projectPath: repo })).ok, true);
  fs.renameSync(`${realGlimmervoidHome}-out-of-sight`, realGlimmervoidHome);
  assert.equal(git(['rev-parse', 'HEAD'], controlCheckout).trim(), sha);

  fs.rmSync(path.dirname(controlCheckout), { recursive: true, force: true });
  assert.equal((await workspace.pruneWorktrees({ projectPath: repo })).ok, true);
  assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], repo), /control/);
});
