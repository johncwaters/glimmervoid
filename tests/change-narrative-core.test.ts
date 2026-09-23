import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_MAP_CLAIMS_MAX, CHANGE_MAP_LIST_CAP, changeMapFactId } from '../shared/contracts/change-map.ts';
import type { ChangeMap } from '../shared/contracts/change-map.ts';
import {
  buildNarrativePrompt, factsHashInput, hasNarratableFacts, knownNarrativeFactIds, narrativeFacts, validateNarrative,
} from '../server/core/change-narrative-core.ts';

function mapWithFiles(paths: string[] = ['server/a.ts']): ChangeMap {
  return {
    sessionId: 'session', sig: 'signature', generatedAt: 123, narrative: null, narratorState: 'pending',
    repos: [{
      name: 'repo', root: '/private/repo', sessionPathPrefix: '', base: 'main', error: null, links: [],
      files: paths.map((path) => ({ factId: changeMapFactId('file', 'repo', path), path, status: 'modified', isCommitted: false })),
      subsystems: [], coChangeGaps: [], hotspots: [], blastRadius: [], untestedFiles: [], collisions: [],
    }],
  };
}

test('facts exclude session and local metadata and hash independently of fact order', () => {
  const map = mapWithFiles(['b.ts', 'a.ts']);
  const facts = narrativeFacts(map);
  assert.deepEqual(Object.keys(facts), ['repos']);
  assert.deepEqual(facts.repos[0].files.map((file) => file.path), ['a.ts', 'b.ts']);
  assert.equal('root' in facts.repos[0], false);
  assert.equal(factsHashInput(map), factsHashInput({ ...map, sessionId: 'other', generatedAt: 999, repos: [{ ...map.repos[0], files: [...map.repos[0].files].reverse() }] }));
  const reorderedFiles = map.repos[0].files.map(({ factId, path, status, isCommitted }) => ({ isCommitted, status, path, factId }));
  assert.equal(factsHashInput(map), factsHashInput({ ...map, repos: [{ ...map.repos[0], files: reorderedFiles }] }));
});

test('an empty map has no narratable facts', () => {
  assert.equal(hasNarratableFacts(mapWithFiles([])), false);
  assert.equal(hasNarratableFacts(mapWithFiles()), true);
});

test('prompt embeds only the projected facts and exact result path', () => {
  const facts = narrativeFacts(mapWithFiles());
  const prompt = buildNarrativePrompt({ facts, resultPath: '/tmp/result.json' });
  assert.ok(prompt.includes(JSON.stringify(facts)));
  assert.ok(prompt.includes('/tmp/result.json'));
  assert.ok(prompt.includes('only source of truth'));
  assert.ok(prompt.includes('When links are present, lead with how a change in one repository reaches another through them.'));
  assert.ok(prompt.includes(String(CHANGE_MAP_CLAIMS_MAX)));
  assert.equal(prompt.includes('/private/repo'), false);
});

test('link facts are counted, capped by impact, and accepted as narrative citations', () => {
  const map = mapWithFiles([]);
  const links = Array.from({ length: CHANGE_MAP_LIST_CAP + 2 }, (_, index) => ({
    factId: changeMapFactId('link', 'repo', `provider-${index}`, 'shared'),
    providerRepo: `provider-${index}`, packageName: 'shared', packageDir: '', consumerManifest: 'package.json',
    versionSpec: '^1', isLocalLink: false, providerChangedPathCount: 1, importers: [],
    importerCount: index % 2, changedImporterCount: index === CHANGE_MAP_LIST_CAP + 1 ? 2 : 0,
  }));
  map.repos[0].links = links;
  const [facts] = narrativeFacts(map).repos;
  assert.equal(facts.totalCounts.links, CHANGE_MAP_LIST_CAP + 2);
  assert.equal(facts.links.length, CHANGE_MAP_LIST_CAP);
  assert.equal(facts.links[0].providerRepo, `provider-${CHANGE_MAP_LIST_CAP + 1}`);
  assert.equal(facts.links[1].importerCount, 1);
  assert.equal(knownNarrativeFactIds(map).has(facts.links[0].factId), true);
  const excluded = links.find((link) => !facts.links.some((fact) => fact.factId === link.factId));
  assert.equal(knownNarrativeFactIds(map).has(excluded?.factId ?? ''), false);
  assert.equal(factsHashInput(map), factsHashInput({ ...map, repos: [{ ...map.repos[0], links: [...links].reverse() }] }));
});

test('validator drops unknown citations, empty and overlong text, and invalid top-level input', () => {
  const map = mapWithFiles();
  const factId = map.repos[0].files[0].factId;
  const options = { knownFactIds: knownNarrativeFactIds(map), factsHash: 'hash', model: 'haiku' };
  assert.equal(validateNarrative({ ...options, raw: { claims: 'wrong' } }), null);
  const narrative = validateNarrative({ ...options, raw: { claims: [
    { text: 'Valid.', factIds: [factId, 'unknown'] },
    { text: 'Unknown.', factIds: ['unknown'] },
    { text: '  ', factIds: [factId] },
    { text: 'x'.repeat(601), factIds: [factId] },
  ] } });
  assert.deepEqual(narrative?.claims, [{ text: 'Valid.', factIds: [factId] }]);
});

test('validator strips disallowed punctuation and caps accepted claims', () => {
  const factId = mapWithFiles().repos[0].files[0].factId;
  const punctuation = `${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}${String.fromCharCode(0x2026)}`;
  const narrative = validateNarrative({
    raw: { claims: [{ text: punctuation, factIds: [factId] }, ...Array.from({ length: 20 }, () => ({ text: 'Valid.', factIds: [factId] }))] },
    knownFactIds: new Set([factId]), factsHash: 'hash', model: null,
  });
  assert.equal(narrative?.claims.length, CHANGE_MAP_CLAIMS_MAX);
  assert.equal(narrative?.claims[0].text, '--...');
  assert.equal(validateNarrative({
    raw: { claims: [{ text: String.fromCharCode(0x2026).repeat(600), factIds: [factId] }] },
    knownFactIds: new Set([factId]), factsHash: 'hash', model: null,
  }), null);
});

function oversizedMap(): ChangeMap {
  const factCount = CHANGE_MAP_LIST_CAP + 5;
  const paths = Array.from({ length: factCount }, (_, index) => `server/file-${String(index).padStart(2, '0')}.ts`);
  const map = mapWithFiles(paths);
  const [repo] = map.repos;
  return {
    ...map,
    repos: [{
      ...repo,
      untestedFiles: paths.map((path) => ({ factId: changeMapFactId('untested', 'repo', path), path })),
      subsystems: [{ factId: changeMapFactId('subsystem', 'repo', 'server/AGENTS.md'), agentsPath: 'server/AGENTS.md', title: 'Server', paths }],
      blastRadius: paths.map((path, index) => ({
        factId: changeMapFactId('blast', 'repo', path), path, directDependents: [], directDependentCount: 0,
        transitiveDependentCount: index, dependentTests: [], dependentTestCount: 0,
      })),
    }],
  };
}

test('prompt facts cap each group per repo and report the full totals', () => {
  const map = oversizedMap();
  const [repoFacts] = narrativeFacts(map).repos;
  assert.equal(repoFacts.files.length, CHANGE_MAP_LIST_CAP);
  assert.equal(repoFacts.untestedFiles.length, CHANGE_MAP_LIST_CAP);
  assert.equal(repoFacts.blastRadius.length, CHANGE_MAP_LIST_CAP);
  assert.equal(repoFacts.subsystems[0].paths.length, CHANGE_MAP_LIST_CAP);
  assert.equal(repoFacts.subsystems[0].pathCount, CHANGE_MAP_LIST_CAP + 5);
  assert.equal(repoFacts.totalCounts.files, CHANGE_MAP_LIST_CAP + 5);
  assert.equal(repoFacts.totalCounts.blastRadius, CHANGE_MAP_LIST_CAP + 5);
  assert.equal(repoFacts.totalCounts.collisions, 0);
  assert.equal(repoFacts.blastRadius[0].transitiveDependentCount, CHANGE_MAP_LIST_CAP + 4);
  assert.equal(repoFacts.blastRadius.some((fact) => fact.transitiveDependentCount < 5), false);
  assert.equal(map.repos[0].files.length, CHANGE_MAP_LIST_CAP + 5);
  assert.equal(factsHashInput(map), factsHashInput(oversizedMap()));
});

test('known fact ids are limited to the capped prompt facts', () => {
  const map = oversizedMap();
  const knownFactIds = knownNarrativeFactIds(map);
  const [repoFacts] = narrativeFacts(map).repos;
  assert.equal(knownFactIds.has(repoFacts.files[0].factId), true);
  assert.equal(knownFactIds.has(changeMapFactId('file', 'repo', 'server/file-24.ts')), false);
  assert.equal(knownFactIds.has(changeMapFactId('blast', 'repo', 'server/file-24.ts')), true);
  assert.equal(knownFactIds.has(changeMapFactId('blast', 'repo', 'server/file-00.ts')), false);
  assert.equal(knownFactIds.size, CHANGE_MAP_LIST_CAP * 3 + 1);
});
