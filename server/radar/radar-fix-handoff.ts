import fs from 'node:fs';
import path from 'node:path';

import { runGit } from '../git/git-exec.ts';
import type { ExecFileFn, RunCommandOptions } from '../git/git-exec.ts';
import { nulSeparatedPaths } from '../git/core/git-changed-paths-core.ts';
import type { RadarErrorReason, RadarHandoffStep } from '../../shared/contracts/telemetry.ts';
import * as core from './core/radar-lane-core.ts';

interface PosthogWorkspace {
  isGit: boolean;
  cwd: string;
  branch?: string | null;
  base?: string | null;
  baseSha?: string | null;
}

interface CliResult {
  ok: boolean;
  out: string;
  err: string;
}

interface HandoffResult {
  verdict: string;
  prUrl: string | null;
  summary: string | null;
  errorReason?: RadarErrorReason;
  failedStep?: RadarHandoffStep;
}

const HANDOFF_STEP_LABELS: Readonly<Record<RadarHandoffStep, string>> = Object.freeze({
  'commit-fix': 'committing the fix',
  'read-diff': 'reading the branch diff',
  'count-commits': 'counting the branch commits',
});

const FIX_HANDOFF_TIMEOUT_MS = 120_000;

async function runCli(cmd: string, args: string[], cwd: string, execFileFn?: ExecFileFn): Promise<CliResult> {
  const options: RunCommandOptions = {
    cwd,
    timeoutMs: FIX_HANDOFF_TIMEOUT_MS,
    keepStdoutOnFailure: true,
    preferStderr: true,
    ...(execFileFn ? { execFileFn } : {}),
  };
  const result = await runGit(args, { ...options, gitPath: cmd });
  return { ok: result.ok, out: result.out, err: result.err };
}

function handoffFailure(step: RadarHandoffStep, detail: unknown, branch: string | null | undefined): HandoffResult {
  const why = core.summaryLineFromReportText(detail);
  return {
    verdict: 'ERROR', prUrl: null, summary: `fix handoff failed while ${HANDOFF_STEP_LABELS[step]}${why ? ` (${why})` : ''}; branch ${branch} was deleted`,
    errorReason: 'handoff-failed', failedStep: step,
  };
}

async function checkFixBranch(
  { run = runCli, workspace }: {
    run?: (cmd: string, args: string[], cwd: string) => Promise<CliResult>;
    workspace: PosthogWorkspace;
  },
): Promise<HandoffResult> {
  const branch = workspace.branch;
  const baseRef = workspace.baseSha || workspace.base;
  const changed = await run('git', ['diff', '-z', '--name-only', '--no-renames', `${baseRef}...HEAD`], workspace.cwd);
  if (!changed.ok) return handoffFailure('read-diff', changed.err, branch);
  const ahead = await run('git', ['rev-list', '--count', `${baseRef}..HEAD`], workspace.cwd);
  if (!ahead.ok) return handoffFailure('count-commits', ahead.err, branch);

  const decision = core.decideFixHandoff({
    changedFiles: nulSeparatedPaths(changed.out),
    commitsAhead: Number(ahead.out),
  });
  if (!decision.ok) {
    const verdict = decision.verdict ?? 'ERROR';
    return { verdict, prUrl: null, summary: decision.summary ?? null, ...(verdict === 'ERROR' ? { errorReason: 'empty-fix' as const } : {}) };
  }
  return { verdict: 'FIXED', prUrl: null, summary: null };
}

async function readRegularFileText(filePath: string): Promise<string | null> {
  const stat = await fs.promises.lstat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;
  return fs.promises.readFile(filePath, 'utf8').catch(() => null);
}

async function readWorktreeGitPointer(worktreePath: string): Promise<string | null> {
  const pointerText = await readRegularFileText(path.join(worktreePath, '.git'));
  const adminDir = pointerText?.match(/^gitdir: (.+)$/m)?.[1]?.trim();
  if (!pointerText || !adminDir) return null;
  const adminPath = path.resolve(worktreePath, adminDir);
  const [commonDirText, backPointerText] = await Promise.all([readRegularFileText(path.join(adminPath, 'commondir')), readRegularFileText(path.join(adminPath, 'gitdir'))]);
  return JSON.stringify([pointerText, commonDirText, backPointerText]);
}

async function commitFixWork(
  { run = runCli, workspace, message, emptyHooksDir }: {
    run?: (cmd: string, args: string[], cwd: string) => Promise<CliResult>;
    workspace: PosthogWorkspace;
    message: string;
    emptyHooksDir: string;
  },
): Promise<HandoffResult | null> {
  const git = (args: string[]) => run('git', ['-c', `core.hooksPath=${emptyHooksDir}`, '-c', 'core.fsmonitor=false', ...args], workspace.cwd);
  const branch = workspace.branch;
  const staged = await git(['add', '-A']);
  if (!staged.ok) return handoffFailure('commit-fix', staged.err, branch);
  const hasNothingStaged = await git(['diff', '--cached', '--quiet']);
  if (hasNothingStaged.ok) return null;
  const committed = await git(['commit', '--no-verify', '-m', message]);
  if (!committed.ok) return handoffFailure('commit-fix', committed.err, branch);
  return null;
}

export { checkFixBranch, commitFixWork, handoffFailure, readWorktreeGitPointer, runCli };
export type { CliResult, PosthogWorkspace };
