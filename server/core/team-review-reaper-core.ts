import path from 'node:path';
import { isPathInside } from '../../shared/paths.ts';

interface ProcessRow {
  pid: number;
  ppid: number;
  args: string;
  cwd: string | null;
}

type OwnedDirectoryScope = 'run' | 'sweep';

const CLAUDE_BASH_SIGNATURE = '/.claude/shell-snapshots/snapshot-';

function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? '', cwd: null });
  }
  return rows;
}

function parseCwdTable(output: string): Map<number, string> {
  const cwdByPid = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (!line.startsWith('n') || currentPid === null) continue;
    cwdByPid.set(currentPid, line.slice(1));
  }
  return cwdByPid;
}

function protectedProcessIds(rows: readonly ProcessRow[], ownPid: number): Set<number> {
  const parentsByPid = new Map(rows.map(({ pid, ppid }) => [pid, ppid]));
  const protectedPids = new Set<number>();
  let currentPid = ownPid;
  while (currentPid > 0 && !protectedPids.has(currentPid)) {
    protectedPids.add(currentPid);
    currentPid = parentsByPid.get(currentPid) ?? 0;
  }
  return protectedPids;
}

function isContainedReviewDirectory(directory: string, reviewRoots: readonly string[], scope: OwnedDirectoryScope): boolean {
  const resolvedDirectory = path.resolve(directory);
  return reviewRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    if (scope === 'sweep') return resolvedDirectory === resolvedRoot;
    return resolvedDirectory !== resolvedRoot && path.dirname(resolvedDirectory) === resolvedRoot;
  });
}

function isInsideOwnedDirectory(cwd: string, ownedDirectories: readonly string[]): boolean {
  return ownedDirectories.some((directory) => isPathInside(directory, cwd));
}

function selectTeamReviewProcessIds(
  rows: readonly ProcessRow[],
  ownedDirectories: readonly string[],
  protectedPids: ReadonlySet<number>,
): number[] {
  if (ownedDirectories.length === 0 || rows.length === 0) return [];
  const processByPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenByParent = new Map<number, number[]>();
  const selectedPids = new Set<number>();
  const pendingPids: number[] = [];
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
    if (protectedPids.has(row.pid)) continue;
    if (!row.args.includes(CLAUDE_BASH_SIGNATURE)) continue;
    const parent = processByPid.get(row.ppid);
    if (row.ppid !== 1 && path.basename(parent?.args.split(' ')[0] ?? '') !== 'systemd') continue;
    if (row.cwd === null || !isInsideOwnedDirectory(row.cwd, ownedDirectories)) continue;
    selectedPids.add(row.pid);
    pendingPids.push(row.pid);
  }
  for (let index = 0; index < pendingPids.length; index += 1) {
    for (const childPid of childrenByParent.get(pendingPids[index]) ?? []) {
      if (protectedPids.has(childPid) || selectedPids.has(childPid)) continue;
      selectedPids.add(childPid);
      pendingPids.push(childPid);
    }
  }
  return [...selectedPids].sort((leftPid, rightPid) => leftPid - rightPid);
}

export { isContainedReviewDirectory, parseCwdTable, parseProcessTable, protectedProcessIds, selectTeamReviewProcessIds };
export type { OwnedDirectoryScope, ProcessRow };
