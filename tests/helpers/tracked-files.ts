import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

export function trackedFiles(repoPathPattern: RegExp): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((repoPath) => repoPathPattern.test(repoPath) && fs.existsSync(path.join(REPO_ROOT, repoPath)));
}

export function readTracked(repoPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8');
}
