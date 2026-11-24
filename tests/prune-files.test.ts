import './helpers/isolate-home.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pruneAgedFiles } from '../server/prune-files.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const directories: string[] = [];

after(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace(name: string, files: Record<string, number>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-prune-${name}-`));
  directories.push(directory);
  for (const [name_, ageDays] of Object.entries(files)) {
    const filePath = path.join(directory, name_);
    fs.writeFileSync(filePath, '{}\n', 'utf8');
    const stamp = new Date(NOW - (ageDays * DAY_MS));
    fs.utimesSync(filePath, stamp, stamp);
  }
  return directory;
}

test('a retained id survives the walk however old its file is', async () => {
  const directory = workspace('retained', { 'live.jsonl': 90, 'dead.jsonl': 90 });
  const removed = await pruneAgedFiles({
    directory,
    suffixes: ['.jsonl'],
    retainDays: 30,
    now: NOW,
    isRetainedId: (id) => id === 'live',
  });
  assert.deepEqual(removed, ['dead']);
  assert.equal(fs.existsSync(path.join(directory, 'live.jsonl')), true);
});

test('directory mode removes an aged directory and preserves a live directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-prune-directories-'));
  directories.push(directory);
  for (const name of ['old', 'live']) {
    const target = path.join(directory, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'upload.txt'), 'upload');
    fs.utimesSync(target, new Date(NOW - 90 * DAY_MS), new Date(NOW - 90 * DAY_MS));
  }
  const removed = await pruneAgedFiles({
    directory, suffixes: [''], retainDays: 7, now: NOW, entryMode: 'directory', isRetainedId: (id) => id === 'live',
  });
  assert.deepEqual(removed, ['old']);
  assert.equal(fs.existsSync(path.join(directory, 'old')), false);
  assert.equal(fs.existsSync(path.join(directory, 'live')), true);
});

test('directory mode removes an aged directory holding read-only directories, as a Go module cache leaves, without touching a symlinked folder outside it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-prune-read-only-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-prune-outside-'));
  directories.push(directory, outside);
  fs.chmodSync(outside, 0o555);
  const target = path.join(directory, 'session');
  const module = path.join(target, 'gopath', 'pkg', 'mod', 'example.com', 'lib@v1.0.0');
  fs.mkdirSync(module, { recursive: true });
  fs.writeFileSync(path.join(module, 'lib.go'), 'package lib\n');
  fs.symlinkSync(outside, path.join(target, 'linked-out'));
  for (let folder = module; folder !== target; folder = path.dirname(folder)) fs.chmodSync(folder, 0o555);
  fs.utimesSync(target, new Date(NOW - 90 * DAY_MS), new Date(NOW - 90 * DAY_MS));
  const warnings: string[] = [];
  const removed = await pruneAgedFiles({ directory, suffixes: [''], retainDays: 7, now: NOW, entryMode: 'directory', log: { warn: (line: string) => warnings.push(line) } });
  assert.deepEqual([removed, warnings], [['session'], []]);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o555, 'a folder reached through a symlink keeps its permissions');
  fs.chmodSync(outside, 0o755);
});
