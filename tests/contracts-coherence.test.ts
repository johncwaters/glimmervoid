import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/index.ts';
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

for (const fixtureName of fixtureNames.filter((name) => name.startsWith('work-') && name !== 'work-refuse.json')) {
  test(`CoherenceWorkInspect parses ${fixtureName}`, () => {
    CoherenceWorkInspect.parse(readCoherenceFixture(fixtureName));
  });
}

test('resolve-conflict has two work orders with overlapping write scopes and a recorded conflict', () => {
  const inspection = CoherenceWorkInspect.parse(readCoherenceFixture('work-resolve-conflict.json'));
  assert.equal(inspection.work.length, 2);
  const [leftOrder, rightOrder] = inspection.work;
  assert.ok(leftOrder.opened.writeScopes.some((scope) => rightOrder.opened.writeScopes.includes(scope)));
  assert.equal(inspection.scopeConflicts.length, 1);
  assert.deepEqual(new Set([inspection.scopeConflicts[0].left, inspection.scopeConflicts[0].right]),
    new Set([leftOrder.work, rightOrder.work]));
});

test('CoherenceWorkInspect refuses the error output from the refuse ledger', () => {
  assert.equal(CoherenceWorkInspect.safeParse(readCoherenceFixture('work-refuse.json')).success, false);
});

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

test('CoherenceWorkInspect requires order and opened fields', () => {
  for (const field of ['work', 'state', 'readiness', 'owner', 'opened']) {
    const inspection = CoherenceWorkInspect.parse(readCoherenceFixture('work-dispatch.json'));
    Reflect.deleteProperty(inspection.work[0], field);
    assert.equal(CoherenceWorkInspect.safeParse(inspection).success, false, field);
  }
  for (const field of ['objective', 'criteria', 'risk', 'parent', 'dependsOn', 'readScopes', 'writeScopes']) {
    const inspection = CoherenceWorkInspect.parse(readCoherenceFixture('work-dispatch.json'));
    Reflect.deleteProperty(inspection.work[0].opened, field);
    assert.equal(CoherenceWorkInspect.safeParse(inspection).success, false, field);
  }
  const inspection = CoherenceWorkInspect.parse(readCoherenceFixture('work-dispatch.json'));
  Reflect.deleteProperty(inspection, 'scopeConflicts');
  assert.equal(CoherenceWorkInspect.safeParse(inspection).success, false);
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
  const inspection = CoherenceWorkInspect.parse(readCoherenceFixture('work-dispatch.json'));
  const extendedInspection = {
    ...inspection,
    futureField: true,
    work: inspection.work.map((order) => ({ ...order, opened: { ...order.opened, futureField: true } })),
  };
  assert.deepEqual(CoherenceWorkInspect.parse(extendedInspection), extendedInspection);
});

for (const binName of ['coherence', 'coherence-hook']) {
  test(`resolvePackageBin locates the installed ${binName} file`, () => {
    const binPath = resolvePackageBin('@danilocampos/coherence', binName);
    assert.ok(binPath);
    assert.equal(fs.statSync(binPath).isFile(), true);
  });
}
