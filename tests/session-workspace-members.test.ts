import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { planWorkspace } from '../session/core/workspace-core.ts';
import { createSessionWorkspaceMembers } from '../session/session-workspace-members.ts';
import { carryWorktreeAcrossRecreate } from '../server/session/session-registry.ts';
import { Session } from '../session/sessions.ts';
import { git, hasGit } from './helpers/git-fixture.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { waitFor } from './helpers/wait-for.ts';

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
    const shell = createSessionWorkspaceMembers({ owner: 'lane:test', plan: planned.plan, sessionName: 'Example', shareList: null, gitWorkspace });
    assert.equal((await shell.provision()).ok, true);
    const agentsPath = path.join(planned.plan.folder, 'AGENTS.md');
    const claudePath = path.join(planned.plan.folder, 'CLAUDE.md');
    assert.match(fs.readFileSync(agentsPath, 'utf8'), /first\//);
    assert.equal(fs.readFileSync(claudePath, 'utf8'), '@AGENTS.md\n');
    const annotatedMap = fs.readFileSync(agentsPath, 'utf8').replace(/^(- first\/.*)$/m, '$1\nNOTE: first/ deploys to prod');
    fs.writeFileSync(agentsPath, annotatedMap);
    assert.equal((await shell.provision()).ok, true);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), annotatedMap);
    fs.writeFileSync(agentsPath, 'custom map\n');
    fs.writeFileSync(claudePath, 'custom pointer\n');
    assert.equal((await shell.provision()).ok, true);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), 'custom map\n');
    assert.equal(fs.readFileSync(claudePath, 'utf8'), 'custom pointer\n');

    fs.writeFileSync(path.join(planned.plan.members[1].dir, 'dirty.txt'), 'keep');
    const released = await shell.release();
    assert.deepEqual(released.kept, [{ path: planned.plan.members[1].dir, reason: 'uncommitted changes' }]);
    assert.equal(fs.existsSync(planned.plan.members[0].dir), false);
    assert.equal(fs.existsSync(planned.plan.members[1].dir), true);
    assert.equal(fs.existsSync(planned.plan.folder), true);
    assert.equal(git(['rev-parse', planned.plan.branch], first).trim().length, 40);

    fs.writeFileSync(path.join(planned.plan.folder, 'notes.md'), 'agent scratch');
    assert.deepEqual((await shell.release({ discardWork: true, keepRepoPaths: [path.join(root, 'replacement')] })).kept, []);
    assert.equal(fs.existsSync(path.join(planned.plan.folder, 'notes.md')), true);
    assert.deepEqual((await shell.release({ discardWork: true })).kept, []);
    assert.equal(fs.existsSync(planned.plan.folder), false);
    assert.equal(git(['rev-parse', planned.plan.branch], second).trim().length, 40);

    const missing = path.join(root, 'missing');
    fs.mkdirSync(missing);
    const partialPlan = planWorkspace({ worktreeRoot: root, sessionName: 'Partial', sessionId: '87654321-session', repoPaths: [first, missing] });
    if (!partialPlan.ok) throw new Error(partialPlan.error);
    const partialShell = createSessionWorkspaceMembers({ owner: 'lane:test', plan: partialPlan.plan, sessionName: 'Partial', shareList: null, gitWorkspace });
    const partial = await partialShell.provision();
    assert.equal(partial.ok, false);
    assert.equal(fs.existsSync(partialPlan.plan.members[0].dir), true);
    assert.equal(fs.existsSync(path.join(partialPlan.plan.folder, 'AGENTS.md')), false);
    await partialShell.release();

    const racePlan = planWorkspace({ worktreeRoot: root, sessionName: 'Race', sessionId: '99999999-session', repoPaths: [first, second] });
    if (!racePlan.ok) throw new Error(racePlan.error);
    const raceShell = createSessionWorkspaceMembers({ owner: 'lane:test', plan: racePlan.plan, sessionName: 'Race', shareList: null, gitWorkspace });
    const pendingProvision = raceShell.provision();
    const pendingRelease = raceShell.release();
    assert.equal((await pendingProvision).ok, true);
    assert.deepEqual((await pendingRelease).kept, []);
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
    const shell = createSessionWorkspaceMembers({ owner: 'lane:test', plan: planned.plan, sessionName: 'Refused', shareList: null, gitWorkspace: {
      ensureWorkspaceMember: async ({ projectPath }) => ({ cwd: projectPath, isGit: false, reason: 'not-git' }),
      describeWorkspaceMemberWork: async () => null,
      recordOwnedFolder: async () => {},
      forgetRemovedPath: async () => {},
      removeWorkspaceMember: async ({ cwd }) => {
        if (cwd === planned.plan.members[0].dir) return { ok: false, out: '', err: 'contains modified or untracked files' };
        removedDirs.push(String(cwd));
        fs.rmSync(String(cwd), { recursive: true, force: true });
        return { ok: true, out: '' };
      },
    } });
    assert.deepEqual((await shell.release()).kept, [{ path: planned.plan.members[0].dir, reason: 'contains modified or untracked files' }]);
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
  assert.equal(session.isWorkspace, true);
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
    assert.deepEqual(diff.bases.map((base) => [base.member, base.ref, base.sha]), [
      ['first', 'main', git(['rev-parse', 'main'], first).trim()],
      ['second', 'main', git(['rev-parse', 'main'], second).trim()],
    ]);
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

test('editing workspace repositories keeps shared members, releases dropped ones and refreshes the generated map', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-edit-'));
  const first = makeRepo(root, 'first');
  const second = makeRepo(root, 'second');
  const third = makeRepo(root, 'third');
  const folder = path.join(root, 'ws-workspace-edit');
  const sessionAt = (workspaceRepos: string[]) => new Session({ id: 'workspace-edit-session', name: 'Workspace Edit', path: folder, workspaceRepos, gitWorkspace: createGitWorkspace() });
  const before = sessionAt([first, second]);
  const after = sessionAt([first, third]);
  try {
    assert.equal(await before._provisionWorktree(), true);
    fs.writeFileSync(path.join(folder, 'first', 'in-progress.txt'), 'kept');
    before.destroy();
    await carryWorktreeAcrossRecreate(before, after);
    assert.equal(await after._provisionWorktree(), true);

    assert.equal(fs.readFileSync(path.join(folder, 'first', 'in-progress.txt'), 'utf8'), 'kept');
    assert.equal(fs.existsSync(path.join(folder, 'second')), false);
    assert.equal(fs.existsSync(path.join(folder, 'third', 'README.md')), true);
    assert.equal(git(['rev-parse', 'glimmervoid/workspace/workspace-edit-session'], second).trim().length, 40);
    const map = fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
    assert.match(map, /^- third\/: /m);
    assert.doesNotMatch(map, /^- second\/: /m);

    fs.writeFileSync(path.join(folder, 'third', 'dirty.txt'), 'unsaved');
    after.destroy();
    const dormant = sessionAt([first, third]);
    const config = { projects: [{ id: 'workspace-edit-session', name: 'Workspace Edit', path: folder, repos: [first, third] }] };
    const control = connectControl<{ type: string; error?: string | null }>(createControlServer(controlDeps(config, { sessions: new Map([['workspace-edit-session', dormant]]) })));
    control.send({ type: 'set-workspace-repos', id: 'workspace-edit-session', repos: [first, second], requestId: 'drop-dirty' });
    const replyFor = () => control.sent.find((frame) => frame.type === 'set-workspace-repos-result');
    await waitFor(() => replyFor() !== undefined, 'set-workspace-repos replied', 10000);
    dormant.destroy();
    assert.equal(replyFor()?.error, 'third has uncommitted changes. Commit or discard them before removing it from the workspace.');
  } finally {
    after.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale workspace release waiting on the old reap keeps members the live session re-added', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-readd-'));
  const repos = ['a', 'b', 'c'].map((name) => makeRepo(root, name));
  const folder = path.join(root, 'ws-workspace-readd');
  const sessionAt = (workspaceRepos: string[]) => new Session({ id: 'workspace-readd-session', name: 'Workspace Readd', path: folder, workspaceRepos, gitWorkspace: createGitWorkspace() });
  const original = sessionAt(repos);
  const narrowed = sessionAt(repos.slice(0, 2));
  const restored = sessionAt(repos);
  const registered = new Map([['workspace-readd-session', narrowed]]);
  const currentSessionFor = (id: string) => registered.get(id) ?? null;
  try {
    assert.equal(await original._provisionWorktree(), true);
    original.destroy();
    let finishOriginalReap = () => {};
    original._killReap = new Promise<void>((resolve) => { finishOriginalReap = resolve; });
    const staleRelease = carryWorktreeAcrossRecreate(original, narrowed, currentSessionFor);
    narrowed.destroy();
    registered.set('workspace-readd-session', restored);
    await carryWorktreeAcrossRecreate(narrowed, restored, currentSessionFor);
    assert.equal(await restored._provisionWorktree(), true);
    finishOriginalReap();
    await staleRelease;
    assert.equal(fs.existsSync(path.join(folder, 'c', 'README.md')), true);
  } finally {
    restored.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removing a workspace session that holds work is refused with each kept path until discard is confirmed', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-remove-'));
  const first = makeRepo(root, 'first');
  const second = makeRepo(root, 'second');
  const folder = path.join(root, 'ws-workspace-remove');
  const session = new Session({ id: 'workspace-remove-session', name: 'Workspace Remove', path: folder, workspaceRepos: [first, second], gitWorkspace: createGitWorkspace() });
  try {
    assert.equal(await session._provisionWorktree(), true);
    fs.writeFileSync(path.join(folder, 'second', 'unsaved.txt'), 'unsaved');
    const config = { projects: [{ id: 'workspace-remove-session', name: 'Workspace Remove', path: folder, repos: [first, second] }] };
    const control = connectControl<{ type: string; requestId?: string; ok?: boolean; keptPaths?: unknown; canDiscardWork?: boolean }>(createControlServer(controlDeps(config, { sessions: new Map([['workspace-remove-session', session]]) })));
    const replyTo = (requestId: string) => control.sent.find((frame) => frame.requestId === requestId);

    control.send({ type: 'remove-session', id: 'workspace-remove-session', requestId: 'refused' });
    await waitFor(() => replyTo('refused') !== undefined, 'refused removal replied', 10000);
    assert.equal(replyTo('refused')?.canDiscardWork, true);
    assert.deepEqual(replyTo('refused')?.keptPaths, [{ path: path.join(folder, 'second'), reason: 'uncommitted changes' }]);
    assert.deepEqual(config.projects.map((project) => project.id), ['workspace-remove-session']);

    fs.writeFileSync(path.join(folder, 'first', 'written-while-dialog-open.txt'), 'unsaved');
    control.send({ type: 'remove-session', id: 'workspace-remove-session', discardWork: true, confirmedKeptPaths: [path.join(folder, 'second')], requestId: 'refused-again' });
    await waitFor(() => replyTo('refused-again') !== undefined, 'second refused removal replied', 10000);
    assert.deepEqual(replyTo('refused-again')?.keptPaths, [{ path: path.join(folder, 'first'), reason: 'uncommitted changes' }, { path: path.join(folder, 'second'), reason: 'uncommitted changes' }]);
    const confirmedKeptPaths = [path.join(folder, 'first'), path.join(folder, 'second')];

    const failingSaveControl = connectControl<{ type: string; requestId?: string; ok?: boolean }>(createControlServer(controlDeps(config, { sessions: new Map([['workspace-remove-session', session]]), configStore: testConfigStore(config, { saveFails: true }) })));
    failingSaveControl.send({ type: 'remove-session', id: 'workspace-remove-session', discardWork: true, confirmedKeptPaths, requestId: 'save-failed' });
    await waitFor(() => failingSaveControl.sent.some((frame) => frame.requestId === 'save-failed'), 'failed-save removal replied', 10000);
    assert.equal(failingSaveControl.sent.find((frame) => frame.requestId === 'save-failed')?.ok, false);
    await session.releaseDroppedWorkspaceMembers([first]);
    assert.equal(fs.existsSync(path.join(folder, 'second', 'unsaved.txt')), true);

    control.send({ type: 'remove-session', id: 'workspace-remove-session', discardWork: true, confirmedKeptPaths, requestId: 'discarded' });
    await waitFor(() => replyTo('discarded') !== undefined, 'discarded removal replied', 10000);
    assert.equal(replyTo('discarded')?.ok, true);
    session.destroy();
    await session.discardWorktree();
    assert.equal(fs.existsSync(folder), false);
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
