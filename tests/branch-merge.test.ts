import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBranchMerge } from '../server/board-session/branch-merge.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { git } from './helpers/git-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

function commitAll(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
}

function settle(session: Session): void {
  session.transition('user_start');
  session.transition('spawn_success', { spawnCwdExists: true });
  session.transition('first_output');
  assert.equal(session.state, 'IDLE');
}

test('bringIn tells the Orchestrator its worktree has no branch checked out and leaves its detached head where it was', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'branch-merge-'));
  const repo = path.join(root, 'repo');
  const orchestratorDir = path.join(root, 'orchestrator');
  const branchDir = path.join(root, 'branch');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  commitAll(repo, 'base');
  git(['worktree', 'add', '-q', '-b', 'studio-main', orchestratorDir], repo);
  git(['checkout', '-q', '--detach'], orchestratorDir);
  const detachedHead = git(['rev-parse', 'HEAD'], orchestratorDir).trim();
  git(['worktree', 'add', '-q', '-b', 'agent-branch', branchDir, 'studio-main'], repo);
  mkdirSync(path.join(branchDir, 'notes'));
  writeFileSync(path.join(branchDir, 'notes', 'idea.md'), 'idea\n');
  commitAll(branchDir, 'idea');

  const orchestrator = new Session({ id: 'orchestrator', name: 'orchestrator', path: orchestratorDir, ptySpawn: () => fakePty() });
  const branch = new Session({ id: 'branch', name: 'notes-branch', path: branchDir, parent: { sessionId: orchestrator.id, box: { id: 'notes-box', title: 'notes' } }, ptySpawn: () => fakePty() });
  const toldMain: string[] = [];
  const branchMerge = createBranchMerge({
    findSession: (sessionId) => [orchestrator, branch].find((session) => session.id === sessionId) ?? null,
    liveSessions: () => [orchestrator, branch],
    tellMain: (_branchId, text) => { toldMain.push(text); return true; },
    closeBranch: async () => ({ ok: false, error: 'not under test' }),
    logger: { warn: () => {} },
  });
  try {
    assert.ok(orchestrator.isWorktree && branch.isWorktree);
    settle(orchestrator);
    branchMerge.attachSession(branch);
    settle(branch);
    const orchestratorHead = () => git(['rev-parse', 'HEAD'], orchestratorDir).trim();
    await waitFor(() => toldMain.length > 0 || orchestratorHead() !== detachedHead, 'the merge step told the Orchestrator or moved its head', 10000);
    assert.equal(orchestratorHead(), detachedHead, 'the detached Orchestrator head was fast-forwarded');
    assert.equal(toldMain.length, 1);
    assert.match(toldMain[0], /notes-branch/);
    assert.match(toldMain[0], /no branch checked out/);
  } finally {
    orchestrator.destroy();
    branch.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
