import type { ChangeMap, ChangeMapFactKind, RepoChangeMap } from '#shared/contracts/change-map.ts';

export interface ChangeMapWarningView {
  factId: string;
  kind: ChangeMapFactKind;
  severity: number;
  path: string;
  openPath: string;
  headline: string;
  detail: string;
}

export interface ChangeMapRepoView {
  header: {
    name: string;
    fileCount: number;
    committedCount: number;
    uncommittedCount: number;
    base: string | null;
  };
  subsystems: { title: string; fileCount: number }[];
  warnings: ChangeMapWarningView[];
  files: { path: string; openPath: string; status: RepoChangeMap['files'][number]['status']; isCommitted: boolean; dependentCount: number; testCount: number }[];
  error: string | null;
}

export interface ChangeMapView {
  repos: ChangeMapRepoView[];
  narrative: { state: ChangeMap['narratorState']; claims: { text: string; factIds: string[] }[]; status: string | null };
  emptyState: string | null;
  error: string | null;
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

function warningViews(repo: RepoChangeMap, providerByName: Map<string, ProviderLookup>): ChangeMapWarningView[] {
  const warnings: ChangeMapWarningView[] = [];
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
    warnings.push({
      factId: link.factId, kind: 'link', severity: 6, path, openPath: `${pathOwner.sessionPathPrefix}${path}`,
      headline: `${repo.name} imports ${link.packageName} from ${link.providerRepo} in ${link.importerCount} ${importerNoun}`,
      detail,
    });
  }
  for (const collision of repo.collisions) warnings.push({
    factId: collision.factId, kind: 'collision', severity: 5, path: collision.path, openPath: `${repo.sessionPathPrefix}${collision.path}`,
    headline: `${collision.path} is also changed in "${collision.otherSessionName}"`,
    detail: 'Another live session is changing this file.',
  });
  for (const gap of repo.coChangeGaps) {
    const totalCommits = gap.confidence > 0 ? Math.round(gap.support / gap.confidence) : 0;
    warnings.push({
      factId: gap.factId, kind: 'co-change', severity: 4, path: gap.path, openPath: `${repo.sessionPathPrefix}${gap.path}`,
      headline: `Usually changes with ${gap.partner} (${gap.support} of ${totalCommits} commits)`,
      detail: `${gap.partner} is absent from these changes.`,
    });
  }
  for (const untested of repo.untestedFiles) warnings.push({
    factId: untested.factId, kind: 'untested', severity: 3, path: untested.path, openPath: `${repo.sessionPathPrefix}${untested.path}`,
    headline: `No test reaches ${untested.path}`,
    detail: 'No dependent test was found in the import graph.',
  });
  for (const hotspot of repo.hotspots) warnings.push({
    factId: hotspot.factId, kind: 'hotspot', severity: 2, path: hotspot.path, openPath: `${repo.sessionPathPrefix}${hotspot.path}`,
    headline: `${hotspot.path} is a hotspot`,
    detail: `${hotspot.fixCommitCount} of its last ${hotspot.commitCount} commits were fixes.`,
  });
  for (const blast of repo.blastRadius) {
    if (blast.transitiveDependentCount < 10) continue;
    warnings.push({
      factId: blast.factId, kind: 'blast', severity: 1, path: blast.path, openPath: `${repo.sessionPathPrefix}${blast.path}`,
      headline: `Wide blast radius: ${blast.transitiveDependentCount} files depend on ${blast.path}`,
      detail: `${blast.directDependentCount} direct dependents; ${blast.dependentTestCount} dependent tests.`,
    });
  }
  return warnings.sort((left, right) => right.severity - left.severity || left.path.localeCompare(right.path) || left.factId.localeCompare(right.factId));
}

function repoView(repo: RepoChangeMap, providerByName: Map<string, ProviderLookup>): ChangeMapRepoView {
  const blastByPath = new Map(repo.blastRadius.map((blast) => [blast.path, blast]));
  const committedCount = repo.files.filter((file) => file.isCommitted).length;
  return {
    header: {
      name: repo.name,
      fileCount: repo.files.length,
      committedCount,
      uncommittedCount: repo.files.length - committedCount,
      base: repo.base,
    },
    subsystems: repo.subsystems.map((subsystem) => ({ title: subsystem.title, fileCount: subsystem.paths.length })),
    warnings: warningViews(repo, providerByName),
    files: repo.files.map((file) => ({
      path: file.path,
      openPath: `${repo.sessionPathPrefix}${file.path}`,
      status: file.status,
      isCommitted: file.isCommitted,
      dependentCount: blastByPath.get(file.path)?.transitiveDependentCount ?? 0,
      testCount: blastByPath.get(file.path)?.dependentTestCount ?? 0,
    })),
    error: repo.error,
  };
}

export function buildChangeMapView(map: ChangeMap): ChangeMapView {
  const providerNames = new Set(map.repos.flatMap((repo) => repo.links.map((link) => link.providerRepo)));
  const providerByName = new Map<string, ProviderLookup>();
  for (const repo of map.repos) {
    if (!providerNames.has(repo.name) || providerByName.has(repo.name)) continue;
    providerByName.set(repo.name, { repo, firstChangedPathByDirectory: firstChangedPathByDirectory(repo) });
  }
  const repos = map.repos.map((repo) => repoView(repo, providerByName));
  const statusByState: Record<ChangeMap['narratorState'], string | null> = {
    disabled: null,
    pending: 'Narrative is being prepared.',
    ready: null,
    failed: 'Narrative could not be prepared.',
  };
  return {
    repos,
    narrative: {
      state: map.narratorState,
      claims: map.narratorState === 'ready' ? map.narrative?.claims.map((claim) => ({ text: claim.text, factIds: claim.factIds })) ?? [] : [],
      status: statusByState[map.narratorState],
    },
    emptyState: !map.error && repos.every((repo) => repo.header.fileCount === 0 && repo.warnings.length === 0) && repos.every((repo) => !repo.error)
      ? 'No changed files in this session.' : null,
    error: map.error ?? null,
  };
}
