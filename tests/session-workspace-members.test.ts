import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { planWorkspace } from '../session/core/workspace-core.ts';
import { createSessionWorkspaceMembers } from '../session/session-workspace-members.ts';
import { Session } from '../session/sessions.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

function makeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Workspace Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), name);
  git(['add', '.'], repo);
  git(['commit', '-m', 'initial'], repo);
  return repo;
}

test('workspace member shell preserves existing maps, reports partial failure and keeps dirty directories', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-members-'));
  try {
    const first = makeRepo(root, 'first');
    const second = makeRepo(root, 'second');
    const planned = planWorkspace({ worktreeRoot: root, sessionName: 'Example', sessionId: '12345678-session', repoPaths: [first, second] });
    if (!planned.ok) throw new Error(planned.error);
    const gitWorkspace = createGitWorkspace();
    const shell = createSessionWorkspaceMembers({ plan: planned.plan, sessionName: 'Example', shareList: null, gitWorkspace });
    assert.equal((await shell.provision()).ok, true);
    const agentsPath = path.join(planned.plan.folder, 'AGENTS.md');
    const claudePath = path.join(planned.plan.folder, 'CLAUDE.md');
    assert.match(fs.readFileSync(agentsPath, 'utf8'), /first\//);
    assert.equal(fs.readFileSync(claudePath, 'utf8'), '@AGENTS.md\n');
    fs.writeFileSync(agentsPath, 'custom map\n');
    fs.writeFileSync(claudePath, 'custom pointer\n');
    assert.equal((await shell.provision()).ok, true);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), 'custom map\n');
    assert.equal(fs.readFileSync(claudePath, 'utf8'), 'custom pointer\n');

    fs.writeFileSync(path.join(planned.plan.members[1].dir, 'dirty.txt'), 'keep');
    const released = await shell.release();
    assert.deepEqual(released.keptDirs, [planned.plan.members[1].dir]);
    assert.equal(fs.existsSync(planned.plan.members[0].dir), false);
    assert.equal(fs.existsSync(planned.plan.members[1].dir), true);
    assert.equal(fs.existsSync(planned.plan.folder), true);
    assert.equal(git(['rev-parse', planned.plan.branch], first).trim().length, 40);

    fs.rmSync(path.join(planned.plan.members[1].dir, 'dirty.txt'));
    assert.deepEqual((await shell.release()).keptDirs, []);
    assert.equal(fs.existsSync(planned.plan.folder), false);
    assert.equal(git(['rev-parse', planned.plan.branch], second).trim().length, 40);

    const missing = path.join(root, 'missing');
    fs.mkdirSync(missing);
    const partialPlan = planWorkspace({ worktreeRoot: root, sessionName: 'Partial', sessionId: '87654321-session', repoPaths: [first, missing] });
    if (!partialPlan.ok) throw new Error(partialPlan.error);
    const partialShell = createSessionWorkspaceMembers({ plan: partialPlan.plan, sessionName: 'Partial', shareList: null, gitWorkspace });
    const partial = await partialShell.provision();
    assert.equal(partial.ok, false);
    assert.equal(fs.existsSync(partialPlan.plan.members[0].dir), true);
    assert.equal(fs.existsSync(path.join(partialPlan.plan.folder, 'AGENTS.md')), false);
    await partialShell.release();

    const racePlan = planWorkspace({ worktreeRoot: root, sessionName: 'Race', sessionId: '99999999-session', repoPaths: [first, second] });
    if (!racePlan.ok) throw new Error(racePlan.error);
    const raceShell = createSessionWorkspaceMembers({ plan: racePlan.plan, sessionName: 'Race', shareList: null, gitWorkspace });
    const pendingProvision = raceShell.provision();
    const pendingRelease = raceShell.release();
    assert.equal((await pendingProvision).ok, true);
    assert.deepEqual((await pendingRelease).keptDirs, []);
    assert.equal(fs.existsSync(racePlan.plan.folder), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace member release keeps a member whose removal git refuses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-refused-'));
  try {
    const planned = planWorkspace({ worktreeRoot: root, sessionName: 'Refused', sessionId: '55555555-session', repoPaths: [path.join(root, 'one'), path.join(root, 'two')] });
    if (!planned.ok) throw new Error(planned.error);
    for (const member of planned.plan.members) fs.mkdirSync(member.dir, { recursive: true });
    const removedDirs: string[] = [];
    const shell = createSessionWorkspaceMembers({ plan: planned.plan, sessionName: 'Refused', shareList: null, gitWorkspace: {
      ensureWorkspaceMember: async ({ projectPath }) => ({ cwd: projectPath, isGit: false, reason: 'not-git' }),
      removeWorkspaceMember: async ({ cwd }) => {
        if (cwd === planned.plan.members[0].dir) return { ok: false, out: '', err: 'contains modified or untracked files' };
        removedDirs.push(String(cwd));
        fs.rmSync(String(cwd), { recursive: true, force: true });
        return { ok: true, out: '' };
      },
    } });
    assert.deepEqual((await shell.release()).keptDirs, [planned.plan.members[0].dir]);
    assert.deepEqual(removedDirs, [planned.plan.members[1].dir]);
    assert.equal(fs.existsSync(planned.plan.members[0].dir), true);
    assert.equal(fs.existsSync(planned.plan.folder), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace session merge refuses because the folder is not a single-repo worktree', async () => {
  const session = new Session({
    id: 'workspace-session',
    name: 'Workspace',
    path: path.join(os.tmpdir(), 'ws-workspace-session'),
    workspaceRepos: [path.join(os.tmpdir(), 'one'), path.join(os.tmpdir(), 'two')],
    gitWorkspace: createGitWorkspace(),
  });
  assert.equal(session.isWorktree, false);
  assert.deepEqual(await session.mergeWorktree(), { merged: false, refused: true, reason: 'no-worktree' });
  session.destroy();
});

test('workspace session diff prefixes member paths and change checks announce member edits once', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-diff-'));
  const first = makeRepo(root, 'first');
  const second = makeRepo(root, 'second');
  const session = new Session({
    id: 'workspace-diff-session',
    name: 'Workspace Diff',
    path: path.join(root, 'ws-workspace-diff'),
    workspaceRepos: [first, second],
    gitWorkspace: createGitWorkspace(),
  });
  try {
    assert.equal(await session._provisionWorktree(), true);
    const changes: { sig: string }[] = [];
    session.on('worktree-changed', (change: { sig: string }) => changes.push(change));
    await session.checkWorktreeChange();
    await session.checkWorktreeChange();
    assert.equal(changes.length, 1);

    const [firstScope] = await session.getChangeScopes();
    fs.writeFileSync(path.join(firstScope.root, 'README.md'), 'edited');
    fs.writeFileSync(path.join(path.dirname(firstScope.root), 'second', 'added.txt'), 'new');
    await session.checkWorktreeChange();
    assert.equal(changes.length, 2);

    const diff = await session.getDiff();
    assert.match(diff.uncommitted.diff, /^diff --git a\/first\/README\.md b\/first\/README\.md$/m);
    assert.match(diff.uncommitted.diff, /^diff --git a\/second\/added\.txt b\/second\/added\.txt$/m);
    assert.deepEqual((await session.getChangeScopes()).map((scope) => scope.sessionPathPrefix), ['first/', 'second/']);
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace session diff prefixes member paths on rename headers', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-rename-'));
  const first = makeRepo(root, 'first');
  const second = makeRepo(root, 'second');
  const session = new Session({
    id: 'workspace-rename-session',
    name: 'Workspace Rename',
    path: path.join(root, 'ws-workspace-rename'),
    workspaceRepos: [first, second],
    gitWorkspace: createGitWorkspace(),
  });
  try {
    assert.equal(await session._provisionWorktree(), true);
    const [firstScope] = await session.getChangeScopes();
    git(['mv', 'README.md', 'GUIDE.md'], firstScope.root);

    const diff = await session.getDiff();
    assert.match(diff.uncommitted.diff, /^rename from first\/README\.md$/m);
    assert.match(diff.uncommitted.diff, /^rename to first\/GUIDE\.md$/m);
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace change checks announce each new member commit to the same file', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-commits-'));
  const first = makeRepo(root, 'first');
  const second = makeRepo(root, 'second');
  const session = new Session({
    id: 'workspace-commit-session',
    name: 'Workspace Commits',
    path: path.join(root, 'ws-workspace-commits'),
    workspaceRepos: [first, second],
    gitWorkspace: createGitWorkspace(),
  });
  try {
    assert.equal(await session._provisionWorktree(), true);
    const [firstScope] = await session.getChangeScopes();
    const changes: { sig: string }[] = [];
    session.on('worktree-changed', (change: { sig: string }) => changes.push(change));

    fs.writeFileSync(path.join(firstScope.root, 'a.ts'), 'export const turn = 1;');
    git(['add', 'a.ts'], firstScope.root);
    git(['commit', '-m', 'turn one'], firstScope.root);
    await session.checkWorktreeChange();
    assert.equal(changes.length, 1);

    fs.writeFileSync(path.join(firstScope.root, 'a.ts'), 'export const turn = 2;');
    git(['commit', '-am', 'turn two'], firstScope.root);
    await session.checkWorktreeChange();
    assert.equal(changes.length, 2);
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
