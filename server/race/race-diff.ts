import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DiffStats } from '../../shared/contracts/race.ts';
import { runGit } from '../git/git-exec.ts';
import { parseShortstat } from './core/race-core.ts';

const DIFF_TIMEOUT_MS = 60_000;
const DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

type ContestantDiff = { ok: true; diff: string; stats: DiffStats } | { ok: false; reason: string };

async function contestantDiff({ worktreeDir, startSha }: { worktreeDir: string; startSha: string }): Promise<ContestantDiff> {
  const indexPath = await runGit(['rev-parse', '--git-path', 'index'], { cwd: worktreeDir, timeoutMs: DIFF_TIMEOUT_MS });
  if (!indexPath.ok) return { ok: false, reason: `not a git checkout: ${indexPath.err}` };
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-race-diff-'));
  const scratchIndex = path.join(scratchDir, 'index');
  try {
    await fsp.copyFile(path.resolve(worktreeDir, indexPath.out.trim()), scratchIndex).catch(() => {});
    const gitOptions = { cwd: worktreeDir, env: { GIT_INDEX_FILE: scratchIndex }, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES };
    const staged = await runGit(['add', '-A'], gitOptions);
    if (!staged.ok) return { ok: false, reason: `could not read the working tree: ${staged.err}` };
    const shortstat = await runGit(['diff', '--cached', '--shortstat', startSha], gitOptions);
    if (!shortstat.ok) return { ok: false, reason: `could not diff against ${startSha}: ${shortstat.err}` };
    const diff = await runGit(['diff', '--cached', '--no-color', '--no-ext-diff', startSha], { ...gitOptions, trim: false });
    if (!diff.ok) return { ok: false, reason: `could not diff against ${startSha}: ${diff.err}` };
    return { ok: true, diff: diff.out, stats: parseShortstat(shortstat.out) };
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { contestantDiff };
export type { ContestantDiff };
