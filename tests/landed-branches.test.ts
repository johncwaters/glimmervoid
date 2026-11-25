import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLandedBranches } from '../server/board-session/landed-branches.ts';
import { createGitWorkspace } from '../server/git/git-workspace.ts';
import { Session } from '../session/sessions.ts';
import { fakePty } from './helpers/fake-pty.ts';
import { git } from './helpers/git-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

const LANDED_BRANCH_IDLE_MS = 20;
const STAYS_OPEN_WAIT_MS = 300;

function commitAll(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
}

function runTurn(session: Session): void {
  session.transition('new_output');
  session.transition('task_complete');
}

test('a branch with no work yet stays open, one whose commits change files outside its box stays open until they land on the integration branch, and then it closes itself', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'landed-branches-'));
  const repo = path.join(root, 'repo');
  const branchDir = path.join(root, 'branch');
  mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  commitAll(repo, 'base');
  git(['worktree', 'add', '-q', '-b', 'agent-branch', branchDir, 'main'], repo);

  const branch = new Session({ id: 'branch', name: 'repo notes', path: repo, parent: { sessionId: 'orchestrator', box: { id: 'notes-box', title: 'notes', repoName: 'repo' } }, ptySpawn: () => fakePty(), gitWorkspace: createGitWorkspace() });
  branch.adoptWorktree({ worktreeDir: branchDir, branch: 'agent-branch', base: 'main', hasUnmergedWork: false, watch: false, emit: false });
  const closedBranchIds: string[] = [];
  const landedBranches = createLandedBranches({
    findSession: (sessionId) => (sessionId === branch.id ? branch : null),
    closeBranch: async (branchId) => {
      closedBranchIds.push(branchId);
      return { ok: true };
    },
    landedBranchIdleMs: LANDED_BRANCH_IDLE_MS,
    logger: { warn: () => {} },
  });
  try {
    landedBranches.attachSession(branch);
    branch.transition('user_start');
    branch.transition('spawn_success', { spawnCwdExists: true });
    branch.transition('first_output');
    runTurn(branch);
    await new Promise((resolve) => setTimeout(resolve, STAYS_OPEN_WAIT_MS));
    assert.deepEqual(closedBranchIds, [], 'a branch that only asked or planned keeps its session while it waits for an answer');
    mkdirSync(path.join(branchDir, 'notes'));
    writeFileSync(path.join(branchDir, 'notes', 'idea.md'), 'idea\n');
    writeFileSync(path.join(branchDir, 'README.md'), 'base, and a line the task needed outside the box\n');
    commitAll(branchDir, 'idea, with a README line outside notes');
    runTurn(branch);
    await new Promise((resolve) => setTimeout(resolve, STAYS_OPEN_WAIT_MS));
    assert.deepEqual(closedBranchIds, [], 'a branch with commits not on the integration branch stays open');

    const landed = await branch.mergeAndContinue({ force: true });
    assert.equal(landed.merged, true, `work outside the box lands like any other: ${landed.reason ?? ''}`);
    assert.match(git(['show', 'main:README.md'], repo), /outside the box/);
    runTurn(branch);
    await waitFor(() => closedBranchIds.length > 0, 'the landed branch closed itself', 10000);
    assert.deepEqual(closedBranchIds, [branch.id]);
  } finally {
    branch.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
