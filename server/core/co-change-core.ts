import { LOG_FIELD_SEPARATOR } from './ingest-git-core.ts';
import {
  CHANGE_MAP_LIST_CAP,
  changeMapFactId,
  type CoChangeGap,
  type HotspotFact,
} from '../../shared/contracts/change-map.ts';

export const CO_CHANGE_LOG_ARGS = Object.freeze([
  'log', '--no-merges', '--name-only', '--format=%H%x1f%s', '-n', '2000',
]);
export const CO_CHANGE_MAX_FILES_PER_COMMIT = 40;

export type CommitFiles = { subject: string; paths: string[] };

export function parseCoChangeLog(logText: string): CommitFiles[] {
  const commits: CommitFiles[] = [];
  let currentCommit: CommitFiles | null = null;

  function finishCommit(): void {
    if (!currentCommit) return;
    if (currentCommit.paths.length <= CO_CHANGE_MAX_FILES_PER_COMMIT) commits.push(currentCommit);
    currentCommit = null;
  }

  for (const rawLine of logText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const separatorIndex = line.indexOf(LOG_FIELD_SEPARATOR);
    const isHeader = separatorIndex > 0 && /^[0-9a-f]{7,40}$/i.test(line.slice(0, separatorIndex));
    if (isHeader) {
      finishCommit();
      currentCommit = { subject: line.slice(separatorIndex + 1), paths: [] };
      continue;
    }
    if (!line || !currentCommit) continue;
    currentCommit.paths.push(line);
  }
  finishCommit();
  return commits;
}

export function computeCoChange({
  repoName,
  commits,
  changedPaths,
}: {
  repoName: string;
  commits: CommitFiles[];
  changedPaths: string[];
}): { coChangeGaps: CoChangeGap[]; hotspots: HotspotFact[] } {
  const changedPathSet = new Set(changedPaths);
  const commitCounts = new Map<string, number>();
  const fixCommitCounts = new Map<string, number>();
  const partnerCounts = new Map<string, Map<string, number>>();

  for (const commit of commits) {
    const paths = [...new Set(commit.paths)];
    const touchedChangedPaths = paths.filter((path) => changedPathSet.has(path));
    if (touchedChangedPaths.length === 0) continue;
    const isFixCommit = /^fix(?:\(|:|!)/i.test(commit.subject);

    for (const changedPath of touchedChangedPaths) {
      commitCounts.set(changedPath, (commitCounts.get(changedPath) ?? 0) + 1);
      if (isFixCommit) fixCommitCounts.set(changedPath, (fixCommitCounts.get(changedPath) ?? 0) + 1);
      let countsForPath = partnerCounts.get(changedPath);
      if (!countsForPath) {
        countsForPath = new Map();
        partnerCounts.set(changedPath, countsForPath);
      }
      for (const partner of paths) {
        if (changedPathSet.has(partner)) continue;
        countsForPath.set(partner, (countsForPath.get(partner) ?? 0) + 1);
      }
    }
  }

  const coChangeGaps: CoChangeGap[] = [];
  for (const [path, countsForPath] of partnerCounts) {
    const commitCount = commitCounts.get(path) ?? 0;
    for (const [partner, support] of countsForPath) {
      const confidence = support / commitCount;
      if (support < 3 || confidence < 0.5) continue;
      coChangeGaps.push({
        factId: changeMapFactId('co-change', repoName, path, partner),
        path,
        partner,
        support,
        confidence,
      });
    }
  }
  coChangeGaps.sort((left, right) =>
    right.confidence - left.confidence || right.support - left.support ||
    left.path.localeCompare(right.path) || left.partner.localeCompare(right.partner));

  const hotspots: HotspotFact[] = [];
  for (const [path, commitCount] of commitCounts) {
    const fixCommitCount = fixCommitCounts.get(path) ?? 0;
    if (commitCount < 5 || (fixCommitCount < 2 && commitCount < 15)) continue;
    hotspots.push({
      factId: changeMapFactId('hotspot', repoName, path),
      path,
      commitCount,
      fixCommitCount,
    });
  }
  hotspots.sort((left, right) =>
    right.fixCommitCount - left.fixCommitCount || right.commitCount - left.commitCount ||
    left.path.localeCompare(right.path));

  return {
    coChangeGaps: coChangeGaps.slice(0, CHANGE_MAP_LIST_CAP),
    hotspots: hotspots.slice(0, CHANGE_MAP_LIST_CAP),
  };
}
