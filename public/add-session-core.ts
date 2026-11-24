import { SESSION_NAME_PATTERN } from '#shared/contracts/session.ts';
import type { StartPicks } from '#shared/contracts/start-picks.ts';

export type ScannedProject = { name: string; path: string; lastActivityMs?: number };
export type LiveSession = { path: string; isRunning: boolean; isWaiting: boolean };
type LiveCounts = { runningCount: number; waitingCount: number };
export type RecentRow = {
  name: string;
  path: string;
  agentId: string;
  runningCount: number;
  waitingCount: number;
  lastActivityMs: number | null;
  lastStartedAtMs: number | null;
};

const MAX_SESSION_NAME_BASE_LENGTH = 58;
const FALLBACK_SESSION_NAME_BASE = 'session';

function countLiveByPath(live: readonly LiveSession[]): Map<string, LiveCounts> {
  const countsByPath = new Map<string, LiveCounts>();
  for (const session of live) {
    const counts = countsByPath.get(session.path) ?? { runningCount: 0, waitingCount: 0 };
    if (session.isRunning) counts.runningCount += 1;
    if (session.isWaiting) counts.waitingCount += 1;
    countsByPath.set(session.path, counts);
  }
  return countsByPath;
}

function recencyOf(row: RecentRow): number {
  return Math.max(row.lastStartedAtMs ?? 0, row.lastActivityMs ?? 0);
}

export function orderRecentRows(
  projects: readonly ScannedProject[],
  starts: StartPicks['agentByPath'],
  live: readonly LiveSession[],
  pickAgentId: (rememberedAgentId: string | null) => string,
): RecentRow[] {
  const countsByPath = countLiveByPath(live);
  const rows = projects.map((project): RecentRow => {
    const remembered = starts[project.path] ?? null;
    const counts = countsByPath.get(project.path) ?? { runningCount: 0, waitingCount: 0 };
    return {
      name: project.name,
      path: project.path,
      agentId: pickAgentId(remembered?.agentId ?? null),
      runningCount: counts.runningCount,
      waitingCount: counts.waitingCount,
      lastActivityMs: project.lastActivityMs ?? null,
      lastStartedAtMs: remembered?.startedAtMs ?? null,
    };
  });
  return rows.sort((first, second) => recencyOf(second) - recencyOf(first));
}

export function filterRows<Row extends { name: string }>(rows: readonly Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => row.name.toLowerCase().includes(needle));
}

export function orderWorkspaceRows<Row extends { name: string; path: string }>(rows: readonly Row[], pickedPaths: readonly string[], query: string): { picked: Row[]; others: Row[] } {
  const picked = pickedPaths.flatMap((pickedPath) => rows.filter((row) => row.path === pickedPath));
  const others = filterRows(rows.filter((row) => !pickedPaths.includes(row.path)), query);
  return { picked, others };
}

export function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function sessionNameBase(folderName: string): string {
  const allowedCharacters = [...folderName].map((character) => (SESSION_NAME_PATTERN.test(character) ? character : '-'));
  return allowedCharacters.join('').slice(0, MAX_SESSION_NAME_BASE_LENGTH).trim() || FALLBACK_SESSION_NAME_BASE;
}
