import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepReturnedWorktreeFolders } from '../server/leftover-sweeps.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeAgedFolder(folderPath: string, ageDays: number, innerFile = 'leftover.txt', innerAgeDays = ageDays): string {
  const innerPath = path.join(folderPath, innerFile);
  fs.mkdirSync(path.dirname(innerPath), { recursive: true });
  fs.writeFileSync(innerPath, 'left behind');
  const innerTouchedAt = new Date(Date.now() - innerAgeDays * DAY_MS);
  for (let agedPath = innerPath; agedPath !== folderPath; agedPath = path.dirname(agedPath)) fs.utimesSync(agedPath, innerTouchedAt, innerTouchedAt);
  const touchedAt = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(folderPath, touchedAt, touchedAt);
  return folderPath;
}

test('the boot sweep deletes only a wholly untouched folder with no checkout at a path Glimmervoid removed before', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-leftover-sweeps-')));
  try {
    const worktreeRoot = path.join(root, 'worktrees');
    const returnedFolder = makeAgedFolder(path.join(worktreeRoot, 'repo-returned'), 2, path.join('.coherence', 'reading.json'));
    const freshFolder = makeAgedFolder(path.join(worktreeRoot, 'repo-fresh'), 0);
    const writtenInsideFolder = makeAgedFolder(path.join(worktreeRoot, 'repo-written-inside'), 2, path.join('.coherence', 'reading.json'), 0);
    const checkoutFolder = makeAgedFolder(path.join(worktreeRoot, 'ws-live-12345678'), 2, path.join('repo', '.git'));
    const ownedFolder = makeAgedFolder(path.join(worktreeRoot, 'repo-owned'), 2);
    const operatorFolder = makeAgedFolder(path.join(worktreeRoot, 'operator-clone'), 2);
    const outsideFolder = makeAgedFolder(path.join(root, 'elsewhere', 'repo-outside'), 2);
    const journalPath = path.join(root, 'removals.jsonl');
    const removedBefore = [returnedFolder, freshFolder, writtenInsideFolder, checkoutFolder, ownedFolder, outsideFolder]
      .map((removedPath) => JSON.stringify({ ts: 1, cause: 'session', kind: 'worktree', path: removedPath, branch: null, projectPath: null, sessionId: null, checksPassed: [], pid: 1 }));
    fs.writeFileSync(journalPath, `${removedBefore.join('\n')}\nnot json\n${JSON.stringify({ kind: 'folder', path: operatorFolder })}\n`);

    await sweepReturnedWorktreeFolders({
      worktreeRoots: [worktreeRoot], journalPath, log: { log: () => {} },
      ledger: { ownsAtOrUnder: async (folderPath) => folderPath === ownedFolder },
    });
    assert.deepEqual(fs.readdirSync(worktreeRoot).sort(), ['operator-clone', 'repo-fresh', 'repo-owned', 'repo-written-inside', 'ws-live-12345678']);
    assert.equal(fs.existsSync(outsideFolder), true);

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
