import type { ChangeMap, ChangeMapFactKind, RepoChangeMap } from '#shared/contracts/change-map.ts';

export interface ChangeMapWarningView {
  factId: string;
  kind: ChangeMapFactKind;
  severity: number;
  path: string;
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
  files: { path: string; status: RepoChangeMap['files'][number]['status']; isCommitted: boolean; dependentCount: number; testCount: number }[];
  error: string | null;
}

export interface ChangeMapView {
  repos: ChangeMapRepoView[];
  narrative: { state: ChangeMap['narratorState']; claims: { text: string; factIds: string[] }[]; status: string | null };
  emptyState: string | null;
  error: string | null;
}

function warningViews(repo: RepoChangeMap): ChangeMapWarningView[] {
  const warnings: ChangeMapWarningView[] = [];
  for (const collision of repo.collisions) warnings.push({
    factId: collision.factId, kind: 'collision', severity: 5, path: collision.path,
    headline: `${collision.path} is also changed in "${collision.otherSessionName}"`,
    detail: 'Another live session is changing this file.',
  });
  for (const gap of repo.coChangeGaps) {
    const totalCommits = gap.confidence > 0 ? Math.round(gap.support / gap.confidence) : 0;
    warnings.push({
      factId: gap.factId, kind: 'co-change', severity: 4, path: gap.path,
      headline: `Usually changes with ${gap.partner} (${gap.support} of ${totalCommits} commits)`,
      detail: `${gap.partner} is absent from these changes.`,
    });
  }
  for (const untested of repo.untestedFiles) warnings.push({
    factId: untested.factId, kind: 'untested', severity: 3, path: untested.path,
    headline: `No test reaches ${untested.path}`,
    detail: 'No dependent test was found in the import graph.',
  });
  for (const hotspot of repo.hotspots) warnings.push({
    factId: hotspot.factId, kind: 'hotspot', severity: 2, path: hotspot.path,
    headline: `${hotspot.path} is a hotspot`,
    detail: `${hotspot.fixCommitCount} of its last ${hotspot.commitCount} commits were fixes.`,
  });
  for (const blast of repo.blastRadius) {
    if (blast.transitiveDependentCount < 10) continue;
    warnings.push({
      factId: blast.factId, kind: 'blast', severity: 1, path: blast.path,
      headline: `Wide blast radius: ${blast.transitiveDependentCount} files depend on ${blast.path}`,
      detail: `${blast.directDependentCount} direct dependents; ${blast.dependentTestCount} dependent tests.`,
    });
  }
  return warnings.sort((left, right) => right.severity - left.severity || left.path.localeCompare(right.path) || left.factId.localeCompare(right.factId));
}

function repoView(repo: RepoChangeMap): ChangeMapRepoView {
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
    warnings: warningViews(repo),
    files: repo.files.map((file) => ({
      path: file.path,
      status: file.status,
      isCommitted: file.isCommitted,
      dependentCount: blastByPath.get(file.path)?.transitiveDependentCount ?? 0,
      testCount: blastByPath.get(file.path)?.dependentTestCount ?? 0,
    })),
    error: repo.error,
  };
}

export function buildChangeMapView(map: ChangeMap): ChangeMapView {
  const repos = map.repos.map(repoView);
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
    emptyState: !map.error && repos.every((repo) => repo.header.fileCount === 0) && repos.every((repo) => !repo.error)
      ? 'No changed files in this session.' : null,
    error: map.error ?? null,
  };
}
