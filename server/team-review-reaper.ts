import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileAsync } from './child-process-safe.ts';
import { isContainedReviewDirectory, parseCwdTable, parseProcessTable, protectedProcessIds, selectTeamReviewProcessIds } from './core/team-review-reaper-core.ts';
import type { OwnedDirectoryScope, ProcessRow } from './core/team-review-reaper-core.ts';

const PROCESS_LIST_TIMEOUT_MS = 5000;
const TERMINATION_GRACE_MS = 2000;
const EXIT_POLL_MS = 100;

interface TeamReviewReapOptions {
  ownedDirectories: readonly string[];
  reviewRoots: readonly string[];
  scope: OwnedDirectoryScope;
  log?: Pick<Console, 'warn'>;
}

async function resolvedPath(directory: string): Promise<string> {
  return fs.realpath(directory).catch(() => path.resolve(directory));
}

async function listTeamReviewProcesses(): Promise<ProcessRow[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  const { stdout } = await execFileAsync('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const rows = parseProcessTable(stdout);
  if (process.platform === 'linux') {
    return Promise.all(rows.map(async (row) => ({
      ...row,
      cwd: await fs.readlink(`/proc/${row.pid}/cwd`).then((cwd) => path.resolve(cwd)).catch(() => null),
    })));
  }
  const { stdout: cwdOutput } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fpn'], {
    encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const cwdByPid = parseCwdTable(cwdOutput);
  return Promise.all(rows.map(async (row) => ({
    ...row,
    cwd: await fs.realpath(cwdByPid.get(row.pid) ?? '').catch(() => null),
  })));
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    return true;
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return true;
    return false;
  }
}

async function waitForProcessesToExit(pids: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  let survivors = pids.filter(isProcessAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, EXIT_POLL_MS));
    survivors = survivors.filter(isProcessAlive);
  }
  return survivors;
}

async function containedOwnedDirectories(
  { ownedDirectories, reviewRoots, scope }: Pick<TeamReviewReapOptions, 'ownedDirectories' | 'reviewRoots' | 'scope'>,
  log: Pick<Console, 'warn'>,
): Promise<string[]> {
  const resolvedRoots = await Promise.all(reviewRoots.map(resolvedPath));
  const containedDirectories = await Promise.all(ownedDirectories.map(async (directory) => {
    const realDirectory = await resolvedPath(directory);
    if (isContainedReviewDirectory(realDirectory, resolvedRoots, scope)) return [...new Set([path.resolve(directory), realDirectory])];
    log.warn(`[team-review] skipped reaping ${realDirectory}: it resolves outside the review roots`);
    return [];
  }));
  return containedDirectories.flat();
}

async function reapTeamReviewProcesses({ ownedDirectories, reviewRoots, scope, log = console }: TeamReviewReapOptions): Promise<void> {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || ownedDirectories.length === 0) return;
  try {
    const [rows, resolvedDirectories] = await Promise.all([
      listTeamReviewProcesses(),
      containedOwnedDirectories({ ownedDirectories, reviewRoots, scope }, log),
    ]);
    const protectedPids = protectedProcessIds(rows, process.pid);
    const pids = selectTeamReviewProcessIds(rows, resolvedDirectories, protectedPids);
    if (pids.length === 0) return;
    let failedSignals = 0;
    for (const pid of pids) if (!sendSignal(pid, 'SIGTERM')) failedSignals += 1;
    const survivors = await waitForProcessesToExit(pids);
    for (const pid of survivors) if (!sendSignal(pid, 'SIGKILL')) failedSignals += 1;
    log.warn(`[team-review] reaped ${pids.length} review processes${failedSignals > 0 ? `; ${failedSignals} signals failed` : ''}`);
  } catch (error) {
    log.warn(`[team-review] process reap failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { listTeamReviewProcesses, reapTeamReviewProcesses };
export type { TeamReviewReapOptions };
