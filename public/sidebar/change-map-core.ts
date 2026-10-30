import type { ChangeMap, ChangeMapFactKind, ConflictRisk, RepoChangeMap } from '#shared/contracts/change-map.ts';

const WIDE_BLAST_RADIUS_MIN = 10;
const CONFLICT_RISK_RANK: Record<ConflictRisk, number> = { low: 0, medium: 1, high: 2 };

export interface WorthALookLine {
  dedupeKey: string;
  groupKey: string;
  kind: ChangeMapFactKind;
  severity: number;
  path: string;
  openPath: string;
  heading: string;
  detail: string;
  conflictRisk: ConflictRisk | null;
}

export interface WorthALookGroup {
  groupKey: string;
  kind: ChangeMapFactKind;
  severity: number;
  heading: string;
  conflictRisk: ConflictRisk | null;
  lines: WorthALookLine[];
}

export interface FileHint {
  text: string;
  title: string;
}

interface ChangeMapRepoRef {
  name: string;
  sessionPathPrefix: string;
}

export interface ChangeMapView {
  worthALook: WorthALookGroup[];
  hintsByOpenPath: Map<string, FileHint[]>;
  repos: ChangeMapRepoRef[];
  errors: string[];
}

interface ProviderLookup {
  repo: RepoChangeMap;
  firstChangedPathByDirectory: Map<string, string>;
}

function firstChangedPathByDirectory(repo: RepoChangeMap): Map<string, string> {
  const firstPathByDirectory = new Map<string, string>();
  for (const file of repo.files) {
    const segments = file.path.split('/');
    for (let depth = 0; depth < segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/');
      const currentFirstPath = firstPathByDirectory.get(directory);
      if (currentFirstPath !== undefined && currentFirstPath.localeCompare(file.path) <= 0) continue;
      firstPathByDirectory.set(directory, file.path);
    }
  }
  return firstPathByDirectory;
}

function worthALookLines(repo: RepoChangeMap, providerByName: Map<string, ProviderLookup>): WorthALookLine[] {
  const lines: WorthALookLine[] = [];
  const changedPaths = new Set(repo.files.map((file) => file.path));
  for (const link of repo.links) {
    const provider = providerByName.get(link.providerRepo);
    const providerPath = provider?.firstChangedPathByDirectory.get(link.packageDir);
    const path = providerPath ?? link.importers.find((importer) => changedPaths.has(importer)) ?? link.importers[0] ?? link.consumerManifest;
    const pathOwner = providerPath && provider ? provider.repo : repo;
    const importerNoun = link.importerCount === 1 ? 'file' : 'files';
    const providerNoun = link.providerChangedPathCount === 1 ? 'file' : 'files';
    const changedImporterNoun = link.changedImporterCount === 1 ? 'file' : 'files';
    let detail = link.isLocalLink
      ? `Linked locally (${link.versionSpec}), so ${link.providerRepo} changes reach it now.`
      : `Uses ${link.versionSpec} from the registry, so ${link.providerRepo} changes reach it only after a publish.`;
    if (link.providerChangedPathCount > 0) detail += ` ${link.providerRepo} changed ${link.providerChangedPathCount} ${providerNoun} in ${link.packageDir || 'the repository root'}.`;
    if (link.changedImporterCount > 0) detail += ` ${link.changedImporterCount} importing ${changedImporterNoun} changed here.`;
    const linkKey = `link:${link.providerRepo}:${link.packageName}:${repo.name}`;
    lines.push({
      dedupeKey: linkKey, groupKey: linkKey, kind: 'link', severity: 6, path, openPath: `${pathOwner.sessionPathPrefix}${path}`,
      heading: `${repo.name} imports ${link.packageName} from ${link.providerRepo} in ${link.importerCount} ${importerNoun}`,
      detail,
      conflictRisk: null,
    });
  }
  for (const collision of repo.collisions) lines.push({
    dedupeKey: `collision:${repo.sessionPathPrefix}${collision.path}:${collision.otherSessionId}`,
    groupKey: `collision:${collision.otherSessionId}`, kind: 'collision', severity: 5,
    path: collision.path, openPath: `${repo.sessionPathPrefix}${collision.path}`,
    heading: `Also being changed in "${collision.otherSessionName}"`,
    detail: collision.conflictEvidence,
    conflictRisk: collision.conflictRisk,
  });
  for (const gap of repo.coChangeGaps) {
    const totalCommits = gap.confidence > 0 ? Math.round(gap.support / gap.confidence) : 0;
    lines.push({
      dedupeKey: `co-change:${repo.sessionPathPrefix}${gap.path}:${gap.partner}`,
      groupKey: `co-change:${repo.sessionPathPrefix}${gap.partner}`, kind: 'co-change', severity: 4,
      path: gap.path, openPath: `${repo.sessionPathPrefix}${gap.path}`,
      heading: `Usually changes with ${gap.partner}, which is not in this change`,
      detail: `${gap.support} of the ${totalCommits} commits that touched it also touched ${gap.partner}.`,
      conflictRisk: null,
    });
  }
  return lines;
}

function addHint(hintsByOpenPath: Map<string, FileHint[]>, openPath: string, hint: FileHint) {
  const hints = hintsByOpenPath.get(openPath) ?? [];
  hints.push(hint);
  hintsByOpenPath.set(openPath, hints);
}

function collectHints(repo: RepoChangeMap, hintsByOpenPath: Map<string, FileHint[]>) {
  for (const hotspot of repo.hotspots) addHint(hintsByOpenPath, `${repo.sessionPathPrefix}${hotspot.path}`, {
    text: 'often fixed',
    title: `${hotspot.fixCommitCount} of its last ${hotspot.commitCount} commits were fixes.`,
  });
  for (const blast of repo.blastRadius) {
    if (blast.transitiveDependentCount < WIDE_BLAST_RADIUS_MIN) continue;
    addHint(hintsByOpenPath, `${repo.sessionPathPrefix}${blast.path}`, {
      text: `${blast.transitiveDependentCount} depend on it`,
      title: `${blast.transitiveDependentCount} files depend on it: ${blast.directDependentCount} directly, ${blast.dependentTestCount} of them tests.`,
    });
  }
}

function byOpenPathOrder(left: WorthALookLine, right: WorthALookLine): number {
  return left.openPath.localeCompare(right.openPath) || left.dedupeKey.localeCompare(right.dedupeKey);
}

function conflictRiskRank(group: WorthALookGroup): number {
  return group.conflictRisk === null ? -1 : CONFLICT_RISK_RANK[group.conflictRisk];
}

function byWorthALookOrder(left: WorthALookGroup, right: WorthALookGroup): number {
  return right.severity - left.severity || conflictRiskRank(right) - conflictRiskRank(left) || left.heading.localeCompare(right.heading) || left.groupKey.localeCompare(right.groupKey);
}

function higherConflictRisk(current: ConflictRisk | null, candidate: ConflictRisk | null): ConflictRisk | null {
  if (current === null || candidate === null) return current ?? candidate;
  return CONFLICT_RISK_RANK[candidate] > CONFLICT_RISK_RANK[current] ? candidate : current;
}

function groupWorthALookLines(lines: Iterable<WorthALookLine>): WorthALookGroup[] {
  const groupByKey = new Map<string, WorthALookGroup>();
  for (const line of lines) {
    const group = groupByKey.get(line.groupKey);
    if (group) {
      group.lines.push(line);
      group.conflictRisk = higherConflictRisk(group.conflictRisk, line.conflictRisk);
      continue;
    }
    groupByKey.set(line.groupKey, {
      groupKey: line.groupKey, kind: line.kind, severity: line.severity, heading: line.heading, conflictRisk: line.conflictRisk, lines: [line],
    });
  }
  const groups = [...groupByKey.values()];
  for (const group of groups) group.lines.sort(byOpenPathOrder);
  return groups.sort(byWorthALookOrder);
}

export function buildChangeMapView(map: ChangeMap): ChangeMapView {
  const providerNames = new Set(map.repos.flatMap((repo) => repo.links.map((link) => link.providerRepo)));
  const providerByName = new Map<string, ProviderLookup>();
  for (const repo of map.repos) {
    if (!providerNames.has(repo.name) || providerByName.has(repo.name)) continue;
    providerByName.set(repo.name, { repo, firstChangedPathByDirectory: firstChangedPathByDirectory(repo) });
  }
  const lineByDedupeKey = new Map<string, WorthALookLine>();
  const hintsByOpenPath = new Map<string, FileHint[]>();
  const errors = map.error ? [map.error] : [];
  for (const repo of map.repos) {
    for (const line of worthALookLines(repo, providerByName)) {
      if (!lineByDedupeKey.has(line.dedupeKey)) lineByDedupeKey.set(line.dedupeKey, line);
    }
    collectHints(repo, hintsByOpenPath);
    if (repo.error) errors.push(map.repos.length > 1 ? `${repo.name}: ${repo.error}` : repo.error);
  }
  return {
    worthALook: groupWorthALookLines(lineByDedupeKey.values()),
    hintsByOpenPath,
    repos: map.repos.map((repo) => ({ name: repo.name, sessionPathPrefix: repo.sessionPathPrefix })),
    errors,
  };
}

export function repoNameForPath(repos: readonly ChangeMapRepoRef[], openPath: string): string | null {
  let bestMatch: ChangeMapRepoRef | null = null;
  for (const repo of repos) {
    if (!openPath.startsWith(repo.sessionPathPrefix)) continue;
    if (bestMatch && bestMatch.sessionPathPrefix.length >= repo.sessionPathPrefix.length) continue;
    bestMatch = repo;
  }
  return bestMatch?.name ?? null;
}
