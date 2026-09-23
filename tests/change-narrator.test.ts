import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createChangeNarrator } from '../server/change-narrator.ts';
import { CHANGE_MAP_CLAIMS_MAX, changeMapFactId } from '../shared/contracts/change-map.ts';
import type { ChangeMap, ChangeNarrative } from '../shared/contracts/change-map.ts';

function mapWithFiles(paths: string[] = ['server/a.ts']): ChangeMap {
  return {
    sessionId: 'session', sig: null, generatedAt: 1, narrative: null, narratorState: 'disabled',
    repos: [{ name: 'repo', root: '/repo', sessionPathPrefix: '', base: null, error: null, links: [],
      files: paths.map((path) => ({ factId: changeMapFactId('file', 'repo', path), path, status: 'modified', isCommitted: false })),
      subsystems: [], coChangeGaps: [], hotspots: [], blastRadius: [], untestedFiles: [], collisions: [],
    }],
  };
}

function deferredNarration() {
  let settle: (narrative: ChangeNarrative | null) => void = () => {};
  const promise = new Promise<ChangeNarrative | null>((resolve) => { settle = resolve; });
  return { promise, settle };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function awaitNarration(narrator: ReturnType<typeof createChangeNarrator>, map: ChangeMap): Promise<ChangeNarrative | null> {
  await new Promise<void>((resolve) => {
    assert.equal(narrator.narrationFor(map, resolve).narratorState, 'pending');
  });
  return narrator.narrationFor(map, () => {}).narrative;
}

test('Codex narration uses exec output schema and only passes a configured model', async () => {
  const map = mapWithFiles();
  for (const model of ['', 'gpt-5']) {
    const narrator = createChangeNarrator({
      getConfig: () => ({ changeMap: { narrator: { enabled: true, engine: 'codex', model } } }),
      spawnDistill: async ({ agent, extraArgs, cwd, prompt, model: spawnModel }) => {
        assert.equal(agent, 'codex');
        assert.equal(spawnModel, null);
        assert.match(prompt, /answer only with the JSON/);
        assert.deepEqual(extraArgs?.slice(0, 5), ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check']);
        const schemaIndex = extraArgs?.indexOf('--output-schema') ?? -1;
        const outputIndex = extraArgs?.indexOf('-o') ?? -1;
        assert.equal(schemaIndex, 5);
        assert.equal(outputIndex, 7);
        const schemaPath = extraArgs?.[schemaIndex + 1];
        const resultPath = extraArgs?.[outputIndex + 1];
        assert.ok(schemaPath);
        assert.ok(resultPath);
        const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
        assert.deepEqual(schema.required, ['claims']);
        assert.equal(schema.additionalProperties, false);
        assert.equal(schema.properties.claims.maxItems, CHANGE_MAP_CLAIMS_MAX);
        assert.equal(schema.properties.claims.items.additionalProperties, false);
        const factsPrompt = await fs.readFile(path.join(cwd, 'change-narrative-prompt.txt'), 'utf8');
        assert.doesNotMatch(factsPrompt, /Use no tools except Write|Result file:/);
        assert.match(factsPrompt, /Facts JSON:/);
        assert.deepEqual(extraArgs?.slice(outputIndex + 2), model ? ['-m', model] : []);
        await fs.writeFile(resultPath, JSON.stringify({ claims: [{ text: 'Changed.', factIds: [map.repos[0].files[0].factId] }] }));
      },
    });
    const narrative = await awaitNarration(narrator, map);
    assert.equal(narrative?.model, model || 'codex default');
    assert.equal(narrative?.claims[0].text, 'Changed.');
  }
});

test('Claude narration keeps the Write prompt and defaults to haiku', async () => {
  const map = mapWithFiles();
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true, model: '' } } }),
    spawnDistill: async ({ agent, extraArgs, cwd, model, prompt }) => {
      assert.equal(agent, undefined);
      assert.deepEqual(extraArgs, []);
      assert.equal(model, 'haiku');
      assert.match(prompt, /follow its instructions/);
      const factsPrompt = await fs.readFile(path.join(cwd, 'change-narrative-prompt.txt'), 'utf8');
      assert.match(factsPrompt, /Use no tools except Write/);
      assert.match(factsPrompt, /Result file:/);
      await fs.writeFile(path.join(cwd, 'change-narrative-result.json'), JSON.stringify({ claims: [{ text: 'Changed.', factIds: [map.repos[0].files[0].factId] }] }));
    },
  });
  assert.equal((await awaitNarration(narrator, map))?.model, 'haiku');
});

test('switching narrator engine or model misses the cache', async () => {
  const map = mapWithFiles();
  let engine = 'claude';
  let model = '';
  const requestedHashes: string[] = [];
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true, engine, model } } }),
    spawnNarration: async ({ factsHash }) => { requestedHashes.push(factsHash); return null; },
  });
  await awaitNarration(narrator, map);
  assert.equal(narrator.narrationFor(map, () => {}).narratorState, 'failed');
  engine = 'codex';
  await awaitNarration(narrator, map);
  model = 'gpt-5';
  await awaitNarration(narrator, map);
  model = 'codex default';
  await awaitNarration(narrator, map);
  assert.equal(new Set(requestedHashes).size, 4);
});

test('disabled and empty maps do not spawn', () => {
  let enabled = false;
  let spawns = 0;
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled } } }),
    spawnNarration: async () => { spawns++; return null; },
  });
  assert.equal(narrator.narrationFor(mapWithFiles(), () => {}).narratorState, 'disabled');
  enabled = true;
  assert.equal(narrator.narrationFor(mapWithFiles([]), () => {}).narratorState, 'disabled');
  assert.equal(spawns, 0);
});

test('pending narration becomes ready and settles once', async () => {
  const deferred = deferredNarration();
  let settled = 0;
  let requestedHash = '';
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true, model: 'haiku', timeoutSeconds: 90 } } }),
    spawnNarration: async ({ factsHash }) => { requestedHash = factsHash; return deferred.promise; },
  });
  const map = mapWithFiles();
  assert.equal(narrator.narrationFor(map, () => settled++).narratorState, 'pending');
  await flush();
  deferred.settle({ factsHash: requestedHash, model: 'haiku', claims: [{ text: 'Changed.', factIds: [map.repos[0].files[0].factId] }] });
  await flush();
  assert.equal(settled, 1);
  const outcome = narrator.narrationFor(map, () => settled++);
  assert.equal(outcome.narratorState, 'ready');
  assert.equal(outcome.narrative?.claims[0].text, 'Changed.');
  assert.equal(settled, 1);
});

test('failure is cached for a hash and a new hash retries', async () => {
  let spawns = 0;
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true } } }),
    spawnNarration: async () => { spawns++; throw new Error('failed'); },
  });
  const first = mapWithFiles();
  narrator.narrationFor(first, () => {});
  await flush();
  assert.equal(narrator.narrationFor(first, () => {}).narratorState, 'failed');
  assert.equal(spawns, 1);
  narrator.narrationFor(mapWithFiles(['b.ts']), () => {});
  await flush();
  assert.equal(spawns, 2);
});

test('one flight serves matching hashes and starts only the latest queued hash per session', async () => {
  const first = deferredNarration();
  const second = deferredNarration();
  const seenPaths: string[] = [];
  const settled: string[] = [];
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true } } }),
    spawnNarration: async ({ map }) => {
      seenPaths.push(map.repos[0].files[0].path);
      return seenPaths.length === 1 ? first.promise : second.promise;
    },
  });
  const firstMap = mapWithFiles(['a.ts']);
  const latestMap = { ...mapWithFiles(['c.ts']), sessionId: 'other' };
  narrator.narrationFor(firstMap, () => settled.push('first'));
  narrator.narrationFor({ ...firstMap, sessionId: 'peer' }, () => settled.push('peer'));
  narrator.narrationFor({ ...mapWithFiles(['b.ts']), sessionId: 'other' }, () => settled.push('obsolete'));
  narrator.narrationFor(latestMap, () => settled.push('latest'));
  await flush();
  assert.deepEqual(seenPaths, ['a.ts']);
  first.settle(null);
  await flush();
  assert.deepEqual(seenPaths, ['a.ts', 'c.ts']);
  assert.deepEqual(settled, ['first', 'peer']);
  second.settle(null);
  await flush();
  assert.deepEqual(settled, ['first', 'peer', 'latest']);
});

test('configuration is read on every request', async () => {
  let enabled = false;
  let model = 'haiku';
  const seenModels: string[] = [];
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled, model } } }),
    spawnNarration: async ({ model: selectedModel }) => { seenModels.push(selectedModel); return null; },
  });
  const map = mapWithFiles();
  assert.equal(narrator.narrationFor(map, () => {}).narratorState, 'disabled');
  enabled = true;
  model = 'sonnet';
  assert.equal(narrator.narrationFor(map, () => {}).narratorState, 'pending');
  await flush();
  assert.deepEqual(seenModels, ['sonnet']);
});

test('a narration that may not start reports cached, in-flight, queued or disabled state without spawning', async () => {
  const deferred = deferredNarration();
  let spawns = 0;
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled: true } } }),
    spawnNarration: async () => { spawns++; return deferred.promise; },
  });
  const running = mapWithFiles(['a.ts']);
  const settled: string[] = [];
  assert.equal(narrator.narrationFor(mapWithFiles(['fresh.ts']), () => {}, { mayStart: false }).narratorState, 'disabled');
  assert.equal(narrator.narrationFor(running, () => settled.push('first')).narratorState, 'pending');
  assert.equal(narrator.narrationFor({ ...running, sessionId: 'peer' }, () => settled.push('peer'), { mayStart: false }).narratorState, 'pending');
  assert.equal(narrator.narrationFor({ ...mapWithFiles(['b.ts']), sessionId: 'queued' }, () => {}).narratorState, 'pending');
  assert.equal(narrator.narrationFor({ ...mapWithFiles(['c.ts']), sessionId: 'queued' }, () => {}, { mayStart: false }).narratorState, 'pending');
  assert.equal(narrator.narrationFor(mapWithFiles(['changed.ts']), () => {}, { mayStart: false }).narratorState, 'disabled');
  await flush();
  assert.equal(spawns, 1);
  deferred.settle(null);
  await flush();
  assert.deepEqual(settled, ['first', 'peer']);
  assert.equal(narrator.narrationFor(running, () => {}, { mayStart: false }).narratorState, 'failed');
});

test('a queued narration settles when the narrator is disabled before it starts', async () => {
  const deferred = deferredNarration();
  let enabled = true;
  let spawns = 0;
  const settled: string[] = [];
  const narrator = createChangeNarrator({
    getConfig: () => ({ changeMap: { narrator: { enabled } } }),
    spawnNarration: async () => { spawns++; return deferred.promise; },
  });
  narrator.narrationFor(mapWithFiles(['a.ts']), () => settled.push('running'));
  assert.equal(narrator.narrationFor({ ...mapWithFiles(['b.ts']), sessionId: 'queued' }, () => settled.push('queued')).narratorState, 'pending');
  await flush();
  enabled = false;
  deferred.settle(null);
  await flush();
  assert.equal(spawns, 1);
  assert.deepEqual(settled.sort(), ['queued', 'running']);
  assert.equal(narrator.narrationFor({ ...mapWithFiles(['b.ts']), sessionId: 'queued' }, () => {}, { mayStart: false }).narratorState, 'disabled');
});
