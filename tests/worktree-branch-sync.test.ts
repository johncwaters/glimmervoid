import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionWorktreeLifecycle } from '../session/session-worktree-lifecycle.ts';
import { buildResyncCommand } from '../server/core/branch-sync-core.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

const GIT = hasGit();

function configureRepository(repositoryPath: string): void {
  git(['config', 'user.email', 'test@example.com'], repositoryPath);
  git(['config', 'user.name', 'Glimmervoid Test'], repositoryPath);
  git(['config', 'commit.gpgsign', 'false'], repositoryPath);
}

function commitFile(repositoryPath: string, fileName: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repositoryPath, fileName), content, 'utf8');
  git(['add', '--', fileName], repositoryPath);
  git(['commit', '-m', message], repositoryPath);
}

function createDevelopTrackingOriginMainFixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-branch-sync-'));
  const seedPath = path.join(rootPath, 'seed');
  const remotePath = path.join(rootPath, 'origin.git');
  const repositoryPath = path.join(rootPath, 'repository');
  const writerPath = path.join(rootPath, 'writer');
  fs.mkdirSync(seedPath);
  git(['init', '-b', 'main'], seedPath);
  configureRepository(seedPath);
  commitFile(seedPath, 'seed.txt', 'seed\n', 'seed');
  git(['clone', '--bare', seedPath, remotePath], rootPath);
  git(['clone', remotePath, repositoryPath], rootPath);
  git(['clone', remotePath, writerPath], rootPath);
  configureRepository(repositoryPath);
  configureRepository(writerPath);
  git(['branch', '--track', 'develop', 'origin/main'], repositoryPath);
  return {
    remotePath,
    repositoryPath,
    writerPath,
    cleanup: () => fs.rmSync(rootPath, { recursive: true, force: true }),
  };
}

function createLifecycle(repositoryPath: string) {
  return createSessionWorktreeLifecycle({
    id: 'branch-sync-test',
    projectPath: repositoryPath,
    integrationBranch: 'develop',
    port: {
      state: () => ({ state: 'IDLE', isDestroyed: false, isTeardownPending: false, hasLivePty: false }),
      emit: () => {},
      recordDecision: () => {},
      pasteText: () => ({}),
    },
  });
}

test('resync fast-forwards a local develop that tracks origin/main and is behind it', { skip: !GIT }, async () => {
  const fixture = createDevelopTrackingOriginMainFixture();
  try {
    commitFile(fixture.writerPath, 'ahead.txt', 'ahead\n', 'ahead on main');
    git(['push', 'origin', 'main'], fixture.writerPath);
    const originMainSha = git(['rev-parse', 'main'], fixture.writerPath).trim();

    const result = await createLifecycle(fixture.repositoryPath).resyncBranch();

    assert.equal(result.action, 'fast-forwarded');
    assert.equal(result.error, null);
    assert.equal(git(['rev-parse', 'develop'], fixture.repositoryPath).trim(), originMainSha);
  } finally {
    fixture.cleanup();
  }
});

test('resync pushes a local develop that tracks origin/main to main, not a new origin/develop', { skip: !GIT }, async () => {
  const fixture = createDevelopTrackingOriginMainFixture();
  try {
    git(['checkout', 'develop'], fixture.repositoryPath);
    commitFile(fixture.repositoryPath, 'local.txt', 'local\n', 'local on develop');
    const developSha = git(['rev-parse', 'develop'], fixture.repositoryPath).trim();

    const result = await createLifecycle(fixture.repositoryPath).resyncBranch();

    assert.equal(result.action, 'pushed');
    assert.equal(git(['rev-parse', 'refs/heads/main'], fixture.remotePath).trim(), developSha);
    assert.equal(git(['for-each-ref', 'refs/heads/develop'], fixture.remotePath).trim(), '');
  } finally {
    fixture.cleanup();
  }
});

test('resync builds refspecs from the upstream branch name and skips network commands for a local upstream', () => {
  assert.deepEqual(
    buildResyncCommand('ff-fetch', { upstream: 'upstream/main', branch: 'develop', remote: 'upstream', remoteBranch: 'main' })?.args,
    ['fetch', '--quiet', 'upstream', 'main:develop'],
  );
  assert.deepEqual(
    buildResyncCommand('push', { upstream: 'origin/main', branch: 'develop', remote: 'origin', remoteBranch: 'main' })?.args,
    ['push', 'origin', 'develop:main'],
  );
  assert.equal(buildResyncCommand('ff-fetch', { upstream: 'main', branch: 'develop', remote: '.', remoteBranch: 'main' }), null);
  assert.equal(buildResyncCommand('push', { upstream: 'main', branch: 'develop', remote: '.', remoteBranch: 'main' }), null);
});
