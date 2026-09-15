import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalizePath, isSameDirectoryPath } from '../shared/paths.ts';
import { SHORT_NAMES_AVAILABLE, shortPathOf, withTempDir } from './helpers/short-path.ts';

const WIN = process.platform === 'win32';

test('isSameDirectoryPath matches spellings differing by separator, trailing slash, or case', { skip: !WIN }, () => {
  assert.ok(isSameDirectoryPath('C:\\repo\\project', 'C:/repo/project'), 'forward slashes, as git porcelain emits');
  assert.ok(isSameDirectoryPath('C:\\repo\\project', 'C:\\repo\\project\\'), 'trailing separator');
  assert.ok(isSameDirectoryPath('C:\\Repo\\Project', 'c:\\repo\\project'), 'Windows paths are case-insensitive');
});

function asPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') ?? { value: process.platform, configurable: true };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function withLinkedTempDir(fn: (context: { dir: string; link: string }) => void): void {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-paths-')));
  const link = path.join(path.dirname(dir), `${path.basename(dir)}-alias`);
  fs.symlinkSync(dir, link, WIN ? 'junction' : 'dir');
  try {
    fn({ dir, link });
  } finally {
    try { fs.unlinkSync(link); } catch { fs.rmSync(link, { recursive: true, force: true }); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('on macOS a symlinked spelling of a worktree is the same directory, because APFS aliases are ordinary there', () => {
  withLinkedTempDir(({ dir, link }) => {
    assert.notEqual(link, dir, 'the fixture really is a second spelling');
    asPlatform('darwin', () => {
      assert.ok(isSameDirectoryPath(link, dir), 'a mac alias must not split one worktree into two');
      assert.ok(!isSameDirectoryPath(link, path.join(dir, 'nested')), 'canonicalizing is not collapsing');
    });
  });
});

test('on linux two spellings stay two paths, so no sync realpath runs off Windows and macOS', () => {
  withLinkedTempDir(({ dir, link }) => {
    asPlatform('linux', () => {
      assert.equal(isSameDirectoryPath(link, dir), false);
    });
  });
});

test('isSameDirectoryPath keeps genuinely different directories apart', () => {
  const a = path.join(os.tmpdir(), 'glimmervoid-paths-a');
  const b = path.join(os.tmpdir(), 'glimmervoid-paths-b');
  assert.ok(!isSameDirectoryPath(a, b));
});

test('isSameDirectoryPath treats an 8.3 short path and its long form as one directory', { skip: !SHORT_NAMES_AVAILABLE }, () => {
  withTempDir((dir) => {
    const short = shortPathOf(dir);
    assert.ok(short, 'the volume mints an 8.3 alias');
    assert.notEqual(short.toLowerCase(), dir.toLowerCase(), 'the fixture really is a second spelling');
    assert.ok(isSameDirectoryPath(short, dir), 'short and long spellings name the same worktree');
  });
});

test('canonicalizePath expands an 8.3 short path to its long form', { skip: !SHORT_NAMES_AVAILABLE }, () => {
  withTempDir((dir) => {
    const short = shortPathOf(dir);
    assert.ok(short, 'the volume mints an 8.3 alias');
    const canonical = canonicalizePath(short);
    assert.equal(canonical.toLowerCase(), fs.realpathSync.native(dir).toLowerCase());
    assert.ok(!canonical.includes('~'), 'no 8.3 tilde survives, which is what fs.watch requires');
  });
});

test('canonicalizePath returns the input untouched when the path is not on disk', () => {
  const absent = path.join(os.tmpdir(), `glimmervoid-paths-absent-${process.pid}`);
  assert.equal(canonicalizePath(absent), absent);
});
