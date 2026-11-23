import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimBuildCaches } from '../server/build-cache-reclaim.ts';
import { CACHEDIR_TAG_SIGNATURE } from '../server/core/disk-headroom-core.ts';
import { removalsJournalPath } from '../server/removal-journal.ts';
import { glimmervoidHomeDir } from '../server/config-store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_TAG = `${CACHEDIR_TAG_SIGNATURE}\n# cargo\n`;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function ageTree(treePath: string, ageDays: number): void {
  const touchedAt = new Date(Date.now() - ageDays * DAY_MS);
  for (const entry of fs.readdirSync(treePath, { withFileTypes: true, recursive: true })) fs.utimesSync(path.join(entry.parentPath, entry.name), touchedAt, touchedAt);
  fs.utimesSync(treePath, touchedAt, touchedAt);
}

function makeWorktree(repoPath: string, worktreeRoot: string, name: string, idleDays: number): string {
  const worktreePath = path.join(worktreeRoot, name);
  git(repoPath, 'worktree', 'add', '-q', '-b', name, worktreePath);
  const indexPath = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  const touchedAt = new Date(Date.now() - idleDays * DAY_MS);
  fs.utimesSync(indexPath, touchedAt, touchedAt);
  return worktreePath;
}

function makeCache(folderPath: string, cacheDirTag: string | null, ageDays: number): string {
  fs.mkdirSync(path.join(folderPath, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'debug', 'artifact.bin'), 'x'.repeat(1024));
  if (cacheDirTag !== null) fs.writeFileSync(path.join(folderPath, 'CACHEDIR.TAG'), cacheDirTag);
  ageTree(folderPath, ageDays);
  return folderPath;
}

test('a short disk loses only untracked, untouched tagged caches of idle worktrees under the worktree root, oldest first, stopping once no longer short', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-build-cache-reclaim-')));
  try {
    const repoPath = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'CACHEDIR.TAG'), VALID_TAG);
    fs.writeFileSync(path.join(repoPath, 'src', 'app.ts'), 'export {};\n');
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-q', '-m', 'init');
    const worktreeRoot = path.join(root, 'worktrees');
    const oldestIdle = makeWorktree(repoPath, worktreeRoot, 'repo-oldest', 9);
    const newerIdle = makeWorktree(repoPath, worktreeRoot, 'repo-newer', 2);
    const live = makeWorktree(repoPath, worktreeRoot, 'repo-live', 30);
    const ancestorHeld = makeWorktree(repoPath, path.join(root, 'held', 'worktrees'), 'repo-ancestor', 30);
    const oldestCargoTarget = makeCache(path.join(oldestIdle, 'rust', 'target'), VALID_TAG, 5);
    const oldestVenv = makeCache(path.join(oldestIdle, '.venv'), VALID_TAG, 5);
    const buildingNow = makeCache(path.join(oldestIdle, 'target'), VALID_TAG, 5);
    fs.writeFileSync(path.join(buildingNow, 'debug', 'fresh.o'), 'just built');
    const trackedSource = path.join(oldestIdle, 'src');
    ageTree(trackedSource, 5);
    const untaggedModules = makeCache(path.join(oldestIdle, 'node_modules', 'pkg', '.cache'), VALID_TAG, 5);
    const forgedTag = makeCache(path.join(oldestIdle, 'notes'), 'Signature: not-the-spec\n', 5);
    const tooDeep = makeCache(path.join(oldestIdle, 'a', 'b', 'c', 'd', 'target'), VALID_TAG, 5);
    const newerTarget = makeCache(path.join(newerIdle, 'target'), VALID_TAG, 5);
    const liveTarget = makeCache(path.join(live, 'target'), VALID_TAG, 5);
    const ancestorTarget = makeCache(path.join(ancestorHeld, 'target'), VALID_TAG, 5);
    const outsideTarget = makeCache(path.join(root, 'elsewhere', 'target'), VALID_TAG, 5);
    const unconfiguredRepoPath = path.join(root, 'unconfigured');
    fs.mkdirSync(unconfiguredRepoPath);
    git(unconfiguredRepoPath, 'init', '-q', '-b', 'main');
    git(unconfiguredRepoPath, 'commit', '-q', '--allow-empty', '-m', 'init');
    const unconfiguredTarget = makeCache(path.join(makeWorktree(unconfiguredRepoPath, worktreeRoot, 'unconfigured-manual', 30), 'target'), VALID_TAG, 5);

    let shortChecks = 0;
    const { reclaimedFolders } = await reclaimBuildCaches({
      worktreeRoots: [worktreeRoot, path.join(root, 'held', 'worktrees')],
      projectPaths: [repoPath],
      liveWorktreePaths: async () => new Set([path.join(live, 'src'), path.join(root, 'held')]),
      isStillShort: async () => { shortChecks += 1; return shortChecks === 1; },
      log: { warn: () => {} },
    });

    assert.deepEqual(reclaimedFolders.sort(), [oldestVenv, oldestCargoTarget].sort());
    for (const keptFolder of [buildingNow, path.join(trackedSource, 'app.ts'), untaggedModules, forgedTag, tooDeep, newerTarget, liveTarget, ancestorTarget, outsideTarget, unconfiguredTarget]) assert.equal(fs.existsSync(keptFolder), true, keptFolder);
    const journalLines = fs.readFileSync(removalsJournalPath(glimmervoidHomeDir()), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(journalLines.filter((record) => record.cause === 'build-cache').map((record) => record.path).sort(), reclaimedFolders.sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
