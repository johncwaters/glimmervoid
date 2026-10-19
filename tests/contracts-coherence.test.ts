import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CoherenceOrient } from '../shared/contracts/index.ts';
import { resolvePackageBin } from '../server/runtime-paths.ts';

const fixtureDirectory = new URL('./fixtures/coherence/0.37.1/', import.meta.url);
const fixtureNames = fs.readdirSync(fixtureDirectory);

function readCoherenceFixture(fixtureName: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(fixtureName, fixtureDirectory), 'utf8'));
}

for (const fixtureName of fixtureNames.filter((name) => name.startsWith('orient-'))) {
  const expectedAction = fixtureName.slice('orient-'.length, -'.json'.length);
  test(`CoherenceOrient parses ${fixtureName} with action ${expectedAction}`, () => {
    assert.equal(CoherenceOrient.parse(readCoherenceFixture(fixtureName)).action, expectedAction);
  });
}

test('CoherenceOrient refuses an unknown action', () => {
  const orientation = CoherenceOrient.parse(readCoherenceFixture('orient-steady.json'));
  assert.equal(CoherenceOrient.safeParse({ ...orientation, action: 'invented-action' }).success, false);
});

test('CoherenceOrient requires its top-level fields', () => {
  for (const field of ['action', 'reasons', 'sources', 'work', 'consequences', 'verification']) {
    const orientation = CoherenceOrient.parse(readCoherenceFixture('orient-steady.json'));
    Reflect.deleteProperty(orientation, field);
    assert.equal(CoherenceOrient.safeParse(orientation).success, false, field);
  }
});

test('CoherenceOrient requires work fields and rejects malformed nested values', () => {
  for (const field of ['stats', 'ready', 'active', 'blocked', 'completed', 'conflicts', 'unsynthesized']) {
    const orientation = CoherenceOrient.parse(readCoherenceFixture('orient-steady.json'));
    assert.ok(orientation.work);
    Reflect.deleteProperty(orientation.work, field);
    assert.equal(CoherenceOrient.safeParse(orientation).success, false, field);
  }
  const orientation = CoherenceOrient.parse(readCoherenceFixture('orient-resolve-conflict.json'));
  assert.ok(orientation.work);
  assert.equal(CoherenceOrient.safeParse({ ...orientation, sources: [{ name: 'work', ok: 'true', detail: '' }] }).success, false);
  assert.equal(CoherenceOrient.safeParse({ ...orientation, consequences: {} }).success, false);
  assert.equal(CoherenceOrient.safeParse({ ...orientation, verification: {} }).success, false);
  Reflect.deleteProperty(orientation.work.conflicts[0], 'scope');
  assert.equal(CoherenceOrient.safeParse(orientation).success, false);
});

test('coherence contracts preserve extra fields at nested boundaries', () => {
  const orientation = CoherenceOrient.parse(readCoherenceFixture('orient-steady.json'));
  assert.ok(orientation.work);
  const extendedOrientation = {
    ...orientation,
    futureField: true,
    work: { ...orientation.work, futureField: true },
    verification: { ...orientation.verification, futureField: true },
  };
  assert.deepEqual(CoherenceOrient.parse(extendedOrientation), extendedOrientation);
});

for (const binName of ['coherence', 'coherence-hook']) {
  test(`resolvePackageBin locates the installed ${binName} file`, () => {
    const binPath = resolvePackageBin('@danilocampos/coherence', binName);
    assert.ok(binPath);
    assert.equal(fs.statSync(binPath).isFile(), true);
  });
}
