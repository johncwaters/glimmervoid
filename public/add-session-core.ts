import { SESSION_NAME_PATTERN } from '#shared/contracts/session.ts';

type RememberedStart = { agentId: string; startedAtMs: number };
export type RememberedStarts = Record<string, RememberedStart>;
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
type PermissionFields = { dangerouslySkipPermissions: true; saneYolo: true } | Record<string, never>;
type PermissionChoice = { fields: PermissionFields; isUnprotectedHintShown: boolean };

const MAX_REMEMBERED_STARTS = 50;
const MAX_SESSION_NAME_BASE_LENGTH = 58;
const FALLBACK_SESSION_NAME_BASE = 'session';

export function parseRememberedStarts(value: unknown): RememberedStarts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const starts: RememberedStarts = {};
  for (const [path, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { agentId, startedAtMs } = entry as { agentId?: unknown; startedAtMs?: unknown };
    if (typeof agentId !== 'string' || !agentId) continue;
    if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) continue;
    starts[path] = { agentId, startedAtMs };
  }
  return starts;
}

export function rememberStart(starts: RememberedStarts, path: string, agentId: string, nowMs: number): RememberedStarts {
  const newestFirst = Object.entries({ ...starts, [path]: { agentId, startedAtMs: nowMs } })
    .sort(([, first], [, second]) => second.startedAtMs - first.startedAtMs)
    .slice(0, MAX_REMEMBERED_STARTS);
  return Object.fromEntries(newestFirst);
}

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
  starts: RememberedStarts,
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

export function filterRows(rows: readonly RecentRow[], query: string): RecentRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => row.name.toLowerCase().includes(needle));
}

export function decidePermissions(input: { isSaneYoloInstalled: boolean; isSaneYoloSettingOn: boolean; isShell: boolean }): PermissionChoice {
  if (input.isShell) return { fields: {}, isUnprotectedHintShown: false };
  const canProtect = input.isSaneYoloInstalled && input.isSaneYoloSettingOn;
  if (!canProtect) return { fields: {}, isUnprotectedHintShown: true };
  return { fields: { dangerouslySkipPermissions: true, saneYolo: true }, isUnprotectedHintShown: false };
}

export function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function sessionNameBase(folderName: string): string {
  const allowedCharacters = [...folderName].map((character) => (SESSION_NAME_PATTERN.test(character) ? character : '-'));
  return allowedCharacters.join('').slice(0, MAX_SESSION_NAME_BASE_LENGTH).trim() || FALLBACK_SESSION_NAME_BASE;
}
