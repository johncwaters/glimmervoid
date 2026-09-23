import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChangeMap, RepoChangeMap } from '../shared/contracts/change-map.ts';
import { changeMapFactId } from '../shared/contracts/change-map.ts';
import { buildChangeMapView } from '../public/sidebar/change-map-core.ts';

function makeRepo(overrides: Partial<RepoChangeMap> = {}): RepoChangeMap {
  return {
    name: 'glimmervoid', root: '/repo', base: 'main', files: [], subsystems: [], coChangeGaps: [],
    hotspots: [], blastRadius: [], untestedFiles: [], collisions: [], error: null, ...overrides,
  };
}

function makeMap(repo: RepoChangeMap, overrides: Partial<ChangeMap> = {}): ChangeMap {
  return {
    sessionId: 'session', sig: 'sig', generatedAt: 1, repos: [repo], narrative: null,
    narratorState: 'disabled', ...overrides,
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
  assert.deepEqual(view.repos[0]?.files[0], { path, status: 'modified', isCommitted: true, dependentCount: 10, testCount: 2 });
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
