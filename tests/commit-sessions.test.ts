import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasGit, git } from './helpers/git-fixture.ts';
import { createCommitSessions } from '../server/commit-sessions.ts';
import type { GitRunner } from '../server/commit-sessions.ts';
import { runGit } from '../server/git/git-exec.ts';
import { CommitSessionRecord } from '../shared/contracts/commit-session.ts';

function countingGit(): { runGitFn: GitRunner; subcommands: string[] } {
  const subcommands: string[] = [];
  const runGitFn: GitRunner = (args, options) => {
    subcommands.push(args[0] ?? '');
    return runGit(args, options);
  };
  return { runGitFn, subcommands };
}

function commitFile(worktreeDir: string, fileName: string): string {
  fs.writeFileSync(path.join(worktreeDir, fileName), `${fileName}\n`);
  git(['add', fileName], worktreeDir);
  git(['commit', '-q', '-m', `add ${fileName}`], worktreeDir);
  return git(['rev-parse', 'HEAD'], worktreeDir).trim();
}

function storedRecords(storeRoot: string): CommitSessionRecord[] {
  const [storeFile] = fs.readdirSync(storeRoot);
  assert.ok(storeFile);
  return fs.readFileSync(path.join(storeRoot, storeFile), 'utf8').trim().split('\n').map((line) => CommitSessionRecord.parse(JSON.parse(line)));
}

test('capture spends no git call on an unmoved HEAD and one log plus one patch-id batch when it moves', { skip: !hasGit() }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-commit-sessions-'));
  const repoDir = path.join(sandbox, 'repo');
  const worktreeDir = path.join(sandbox, 'worktree');
  const storeRoot = path.join(sandbox, 'commit-sessions');
  try {
    fs.mkdirSync(repoDir);
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    commitFile(repoDir, 'base.txt');
    git(['worktree', 'add', '-q', '-b', 'session-branch', worktreeDir], repoDir);
    const change = { sessionId: 'session-1', sessionName: 'demo', agent: 'claude', taskTitle: 'Add files', worktreeDir, baseRef: 'main' };

    const firstGit = countingGit();
    const commitSessions = createCommitSessions({ storeRoot, runGitFn: firstGit.runGitFn, logger: console, nowFn: () => 1 });
    const firstSha = commitFile(worktreeDir, 'first.txt');
    await commitSessions.noteHeadChange({ ...change, headSha: firstSha });
    assert.deepEqual(firstGit.subcommands, ['rev-parse', 'log', 'show', 'patch-id']);
    const firstPatch = git(['show', firstSha], worktreeDir);
    const expectedPatchId = (await runGit(['patch-id', '--stable'], { cwd: worktreeDir, input: firstPatch })).out.split(' ')[0];
    const [firstRecord] = storedRecords(storeRoot);
    assert.equal(firstRecord?.sha, firstSha);
    assert.equal(firstRecord?.sessionId, 'session-1');
    assert.equal(firstRecord?.taskTitle, 'Add files');
    assert.equal(firstRecord?.patchId, expectedPatchId);

    firstGit.subcommands.length = 0;
    await commitSessions.noteHeadChange({ ...change, headSha: firstSha });
    assert.deepEqual(firstGit.subcommands, []);

    const secondSha = commitFile(worktreeDir, 'second.txt');
    await commitSessions.noteHeadChange({ ...change, headSha: secondSha });
    assert.deepEqual(firstGit.subcommands, ['log', 'show', 'patch-id']);
    assert.deepEqual(storedRecords(storeRoot).map((record) => record.sha), [firstSha, secondSha]);

    const restartedGit = countingGit();
    const restarted = createCommitSessions({ storeRoot, runGitFn: restartedGit.runGitFn, logger: console });
    await restarted.noteHeadChange({ ...change, headSha: secondSha });
    assert.deepEqual(restartedGit.subcommands, ['rev-parse', 'log']);
    assert.equal(storedRecords(storeRoot).length, 2);
    assert.equal(git(['status', '--porcelain'], repoDir), '');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
