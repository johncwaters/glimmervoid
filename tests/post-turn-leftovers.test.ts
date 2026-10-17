import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanPostTurnLeftovers } from '../server/post-turn-leftovers.ts';
import { git, hasGit } from './helpers/git-fixture.ts';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('startup cleanup deletes only untracked old reports and names the repositories that track one', { skip: !hasGit() }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-leftovers-')));
  try {
    const repository = path.join(root, 'repo');
    const worktree = path.join(root, 'repo-worktree');
    fs.mkdirSync(repository);
    git(['init', '-q', '-b', 'main'], repository);
    git(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'seed'], repository);
    git(['worktree', 'add', '-q', '-b', 'session', worktree], repository);

    writeFile(path.join(repository, '.glimmervoid', 'post-turn', 'abc-1.json'), '{}');
    writeFile(path.join(repository, '.glimmervoid', 'pack', 'brand.md'), 'kept');
    writeFile(path.join(worktree, '.glimmervoid', 'post-turn', 'tracked.json'), '{}');
    writeFile(path.join(worktree, '.glimmervoid', 'post-turn', 'untracked.json'), '{}');
    writeFile(path.join(worktree, '.glimmervoid', 'post-turn', 'notes.txt'), 'kept');
    git(['add', '.glimmervoid/post-turn/tracked.json'], worktree);

    const logged: string[] = [];
    const logger = { log: (line: string) => logged.push(line), warn: (line: string) => logged.push(line) };
    const repositoriesTrackingReports = await cleanPostTurnLeftovers({ projects: [{ path: repository }], logger });

    assert.deepEqual(repositoriesTrackingReports, [{ repositoryPath: worktree, trackedReportGitPaths: ['.glimmervoid/post-turn/tracked.json'] }]);
    assert.equal(fs.existsSync(path.join(repository, '.glimmervoid', 'post-turn')), false);
    assert.equal(fs.existsSync(path.join(repository, '.glimmervoid', 'pack', 'brand.md')), true);
    assert.deepEqual(fs.readdirSync(path.join(worktree, '.glimmervoid', 'post-turn')).sort(), ['notes.txt', 'tracked.json']);
    assert.ok(logged.some((line) => line.includes(`git -C '${worktree}' rm --cached -q -- '.glimmervoid/post-turn/tracked.json'`)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup cleanup leaves the target of a symlinked report folder untouched', { skip: !hasGit() || process.platform === 'win32' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-leftovers-')));
  try {
    const repository = path.join(root, 'repo');
    const outsideFolder = path.join(root, 'outside');
    fs.mkdirSync(repository);
    git(['init', '-q', '-b', 'main'], repository);
    git(['-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'seed'], repository);
    writeFile(path.join(outsideFolder, 'credentials.json'), '{}');
    fs.mkdirSync(path.join(repository, '.glimmervoid'));
    fs.symlinkSync(outsideFolder, path.join(repository, '.glimmervoid', 'post-turn'));

    const logger = { log: () => {}, warn: () => {} };
    const repositoriesTrackingReports = await cleanPostTurnLeftovers({ projects: [{ path: repository }], logger });

    assert.deepEqual(repositoriesTrackingReports, []);
    assert.deepEqual(fs.readdirSync(outsideFolder), ['credentials.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
