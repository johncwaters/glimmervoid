import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_MAP_LIST_CAP,
  ChangeMap,
  changeMapFactId,
} from '../shared/contracts/change-map.ts';
import { ClientMessage, ServerMessage } from '../shared/contracts/control-messages.ts';

function repoMap(overrides: Record<string, unknown> = {}) {
  return {
    name: 'glimmervoid',
    root: '/work/glimmervoid',
    sessionPathPrefix: '',
    base: 'abc123',
    files: [{ factId: 'file:glimmervoid:a.ts', path: 'a.ts', status: 'modified', isCommitted: true }],
    subsystems: [{ factId: 'subsystem:glimmervoid:AGENTS.md', agentsPath: 'AGENTS.md', title: 'glimmervoid', paths: ['a.ts'] }],
    coChangeGaps: [{ factId: 'co-change:glimmervoid:a.ts:a-core.ts', path: 'a.ts', partner: 'a-core.ts', support: 4, confidence: 0.8 }],
    hotspots: [{ factId: 'hotspot:glimmervoid:a.ts', path: 'a.ts', commitCount: 12, fixCommitCount: 5 }],
    blastRadius: [{
      factId: 'blast:glimmervoid:a.ts',
      path: 'a.ts',
      directDependents: ['b.ts'],
      directDependentCount: 1,
      transitiveDependentCount: 3,
      dependentTests: ['tests/a.test.ts'],
      dependentTestCount: 1,
    }],
    untestedFiles: [],
    collisions: [{ factId: 'collision:glimmervoid:a.ts:s2', path: 'a.ts', otherSessionId: 's2', otherSessionName: 'other' }],
    links: [{
      factId: 'link:glimmervoid:shared-lib:shared-lib',
      providerRepo: 'shared-lib',
      packageName: 'shared-lib',
      packageDir: '',
      consumerManifest: 'package.json',
      versionSpec: '^1.2.0',
      isLocalLink: false,
      providerChangedPathCount: 3,
      importers: ['a.ts'],
      importerCount: 1,
      changedImporterCount: 1,
    }],
    error: null,
    ...overrides,
  };
}

function changeMap(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    sig: 'sig-1',
    generatedAt: 1,
    repos: [repoMap()],
    narrative: null,
    narratorState: 'disabled',
    ...overrides,
  };
}

test('changeMapFactId joins kind, repo and parts so every core derives the same id', () => {
  assert.equal(changeMapFactId('co-change', 'glimmervoid', 'a.ts', 'a-core.ts'), 'co-change:glimmervoid:a.ts:a-core.ts');
});

test('ChangeMap accepts a complete map', () => {
  assert.equal(ChangeMap.parse(changeMap()).repos[0].files[0].path, 'a.ts');
});

test('ChangeMap carries an optional non-empty build error', () => {
  assert.equal(ChangeMap.parse(changeMap({ repos: [], error: 'Change map could not be built: boom' })).error, 'Change map could not be built: boom');
  assert.equal(ChangeMap.parse(changeMap()).error, undefined);
  assert.equal(ChangeMap.safeParse(changeMap({ error: '' })).success, false);
});

test('ChangeMap rejects unknown fields so producers cannot drift from the contract', () => {
  assert.equal(ChangeMap.safeParse(changeMap({ extra: true })).success, false);
  assert.equal(ChangeMap.safeParse(changeMap({ repos: [repoMap({ extra: true })] })).success, false);
});

test('blast radius lists are capped', () => {
  const tooMany = Array.from({ length: CHANGE_MAP_LIST_CAP + 1 }, (_, index) => `f${index}.ts`);
  const [blast] = repoMap().blastRadius;
  const parsed = ChangeMap.safeParse(changeMap({ repos: [repoMap({ blastRadius: [{ ...blast, directDependents: tooMany }] })] }));
  assert.equal(parsed.success, false);
});

test('a narrative claim must cite at least one fact', () => {
  const narrative = { factsHash: 'h', model: 'haiku', claims: [{ text: 'Touches sessions.', factIds: [] }] };
  assert.equal(ChangeMap.safeParse(changeMap({ narrative, narratorState: 'ready' })).success, false);
});

test('request-change-map and change-map travel on the control socket', () => {
  assert.equal(ClientMessage.parse({ type: 'request-change-map', id: 's1' }).type, 'request-change-map');
  assert.equal(ServerMessage.parse({ type: 'change-map', id: 's1', map: changeMap() }).type, 'change-map');
  assert.equal(ServerMessage.safeParse({ type: 'change-map', id: 's1', map: { sessionId: 's1' } }).success, false);
});
