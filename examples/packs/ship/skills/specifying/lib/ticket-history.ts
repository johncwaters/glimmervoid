import { spawnSync } from "node:child_process";

export type TicketHistory = Map<string, Map<string, number[]>>;
export type TicketHistoryRead = { outcome: "READ"; history: TicketHistory } | { outcome: "UNREADABLE"; reason: string };

export type TicketHistoryScope = { sinceMs?: number; isPushedOnly?: boolean };

function selectRefArguments(repoRoot: string, isPushedOnly: boolean): string[] {
  if (!isPushedOnly) return ["--all"];
  const remotesProcess = spawnSync("git", ["-C", repoRoot, "remote"], { encoding: "utf8" });
  return remotesProcess.status === 0 && remotesProcess.stdout.trim() !== "" ? ["--remotes"] : ["--branches"];
}

export function readTicketHistory(repoRoot: string, { sinceMs, isPushedOnly = false }: TicketHistoryScope = {}): TicketHistoryRead {
  const sinceArguments = sinceMs === undefined ? [] : [`--since=@${Math.floor(sinceMs / 1000)}`];
  const historyProcess = spawnSync("git", ["-C", repoRoot, "log", ...selectRefArguments(repoRoot, isPushedOnly), ...sinceArguments, "--format=%x1e%ct%x1f%(trailers:key=Ticket,valueonly)"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (historyProcess.status !== 0) return { outcome: "UNREADABLE", reason: historyProcess.error?.message ?? historyProcess.stderr.trim() };
  const history: TicketHistory = new Map();
  for (const commit of historyProcess.stdout.split("\x1e").slice(1)) {
    const [timestamp, trailers = ""] = commit.split("\x1f");
    const committedAtMs = Number(timestamp) * 1000;
    for (const trailer of trailers.trim().split(/\r?\n/)) {
      const ticket = trailer.trim().match(/^([^\s/]+)\/([^\s/]+)$/);
      if (!ticket) continue;
      const [, slug, unitId] = ticket;
      const commitTimesByUnitId = history.get(slug) ?? new Map<string, number[]>();
      commitTimesByUnitId.set(unitId, [...(commitTimesByUnitId.get(unitId) ?? []), committedAtMs]);
      history.set(slug, commitTimesByUnitId);
    }
  }
  return { outcome: "READ", history };
}
