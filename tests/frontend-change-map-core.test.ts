import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeMap, CrossRepoLink, RepoChangeMap } from '../shared/contracts/change-map.ts';
import { changeMapFactId } from '../shared/contracts/change-map.ts';
import { buildChangeMapView, repoNameForPath } from '../public/sidebar/change-map-core.ts';

function makeRepo(overrides: Partial<RepoChangeMap> = {}): RepoChangeMap {
  return {
    name: 'glimmervoid', root: '/repo', sessionPathPrefix: '', base: 'main', files: [], links: [], subsystems: [], coChangeGaps: [],
    hotspots: [], blastRadius: [], untestedFiles: [], collisions: [], error: null, ...overrides,
  };
}

function makeMap(repo: RepoChangeMap, overrides: Partial<ChangeMap> = {}): ChangeMap {
  return {
    sessionId: 'session', sig: 'sig', generatedAt: 1, repos: [repo], ...overrides,
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

test('worth a look lists actionable kinds in severity order, naming each changed file in plain words', () => {
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
  assert.deepEqual(view.worthALook.map(({ kind, path: linePath, text }) => ({ kind, path: linePath, text })), [
    { kind: 'collision', path, text: 'Also being changed in "fix-resume"' },
    { kind: 'co-change', path, text: 'Usually changes with session/core/spawn-env.ts, which is not in this change' },
    { kind: 'untested', path, text: 'No test reaches it' },
  ]);
  assert.equal(view.worthALook[1]?.detail, '4 of the 5 commits that touched it also touched session/core/spawn-env.ts.');
  assert.deepEqual(view.hintsByOpenPath.get(path), [
    { text: 'often fixed', title: '7 of its last 19 commits were fixes.' },
    { text: '10 depend on it', title: '10 files depend on it: 3 directly, 2 of them tests.' },
  ]);
});

test('worth a look keeps one line per file and partner, so two changed files missing one partner stay apart', () => {
  const gap = (path: string, partner: string) => ({ factId: changeMapFactId('co-change', 'glimmervoid', path, partner), path, partner, support: 3, confidence: 0.5 });
  const repo = makeRepo({ coChangeGaps: [gap('a.ts', 'shared.ts'), gap('b.ts', 'shared.ts'), gap('a.ts', 'shared.ts')] });
  assert.deepEqual(buildChangeMapView(makeMap(repo)).worthALook.map((line) => line.path), ['a.ts', 'b.ts']);
});

test('workspace lines and hints open prefixed paths while displaying repo paths, and each repo is named by its prefix', () => {
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
  assert.deepEqual(view.worthALook.map(({ path, openPath }) => ({ path, openPath })), [{ path: 'src/app.ts', openPath: 'consumer/src/app.ts' }]);
  assert.deepEqual([...view.hintsByOpenPath.keys()], ['provider/src/index.ts']);
  assert.equal(repoNameForPath(view.repos, 'provider/src/index.ts'), 'provider');
  assert.equal(repoNameForPath(view.repos, 'elsewhere/x.ts'), null);
});

test('link line copy covers registry and local links with singular and plural counts', () => {
  const consumer = makeRepo({ name: 'consumer', links: [
    makeLink({ providerChangedPathCount: 1, changedImporterCount: 2 }),
    makeLink({
      factId: changeMapFactId('link', 'consumer', 'provider', 'local'), packageName: '@example/local', packageDir: '',
      versionSpec: 'workspace:*', isLocalLink: true, providerChangedPathCount: 2,
      importerCount: 3, changedImporterCount: 1,
    }),
  ] });
  const lines = buildChangeMapView(makeMap(consumer)).worthALook;
  assert.deepEqual(lines.map((line) => [line.kind, line.severity]), [['link', 6], ['link', 6]]);
  assert.deepEqual(lines.map((line) => line.text).sort(), [
    'consumer imports @example/local from provider in 3 files',
    'consumer imports @example/provider from provider in 1 file',
  ]);
  assert.deepEqual(lines.map((line) => line.detail).sort(), [
    'Linked locally (workspace:*), so provider changes reach it now. provider changed 2 files in the repository root. 1 importing file changed here.',
    'Uses ^1.0.0 from the registry, so provider changes reach it only after a publish. provider changed 1 file in packages/provider. 2 importing files changed here.',
  ]);
});

test('link lines open the first provider file in the package and fall back to an importer', () => {
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'outside.ts'), path: 'outside.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'packages/provider/z.ts'), path: 'packages/provider/z.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'packages/provider/a.ts'), path: 'packages/provider/a.ts', status: 'modified', isCommitted: false },
  ] });
  const consumer = makeRepo({ name: 'consumer', sessionPathPrefix: 'consumer/', links: [makeLink({ providerChangedPathCount: 2 })] });
  const line = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] })).worthALook[0];
  assert.deepEqual(line && { path: line.path, openPath: line.openPath }, { path: 'packages/provider/a.ts', openPath: 'provider/packages/provider/a.ts' });

  const fallback = buildChangeMapView(makeMap(consumer, { repos: [consumer, makeRepo({ name: 'provider', sessionPathPrefix: 'provider/' })] })).worthALook[0];
  assert.deepEqual(fallback && { path: fallback.path, openPath: fallback.openPath }, { path: 'src/app.ts', openPath: 'consumer/src/app.ts' });
});

test('link lines without a changed provider file open the first changed importer', () => {
  const consumer = makeRepo({
    name: 'consumer', sessionPathPrefix: 'consumer/',
    files: [{ factId: changeMapFactId('file', 'consumer', 'src/z.ts'), path: 'src/z.ts', status: 'modified', isCommitted: false }],
    links: [makeLink({ importers: ['src/a.ts', 'src/z.ts'], importerCount: 2, changedImporterCount: 1 })],
  });
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'outside.ts'), path: 'outside.ts', status: 'modified', isCommitted: false },
  ] });
  const line = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] })).worthALook.find((candidate) => candidate.kind === 'link');
  assert.deepEqual(line && { path: line.path, openPath: line.openPath }, { path: 'src/z.ts', openPath: 'consumer/src/z.ts' });
});

test('link lines on a root package open the first changed provider file anywhere in the repository', () => {
  const consumer = makeRepo({ name: 'consumer', sessionPathPrefix: 'consumer/', links: [makeLink({ packageDir: '', providerChangedPathCount: 2 })] });
  const provider = makeRepo({ name: 'provider', sessionPathPrefix: 'provider/', files: [
    { factId: changeMapFactId('file', 'provider', 'src/b.ts'), path: 'src/b.ts', status: 'modified', isCommitted: false },
    { factId: changeMapFactId('file', 'provider', 'lib/a.ts'), path: 'lib/a.ts', status: 'modified', isCommitted: false },
  ] });
  const line = buildChangeMapView(makeMap(consumer, { repos: [consumer, provider] })).worthALook[0];
  assert.deepEqual(line && { path: line.path, openPath: line.openPath }, { path: 'lib/a.ts', openPath: 'provider/lib/a.ts' });
});

test('a small blast radius gives no hint', () => {
  const repo = makeRepo({
    blastRadius: [{ factId: changeMapFactId('blast', 'glimmervoid', 'a.ts'), path: 'a.ts', directDependents: [], directDependentCount: 1, transitiveDependentCount: 9, dependentTests: [], dependentTestCount: 0 }],
  });
  const view = buildChangeMapView(makeMap(repo));
  assert.equal(view.hintsByOpenPath.size, 0);
  assert.deepEqual(view.worthALook, []);
});

test('a map or repository that failed to build reports its error, named by repository only when there are several', () => {
  assert.deepEqual(buildChangeMapView({ ...makeMap(makeRepo()), repos: [], error: 'Change map could not be built: boom' }).errors, ['Change map could not be built: boom']);
  assert.deepEqual(buildChangeMapView(makeMap(makeRepo({ error: 'Git lookup failed' }))).errors, ['Git lookup failed']);
  const second = makeRepo({ name: 'tools', error: 'Git lookup failed' });
  assert.deepEqual(buildChangeMapView(makeMap(makeRepo(), { repos: [makeRepo(), second] })).errors, ['tools: Git lookup failed']);
  assert.deepEqual(buildChangeMapView(makeMap(makeRepo())).errors, []);
});
