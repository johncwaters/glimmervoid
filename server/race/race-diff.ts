import fsp from 'node:fs/promises';
import path from 'node:path';

import type { DiffStats } from '../../shared/contracts/race.ts';
import { runGit } from '../git/git-exec.ts';
import { withScratchIndex } from '../git/scratch-index.ts';
import type { ScratchIndexEnv } from '../git/scratch-index.ts';
import { parseShortstat } from './core/race-core.ts';

const DIFF_TIMEOUT_MS = 60_000;
const DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const AGENT_CONFIG_FOLDERS = ['.claude', '.codex', '.kimi', '.gemini', '.qwen', '.grok', '.github/copilot'];
const WITHOUT_AGENT_CONFIG_PATHSPEC = ['--', '.', ...AGENT_CONFIG_FOLDERS.map((folder) => `:(exclude,glob)**/${folder}/**`)];

type ContestantDiff = { ok: true; diff: string; stats: DiffStats; blindDiff: string; blindStats: DiffStats } | { ok: false; reason: string };

async function exportBlindCheckout(gitOptions: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBuffer: number }, blindCheckoutDir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const blindFiles = await runGit(['--no-literal-pathspecs', 'ls-files', '-z', '--cached', ...WITHOUT_AGENT_CONFIG_PATHSPEC], { ...gitOptions, trim: false });
  if (!blindFiles.ok) return { ok: false, reason: `could not list the working tree: ${blindFiles.err}` };
  await fsp.mkdir(blindCheckoutDir, { recursive: true });
  const exported = await runGit(['checkout-index', '-z', '--stdin', `--prefix=${blindCheckoutDir}${path.sep}`], { ...gitOptions, input: blindFiles.out });
  if (!exported.ok) return { ok: false, reason: `could not copy the working tree for the judge: ${exported.err}` };
  return { ok: true };
}

async function contestantDiff({ worktreeDir, startSha, blindCheckoutDir = null }: { worktreeDir: string; startSha: string; blindCheckoutDir?: string | null }): Promise<ContestantDiff> {
  const scratchRun = await withScratchIndex(worktreeDir, DIFF_TIMEOUT_MS, (scratchIndexEnv) => diffOnScratchIndex({ worktreeDir, startSha, blindCheckoutDir, scratchIndexEnv }));
  if (!scratchRun.ok) return { ok: false, reason: `not a git checkout: ${scratchRun.reason}` };
  return scratchRun.value;
}

async function diffOnScratchIndex({ worktreeDir, startSha, blindCheckoutDir, scratchIndexEnv }: { worktreeDir: string; startSha: string; blindCheckoutDir: string | null; scratchIndexEnv: ScratchIndexEnv }): Promise<ContestantDiff> {
  const gitOptions = { cwd: worktreeDir, env: scratchIndexEnv, timeoutMs: DIFF_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES };
  const staged = await runGit(['add', '-A'], gitOptions);
  if (!staged.ok) return { ok: false, reason: `could not read the working tree: ${staged.err}` };
  const shortstat = await runGit(['diff', '--cached', '--shortstat', startSha], gitOptions);
  if (!shortstat.ok) return { ok: false, reason: `could not diff against ${startSha}: ${shortstat.err}` };
  const diff = await runGit(['diff', '--cached', '--no-color', '--no-ext-diff', startSha], { ...gitOptions, trim: false });
  if (!diff.ok) return { ok: false, reason: `could not diff against ${startSha}: ${diff.err}` };
  const blindShortstat = await runGit(['--no-literal-pathspecs', 'diff', '--cached', '--shortstat', startSha, ...WITHOUT_AGENT_CONFIG_PATHSPEC], gitOptions);
  if (!blindShortstat.ok) return { ok: false, reason: `could not diff against ${startSha}: ${blindShortstat.err}` };
  const blindDiff = await runGit(['--no-literal-pathspecs', 'diff', '--cached', '--no-color', '--no-ext-diff', startSha, ...WITHOUT_AGENT_CONFIG_PATHSPEC], { ...gitOptions, trim: false });
  if (!blindDiff.ok) return { ok: false, reason: `could not diff against ${startSha}: ${blindDiff.err}` };
  if (blindCheckoutDir) {
    const exported = await exportBlindCheckout(gitOptions, blindCheckoutDir);
    if (!exported.ok) return exported;
  }
  return { ok: true, diff: diff.out, stats: parseShortstat(shortstat.out), blindDiff: blindDiff.out, blindStats: parseShortstat(blindShortstat.out) };
}

export { contestantDiff };
export type { ContestantDiff };
