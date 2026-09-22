import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspace } from '../server/git-workspace.ts';
import { isSameDirectoryPath } from '../shared/paths.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

test('workspace members fork synced origin, reattach commits, detect conflicts and retain branches on removal', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-git-'));
  try {
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    const updater = path.join(root, 'updater');
    fs.mkdirSync(origin);
    git(['init', '--bare'], origin);
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Workspace Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'initial'], repo);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '-u', 'origin', 'main'], repo);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], origin);
    git(['clone', origin, updater], root);
    git(['config', 'user.email', 'test@example.com'], updater);
    git(['config', 'user.name', 'Workspace Test'], updater);
    git(['config', 'commit.gpgsign', 'false'], updater);
    fs.writeFileSync(path.join(updater, 'updated.txt'), 'from origin\n');
    git(['add', '.'], updater);
    git(['commit', '-m', 'updated'], updater);
    git(['push', 'origin', 'main'], updater);
    git(['checkout', '-b', 'working'], repo);
    git(['remote', 'set-head', 'origin', '-a'], repo);

    const workspace = createGitWorkspace();
    const branch = 'glimmervoid/workspace/test-session';
    const wtDir = path.join(root, 'member');
    const created = await workspace.ensureWorkspaceMember({ projectPath: repo, wtDir, branch });
    assert.equal(created.isGit, true);
    assert.equal(created.base, 'main');
    assert.equal(fs.readFileSync(path.join(wtDir, 'updated.txt'), 'utf8'), 'from origin\n');
    assert.equal(git(['rev-parse', 'HEAD'], wtDir).trim(), git(['rev-parse', 'origin/main'], repo).trim());

    const conflict = await workspace.ensureWorkspaceMember({ projectPath: repo, wtDir: path.join(root, 'other'), branch });
    assert.equal(conflict.reason, 'branch-in-use');
    assert.equal(isSameDirectoryPath(conflict.conflictPath, wtDir), true);

    git(['config', 'user.email', 'test@example.com'], wtDir);
    git(['config', 'user.name', 'Workspace Test'], wtDir);
    fs.writeFileSync(path.join(wtDir, 'own-commit.txt'), 'preserved\n');
    git(['add', '.'], wtDir);
    git(['commit', '-m', 'member work'], wtDir);
    const committedSha = git(['rev-parse', 'HEAD'], wtDir).trim();
    assert.equal((await workspace.removeWorkspaceMember({ projectPath: repo, cwd: wtDir })).ok, true);
    assert.equal(fs.existsSync(wtDir), false);
    assert.equal(git(['rev-parse', branch], repo).trim(), committedSha);

    const attached = await workspace.ensureWorkspaceMember({ projectPath: repo, wtDir, branch });
    assert.equal(attached.isGit, true);
    assert.equal(git(['rev-parse', 'HEAD'], wtDir).trim(), committedSha);
    fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'keep\n');
    assert.equal((await workspace.removeWorkspaceMember({ projectPath: repo, cwd: wtDir })).ok, false);
    assert.equal(fs.readFileSync(path.join(wtDir, 'dirty.txt'), 'utf8'), 'keep\n');
    fs.rmSync(path.join(wtDir, 'dirty.txt'));
    fs.writeFileSync(path.join(wtDir, 'README.md'), 'tracked edit\n');
    assert.equal((await workspace.removeWorkspaceMember({ projectPath: repo, cwd: wtDir })).ok, false);
    assert.equal(fs.readFileSync(path.join(wtDir, 'README.md'), 'utf8'), 'tracked edit\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace member release keeps tracked symlinks, unlinks ignored share links and spares their source targets', { skip: !hasGit() || process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-workspace-links-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Workspace Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'agents\n');
    fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'initial'], repo);
    fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'shared\n');

    const workspace = createGitWorkspace();
    const branch = 'glimmervoid/workspace/links-session';
    const wtDir = path.join(root, 'member');
    const shareList = ['node_modules'];
    const created = await workspace.ensureWorkspaceMember({ projectPath: repo, wtDir, branch, shareList });
    assert.equal(created.isGit, true);
    assert.equal(fs.lstatSync(path.join(wtDir, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(wtDir, 'node_modules')).isSymbolicLink(), true);

    assert.equal((await workspace.removeWorkspaceMember({ projectPath: repo, cwd: wtDir, shareList })).ok, true);
    assert.equal(fs.existsSync(wtDir), false);
    assert.equal(git(['rev-parse', '--verify', branch], repo).trim().length, 40);
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'utf8'), 'shared\n');

    const reattached = await workspace.ensureWorkspaceMember({ projectPath: repo, wtDir, branch, shareList });
    assert.equal(reattached.isGit, true);
    fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'keep\n');
    assert.equal((await workspace.removeWorkspaceMember({ projectPath: repo, cwd: wtDir, shareList })).ok, false);
    assert.equal(fs.lstatSync(path.join(wtDir, 'CLAUDE.md')).isSymbolicLink(), true);
    assert.equal(git(['status', '--porcelain', '--', 'CLAUDE.md'], wtDir).trim(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
