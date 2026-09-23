import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeMap, CrossRepoLink, RepoChangeMap } from '../shared/contracts/change-map.ts';
import { changeMapFactId } from '../shared/contracts/change-map.ts';
import { buildChangeMapView } from '../public/sidebar/change-map-core.ts';

function makeRepo(overrides: Partial<RepoChangeMap> = {}): RepoChangeMap {
  return {
    name: 'glimmervoid', root: '/repo', sessionPathPrefix: '', base: 'main', files: [], links: [], subsystems: [], coChangeGaps: [],
    hotspots: [], blastRadius: [], untestedFiles: [], collisions: [], error: null, ...overrides,
  };
}

function makeMap(repo: RepoChangeMap, overrides: Partial<ChangeMap> = {}): ChangeMap {
  return {
    sessionId: 'session', sig: 'sig', generatedAt: 1, repos: [repo], narrative: null,
    narratorState: 'disabled', ...overrides,
  };
}

function makeLink(overrides: Partial<CrossRepoLink> = {}): CrossRepoLink {
  return {
    factId: changeMapFactId('link', 'consumer', 'provider'), providerRepo: 'provider', packageName: '@example/provider',
    packageDir: 'packages/provider', consumerManifest: 'package.json', versionSpec: '^1.0.0', isLocalLink: false,
    providerChangedPathCount: 0, importers: ['src/app.ts'], importerCount: 1, changedImporterCount: 0,
    ...overrides,
  };
}

test('warnings have severity order and plain English copy for every kind', () => {
  const path = 'session/sessions.ts';
  const repo = makeRepo({
    files: [{ factId: changeMapFactId('file', 'glimmervoid', path), path, status: 'modified', isCommitted: true }],
    collisions: [{ factId: changeMapFactId('collision', 'glimmervoid', path, 'other'), path, otherSessionId: 'other', otherSessionName: 'fix-resume' }],
    coChangeGaps: [{ factId: changeMapFactId('co-change', 'glimmervoid', path, 'session/core/spawn-env.ts'), path, partner: 'session/core/spawn-env.ts', support: 4, confidence: 0.8 }],
    untestedFiles: [{ factId: changeMapFactId('untested', 'glimmervoid', path), path }],
    hotspots: [{ factId: changeMapFactId('hotspot', 'glimmervoid', path), path, commitCount: 19, fixCommitCount: 7 }],
    blastRadius: [{ factId: changeMapFactId('blast', 'glimmervoid', path), path, directDependents: [], directDependentCount: 3, transitiveDependentCount: 10, dependentTests: [], dependentTestCount: 2 }],
  });
  const view = buildChangeMapView(makeMap(repo));
  const warnings = view.repos[0]?.warnings ?? [];
  assert.deepEqual(warnings.map((warning) => warning.kind), ['collision', 'co-change', 'untested', 'hotspot', 'blast']);
  assert.deepEqual(warnings.map((warning) => warning.severity), [5, 4, 3, 2, 1]);
  assert.deepEqual(warnings.map((warning) => warning.headline), [
    'session/sessions.ts is also changed in "fix-resume"',
    'Usually changes with session/core/spawn-env.ts (4 of 5 commits)',
    'No test reaches session/sessions.ts',
    'session/sessions.ts is a hotspot',
    'Wide blast radius: 10 files depend on session/sessions.ts',
  ]);
  assert.equal(warnings[0]?.factId, repo.collisions[0]?.factId);
  assert.deepEqual(warnings.map((warning) => warning.openPath), warnings.map((warning) => warning.path));
  assert.deepEqual(view.repos[0]?.files[0], { path, openPath: path, status: 'modified', isCommitted: true, dependentCount: 10, testCount: 2 });
});

test('workspace warning and file rows open prefixed paths while displaying repo paths', () => {
  const consumer = makeRepo({
    name: 'consumer', sessionPathPrefix: 'consumer/',
    files: [{ factId: changeMapFactId('file', 'consumer', 'src/app.ts'), path: 'src/app.ts', status: 'modified', isCommitted: false }],
    untestedFiles: [{ factId: changeMapFactId('untested', 'consumer', 'src/app.ts'), path: 'src/app.ts' }],
  });
  const provider = makeRepo({
    name: 'provider', sessionPathPrefix: 'provider/',
    files: [{ factId: changeMapFactId('file', 'provider', 'src/index.ts'), path: 'src/index.ts', status: 'added', isCommitted: true }],
    hotspots: [{ factId: changeMapFactId('hotspot', 'provider', 'src/index.ts'), path: 'src/index.ts', commitCount: 2, fixCommitCount: 1 }],
  });
  const view = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] }));
  assert.deepEqual(view.repos.map((repo) => repo.warnings.map(({ path, openPath }) => ({ path, openPath }))), [
    [{ path: 'src/app.ts', openPath: 'consumer/src/app.ts' }],
    [{ path: 'src/index.ts', openPath: 'provider/src/index.ts' }],
  ]);
  assert.deepEqual(view.repos.map((repo) => repo.files.map(({ path, openPath }) => ({ path, openPath }))), [
    [{ path: 'src/app.ts', openPath: 'consumer/src/app.ts' }],
    [{ path: 'src/index.ts', openPath: 'provider/src/index.ts' }],
  ]);
});

test('link warning copy covers registry and local links with singular and plural counts', () => {
  const consumer = makeRepo({ name: 'consumer', links: [
    makeLink({ providerChangedPathCount: 1, changedImporterCount: 2 }),
    makeLink({
      factId: changeMapFactId('link', 'consumer', 'provider', 'local'), packageDir: '',
      versionSpec: 'workspace:*', isLocalLink: true, providerChangedPathCount: 2,
      importerCount: 3, changedImporterCount: 1,
    }),
  ] });
  const warnings = buildChangeMapView(makeMap(consumer)).repos[0]?.warnings ?? [];
  assert.deepEqual(warnings.map((warning) => warning.kind), ['link', 'link']);
  assert.deepEqual(warnings.map((warning) => warning.severity), [6, 6]);
  assert.deepEqual(warnings.map((warning) => warning.headline), [
    'consumer imports @example/provider from provider in 1 file',
    'consumer imports @example/provider from provider in 3 files',
  ]);
  assert.deepEqual(warnings.map((warning) => warning.detail), [
    'Uses ^1.0.0 from the registry, so provider changes reach it only after a publish. provider changed 1 file in packages/provider. 2 importing files changed here.',
    'Linked locally (workspace:*), so provider changes reach it now. provider changed 2 files in the repository root. 1 importing file changed here.',
  ]);
});

test('link warnings open the first provider file in the package and fall back to an importer', () => {
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'outside.ts'), path: 'outside.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'packages/provider/z.ts'), path: 'packages/provider/z.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'packages/provider/a.ts'), path: 'packages/provider/a.ts', status: 'modified', isCommitted: false },
  ] });
  const consumer = makeRepo({ name: 'consumer', sessionPathPrefix: 'consumer/', links: [makeLink({ providerChangedPathCount: 2 })] });
  const map = makeMap(consumer, { repos: [consumer, provider] });
  const view = buildChangeMapView(map);
  assert.deepEqual(view.repos[0]?.warnings[0] && { path: view.repos[0].warnings[0].path, openPath: view.repos[0].warnings[0].openPath }, {
    path: 'packages/provider/a.ts', openPath: 'provider/packages/provider/a.ts',
  });
  assert.equal(view.repos[0]?.header.fileCount, 0);
  assert.equal(view.emptyState, null);

  const fallback = buildChangeMapView(makeMap(consumer, { repos: [consumer, makeRepo({ name: 'provider', sessionPathPrefix: 'provider/' })] }));
  assert.deepEqual(fallback.repos[0]?.warnings[0] && { path: fallback.repos[0].warnings[0].path, openPath: fallback.repos[0].warnings[0].openPath }, {
    path: 'src/app.ts', openPath: 'consumer/src/app.ts',
  });
  assert.equal(fallback.emptyState, null);
});

test('small blast radius is omitted and committed counts are per repository', () => {
  const repo = makeRepo({
    files: [
      { factId: changeMapFactId('file', 'glimmervoid', 'a.ts'), path: 'a.ts', status: 'added', isCommitted: true },
      { factId: changeMapFactId('file', 'glimmervoid', 'b.ts'), path: 'b.ts', status: 'untracked', isCommitted: false },
    ],
    subsystems: [{ factId: changeMapFactId('subsystem', 'glimmervoid', 'public/AGENTS.md'), agentsPath: 'public/AGENTS.md', title: 'Frontend', paths: ['a.ts', 'b.ts'] }],
    blastRadius: [{ factId: changeMapFactId('blast', 'glimmervoid', 'a.ts'), path: 'a.ts', directDependents: [], directDependentCount: 1, transitiveDependentCount: 9, dependentTests: [], dependentTestCount: 0 }],
  });
  const secondRepo = makeRepo({ name: 'tools', base: 'develop', files: [
    { factId: changeMapFactId('file', 'tools', 'cli.ts'), path: 'cli.ts', status: 'modified', isCommitted: false },
  ] });
  const view = buildChangeMapView(makeMap(repo, { repos: [repo, secondRepo] }));
  assert.deepEqual(view.repos[0]?.header, { name: 'glimmervoid', fileCount: 2, committedCount: 1, uncommittedCount: 1, base: 'main' });
  assert.deepEqual(view.repos[1]?.header, { name: 'tools', fileCount: 1, committedCount: 0, uncommittedCount: 1, base: 'develop' });
  assert.deepEqual(view.repos[0]?.subsystems, [{ title: 'Frontend', fileCount: 2 }]);
  assert.deepEqual(view.repos[0]?.warnings, []);
});

test('empty map and repository error have distinct messages', () => {
  assert.equal(buildChangeMapView(makeMap(makeRepo())).emptyState, 'No changed files in this session.');
  const errored = buildChangeMapView(makeMap(makeRepo({ error: 'Git lookup failed' })));
  assert.equal(errored.emptyState, null);
  assert.equal(errored.repos[0]?.error, 'Git lookup failed');
});

test('a map that failed to build shows its error instead of the empty state', () => {
  const failed = buildChangeMapView({ ...makeMap(makeRepo()), repos: [], error: 'Change map could not be built: boom' });
  assert.equal(failed.emptyState, null);
  assert.equal(failed.error, 'Change map could not be built: boom');
  assert.equal(buildChangeMapView(makeMap(makeRepo())).error, null);
});

test('narrator states display status or linked claims', () => {
  const repo = makeRepo();
  const claims = [{ text: 'Session changes touch startup.', factIds: [changeMapFactId('file', 'glimmervoid', 'a.ts')] }];
  assert.equal(buildChangeMapView(makeMap(repo, { narratorState: 'disabled' })).narrative.status, null);
  for (const state of ['pending', 'failed'] as const) {
    const view = buildChangeMapView(makeMap(repo, { narratorState: state }));
    assert.ok(view.narrative.status);
    assert.deepEqual(view.narrative.claims, []);
  }
  const ready = buildChangeMapView(makeMap(repo, { narratorState: 'ready', narrative: { factsHash: 'hash', model: 'model', claims } }));
  assert.equal(ready.narrative.status, null);
  assert.deepEqual(ready.narrative.claims, claims);
});

test('link warnings without a changed provider file open the first changed importer', () => {
  const consumer = makeRepo({
    name: 'consumer', sessionPathPrefix: 'consumer/',
    files: [{ factId: changeMapFactId('file', 'consumer', 'src/z.ts'), path: 'src/z.ts', status: 'modified', isCommitted: false }],
    links: [makeLink({ importers: ['src/a.ts', 'src/z.ts'], importerCount: 2, changedImporterCount: 1 })],
  });
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'outside.ts'), path: 'outside.ts', status: 'modified', isCommitted: false },
  ] });
  const linkWarning = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] })).repos[0]?.warnings.find((warning) => warning.kind === 'link');
  assert.deepEqual(linkWarning && { path: linkWarning.path, openPath: linkWarning.openPath }, { path: 'src/z.ts', openPath: 'consumer/src/z.ts' });
});

test('link warnings on a root package open the first changed provider file anywhere in the repository', () => {
  const consumer = makeRepo({ name: 'consumer', sessionPathPrefix: 'consumer/', links: [makeLink({ packageDir: '', providerChangedPathCount: 2 })] });
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'src/b.ts'), path: 'src/b.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'lib/a.ts'), path: 'lib/a.ts', status: 'modified', isCommitted: false },
  ] });
  const linkWarning = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] })).repos[0]?.warnings[0];
  assert.deepEqual(linkWarning && { path: linkWarning.path, openPath: linkWarning.openPath }, { path: 'lib/a.ts', openPath: 'provider/lib/a.ts' });
});
