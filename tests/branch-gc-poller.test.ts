import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasGit, git } from './helpers/git-fixture.ts';
import { createBranchGcPoller } from '../server/branch-gc-poller.ts';
import type { BranchGcGitWorkspace } from '../server/branch-gc-poller.ts';
import { createBranchGcWiring } from '../server/branch-gc-wiring.ts';
import { DAY_MS } from '../server/core/branch-gc-core.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';

const NOW_MS = Date.parse('2026-08-25T12:00:00Z');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const IDENTICAL_TREE_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function unreachableGitWorkspace(): BranchGcGitWorkspace {
  const refuse = () => Promise.reject(new Error('the faked poller never touches git'));
  return {
    fetchOrigin: refuse,
    listRemoteBranches: refuse,
    listIntegrationTips: refuse,
    isAncestor: refuse,
    resolveMergeProbeEnv: refuse,
    writeMergedTree: refuse,
    treeOid: refuse,
    deleteRemoteBranch: refuse,
    listWorktrees: refuse,
    probeWorktreeDirty: refuse,
    removeWorktreeByPath: refuse,
  };
}

function branchGcGitWorkspace(overrides: Partial<BranchGcGitWorkspace> = {}): BranchGcGitWorkspace {
  return {
    async fetchOrigin() { return { ok: true }; },
    async listRemoteBranches() { return { ok: true, branches: [] }; },
    async listIntegrationTips() { return { ok: true, integrationTips: [{ branch: 'main', sha: 'main-sha' }] }; },
    async isAncestor() { return { ok: true, isAncestor: false }; },
    async resolveMergeProbeEnv() { return { ok: true, probeEnv: {} }; },
    async writeMergedTree() { return { ok: true, out: IDENTICAL_TREE_OID, outcome: 'tree' }; },
    async treeOid() { return { ok: true, out: IDENTICAL_TREE_OID }; },
    async deleteRemoteBranch() { return { ok: true }; },
    async listWorktrees() { return []; },
    async probeWorktreeDirty() { return { ok: true, dirty: false }; },
    async removeWorktreeByPath() { return { ok: true }; },
    ...overrides,
  };
}

test('skips missing and non-git projects without failing the lane, and stays skipped while they stay broken', async () => {
  const warnings: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const projectPathsFetched: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchGcGitWorkspace({
      async fetchOrigin({ projectPath }) {
        projectPathsFetched.push(projectPath);
        if (projectPath === '/missing') return { ok: false, err: 'ENOENT: no such file or directory' };
        if (projectPath === '/not-a-repo') return { ok: false, err: 'fatal: not a git repository' };
        return { ok: true };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/missing' }, { path: '/not-a-repo' }, { path: '/repo' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: (message) => { warnings.push(message); } },
    onTickComplete: (status) => statuses.push(status),
    statProjectPath: async (target) => {
      if (target.startsWith('/missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (target === '/not-a-repo/.git') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {};
    },
  });

  await poller.tick();
  await poller.tick();

  assert.deepEqual(projectPathsFetched, ['/missing', '/not-a-repo', '/repo', '/repo']);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings, [
    '[branch-gc] skipping /missing: ENOENT: no such file or directory',
    '[branch-gc] skipping /not-a-repo: fatal: not a git repository',
  ]);
  for (const status of statuses) {
    const projects = status.projects;
    assert.ok(Array.isArray(projects));
    assert.ok(projects.every((project) => isRecord(project) && project.errors === 0));
  }
});

test('a skipped project resumes on the tick after its repository comes back', async () => {
  const warnings: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const projectPathsFetched: string[] = [];
  let repoIsBack = false;
  const poller = createBranchGcPoller({
    gitWorkspace: branchGcGitWorkspace({
      async fetchOrigin({ projectPath }) {
        projectPathsFetched.push(projectPath);
        if (!repoIsBack) return { ok: false, err: 'ENOENT: no such file or directory' };
        return { ok: true };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/unmounted' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: (message) => { warnings.push(message); } },
    decisionTrace: (entry) => { traces.push(entry); },
    statProjectPath: async () => {
      if (!repoIsBack) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {};
    },
  });

  await poller.tick();
  await poller.tick();
  assert.deepEqual(projectPathsFetched, ['/unmounted']);

  repoIsBack = true;
  await poller.tick();
  await poller.tick();

  assert.deepEqual(projectPathsFetched, ['/unmounted', '/unmounted', '/unmounted']);
  assert.deepEqual(warnings, [
    '[branch-gc] skipping /unmounted: ENOENT: no such file or directory',
    '[branch-gc] resuming /unmounted: the git repository is back',
  ]);
  assert.equal(traces.filter((entry) => entry.decision === 'resumed').length, 1);
});

test('a fetch error in a project that still exists keeps failing the tick instead of silencing it', async () => {
  const warnings: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const projectPathsFetched: string[] = [];
  const poller = createBranchGcPoller({
    gitWorkspace: branchGcGitWorkspace({
      async fetchOrigin({ projectPath }) {
        projectPathsFetched.push(projectPath);
        return { ok: false, err: 'error: cannot open .git/FETCH_HEAD: No such file or directory' };
      },
    }),
    getConfig: () => ({ projects: [{ path: '/live' }] }),
    liveSessionIds: () => new Set(),
    liveWorktreePaths: () => new Set(),
    log: { warn: (message) => { warnings.push(message); } },
    onTickComplete: (status) => statuses.push(status),
    statProjectPath: async () => ({}),
  });

  await poller.tick();

  assert.deepEqual(projectPathsFetched, ['/live']);
  assert.ok(warnings.some((message) => message.includes('fetch failed in /live')));
  assert.ok(warnings.some((message) => message.includes('poll failed')));
  const firstStatus = statuses[0];
  assert.ok(firstStatus);
  const projects = firstStatus.projects;
  assert.ok(Array.isArray(projects));
  const firstProject = projects[0];
  assert.ok(isRecord(firstProject));
  assert.equal(firstProject.errors, 1);
});

test('the lane wiring deletes unmerged branches only when branchGc.deleteUnmerged is exactly true', async () => {
  const deleteUnmergedByConfiguredValue: (boolean | undefined)[] = [];
  for (const deleteUnmerged of [undefined, false, true]) {
    const wiring = createBranchGcWiring({
      config: { branchGc: { deleteUnmerged }, projects: [] },
      gitWorkspace: unreachableGitWorkspace(),
      liveSessionIds: () => new Set<string>(),
      liveWorktreePaths: () => new Set<string>(),
      createPoller: (deps) => {
        deleteUnmergedByConfiguredValue.push(deps.deleteUnmerged);
        return { start: async () => {}, stop: async () => {}, tick: async () => {} };
      },
    });
    wiring.start();
    await new Promise((resolve) => setImmediate(resolve));
    await wiring.stop();
  }
  assert.deepEqual(deleteUnmergedByConfiguredValue, [false, false, true]);
});

function initRepoWithOrigin(): { repo: string; origin: string } {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-branch-gc-origin-'));
  try { git(['init', '--bare', '-b', 'main'], origin); } catch { git(['init', '--bare'], origin); }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-branch-gc-repo-'));
  try { git(['init', '-b', 'main'], repo); } catch { git(['init'], repo); }
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Glimmervoid Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  return { repo, origin };
}

test('a dry run tick leaves the admin entry of a hand-deleted worktree on disk', { skip: !hasGit() }, async () => {
  const { repo, origin } = initRepoWithOrigin();
  const vanishedWorktree = path.join(repo, '.claude', 'worktrees', 'agent-gone');
  const adminDir = path.join(repo, '.git', 'worktrees');
  try {
    fs.mkdirSync(path.dirname(vanishedWorktree), { recursive: true });
    git(['worktree', 'add', '-b', 'worktree-agent-gone', vanishedWorktree], repo);
    const adminEntriesBefore = fs.readdirSync(adminDir);
    fs.rmSync(vanishedWorktree, { recursive: true, force: true });
    const statuses: Record<string, unknown>[] = [];
    const poller = createBranchGcPoller({
      gitWorkspace: createGitWorkspace(),
      getConfig: () => ({ integrationBranch: 'main', projects: [{ path: repo }] }),
      liveSessionIds: () => new Set(),
      liveWorktreePaths: () => new Set(),
      dryRun: true,
      prefixes: ['worktree-agent-'],
      now: () => NOW_MS,
      log: { warn: () => {} },
      onTickComplete: (status) => statuses.push(status),
    });

    await poller.tick();

    const [project] = (statuses[0]?.projects ?? []) as Record<string, unknown>[];
    const worktreesKept = project?.worktreesKept as { branch: string; reason: string }[];
    assert.deepEqual(worktreesKept.map(({ branch, reason }) => ({ branch, reason })), [
      { branch: 'worktree-agent-gone', reason: 'missing-directory' },
    ]);
    assert.deepEqual(fs.readdirSync(adminDir), adminEntriesBefore);
    assert.equal(git(['worktree', 'list', '--porcelain'], repo).includes('worktree-agent-gone'), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  }
});

async function deletionsAfterTick({ branchIds, configuredProjectIds, injectedLiveSessionIds }: {
  branchIds: string[];
  configuredProjectIds: string[];
  injectedLiveSessionIds: string[];
}): Promise<string[]> {
  const deletedBranches: string[] = [];
  const gitWorkspace = branchGcGitWorkspace({
    async listRemoteBranches() {
      return {
        ok: true,
        branches: branchIds.map((branchId) => ({
          name: `glimmervoid/session/${branchId}`,
          tipSha: `${branchId}-sha`,
          tipCommitTimeMs: NOW_MS - DAY_MS,
        })),
      };
    },
    async listIntegrationTips() {
      return { ok: true, integrationTips: [{ branch: 'develop', sha: 'develop-sha' }] };
    },
    async isAncestor() {
      return { ok: true, isAncestor: true };
    },
    async deleteRemoteBranch({ name }) {
      deletedBranches.push(name);
      return { ok: true };
    },
  });
  const poller = createBranchGcPoller({
    gitWorkspace,
    getConfig: () => ({
      integrationBranch: 'develop',
      projects: configuredProjectIds.map((projectId) => ({ id: projectId, path: '/repo' })),
    }),
    liveSessionIds: () => new Set(injectedLiveSessionIds),
    liveWorktreePaths: () => new Set(),
    now: () => NOW_MS,
  });

  await poller.tick();

  return deletedBranches;
}

test('keeps a merged branch whose id is only in the injected live session ids', async () => {
  const deletedBranches = await deletionsAfterTick({
    branchIds: ['injected-session'],
    configuredProjectIds: ['project-uuid'],
    injectedLiveSessionIds: ['injected-session'],
  });

  assert.deepEqual(deletedBranches, []);
});

test('git helpers delete a remote ref with no-verify while retaining normalized protected refs', async () => {
  const calls: { args: string[]; cwd: string; extra?: { maxBuffer?: number } }[] = [];
  const gitWorkspace = createGitWorkspace({
    git: async (args, cwd, extra) => {
      calls.push({ args, cwd, extra });
      if (args[0] === 'for-each-ref' && args[1] === 'refs/remotes/origin/') {
        return [
          'refs/remotes/origin/HEAD main-sha 1700000000 refs/remotes/origin/main',
          'refs/remotes/origin/glimmervoid/session/abc abc-sha 1700000000 ',
          'refs/remotes/origin/worktree-agent-123 agent-sha 1700000100 ',
          'refs/remotes/origin/release/x release-sha 1700000200 ',
        ].join('\n');
      }
      if (args[0] === 'for-each-ref') {
        return [
          'refs/remotes/origin/develop develop-sha',
          'refs/heads/main main-sha',
        ].join('\n');
      }
      if (args[0] === 'merge-base') {
        const error: Error & { code?: number } = new Error('not an ancestor');
        error.code = 1;
        throw error;
      }
      return '';
    },
  });

  const branches = await gitWorkspace.listRemoteBranches({ projectPath: '/repo', prefixes: ['glimmervoid/session/', 'worktree-agent-'] });
  const tips = await gitWorkspace.listIntegrationTips({ projectPath: '/repo', integrationBranch: 'develop' });
  const ancestor = await gitWorkspace.isAncestor({
    projectPath: '/repo',
    ancestorSha: 'abc-sha',
    descendantSha: 'develop-sha',
  });
  await gitWorkspace.fetchOrigin({ projectPath: '/repo' });
  await gitWorkspace.deleteRemoteBranch({ projectPath: '/repo', name: 'glimmervoid/session/abc', tipSha: 'abc-sha', cause: 'session' });

  assert.deepEqual(branches, {
    ok: true,
    branches: [
      { name: 'glimmervoid/session/abc', tipSha: 'abc-sha', tipCommitTimeMs: 1700000000000 },
      { name: 'worktree-agent-123', tipSha: 'agent-sha', tipCommitTimeMs: 1700000100000 },
    ],
  });
  assert.deepEqual(tips, {
    ok: true,
    integrationTips: [
      { branch: 'develop', sha: 'develop-sha' },
      { branch: 'main', sha: 'main-sha' },
      { branch: 'master', sha: null },
    ],
  });
  assert.deepEqual(ancestor, { ok: true, isAncestor: false });
  assert.ok(calls.some(({ args }) => args.join(' ') === 'fetch --prune origin'));
  assert.ok(calls.some(({ args }) => args.join(' ') === 'for-each-ref refs/remotes/origin/ --format=%(refname) %(objectname) %(committerdate:unix) %(symref)'));
  assert.equal(calls.find(({ args }) => args[0] === 'for-each-ref' && args[1] === 'refs/remotes/origin/')?.extra?.maxBuffer, 64 * 1024 * 1024);
  assert.ok(calls.some(({ args }) => args.join(' ') === 'push --no-verify origin --force-with-lease=refs/heads/glimmervoid/session/abc:abc-sha :refs/heads/glimmervoid/session/abc'));
});
