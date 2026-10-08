import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildFactoryProjectState, FACTORY_TICK_INTERVAL_MS, factoryShouldStart, factoryStateSignature } from '../server/core/factory-core.ts';
import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import { FactoryProjectState } from '../shared/contracts/factory.ts';

const identity = { projectId: 'project-1', projectName: 'Factory', headSha: 'a'.repeat(40) };

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/coherence/0.37.1/${name}.json`, import.meta.url), 'utf8'));
}

for (const [action, orderCount] of [
  ['steady', 0], ['resolve-conflict', 2], ['dispatch', 1], ['continue', 1], ['verify', 1], ['refuse', 0],
] as const) {
  test(`factory maps the ${action} fixture pair to ${orderCount} orders`, async () => {
    const orient = CoherenceOrient.parse(await readFixture(`orient-${action}`));
    const inspection = CoherenceWorkInspect.safeParse(await readFixture(`work-${action}`));
    const project = buildFactoryProjectState({
      ...identity, orient, work: inspection.success ? inspection.data : null,
      error: inspection.success ? null : inspection.error.message,
    });
    assert.equal(project.heading.action, action);
    assert.equal(project.orders.length, orderCount);
    assert.deepEqual(FactoryProjectState.parse(project), project);
    if (!inspection.success) {
      assert.ok(project.error);
      return;
    }
    assert.deepEqual(project.heading.reasons, orient.reasons);
    assert.deepEqual(project.unverifiedCompletedWork, orient.consequences.unverifiedCompletedWork);
    assert.deepEqual(project.orders.map((order) => order.owner), inspection.data.work.map((order) => order.owner.session));
    assert.deepEqual(project.orders.map((order) => order.lastEvent), inspection.data.work.map((order) => order.last === null ? null : { event: order.last.event, at: order.last.at, session: order.last.session }));
    if (action === 'resolve-conflict') assert.equal(project.conflicts.length, 1);
  });
}

test('factory refuses missing reports and explicit errors with empty orders', async () => {
  const orient = CoherenceOrient.parse(await readFixture('orient-dispatch'));
  const work = CoherenceWorkInspect.parse(await readFixture('work-dispatch'));
  for (const reports of [
    { orient, work, error: 'command failed' },
    { orient: null, work, error: null },
    { orient, work: null, error: null },
  ]) {
    const project = buildFactoryProjectState({ ...identity, ...reports });
    assert.equal(project.heading.action, 'refuse');
    assert.ok(project.error);
    assert.deepEqual(project.heading.reasons, [project.error]);
    assert.deepEqual(project.orders, []);
    assert.deepEqual(project.conflicts, []);
  }
});

test('factory signature ignores object and project ordering but tracks order state', async () => {
  const project = buildFactoryProjectState({
    ...identity, error: null,
    orient: CoherenceOrient.parse(await readFixture('orient-dispatch')),
    work: CoherenceWorkInspect.parse(await readFixture('work-dispatch')),
  });
  const sibling = { ...project, projectId: 'project-2' };
  assert.equal(factoryStateSignature([project, sibling]), factoryStateSignature([sibling, { ...project, ...identity }]));
  const changed = structuredClone(project);
  changed.orders[0].state = 'active';
  assert.notEqual(factoryStateSignature([project]), factoryStateSignature([changed]));
});

test('factory is opt-in and polls every ten seconds', () => {
  assert.deepEqual(factoryShouldStart({}), { start: false });
  assert.deepEqual(factoryShouldStart({ factory: { enabled: false } }), { start: false });
  assert.deepEqual(factoryShouldStart({ factory: { enabled: true } }), { start: true });
  assert.equal(FACTORY_TICK_INTERVAL_MS, 10_000);
});

test('factory maps a missing last record to null and tracks latest ledger events in its signature', async () => {
  const orient = CoherenceOrient.parse(await readFixture('orient-continue'));
  const work = CoherenceWorkInspect.parse(await readFixture('work-continue'));
  const project = buildFactoryProjectState({ ...identity, orient, work, error: null });
  assert.deepEqual(project.orders[0].lastEvent, { event: 'transitioned', at: '2026-10-08T10:26:41.653Z', session: 's-1' });
  work.work[0].last = null;
  const withoutLast = buildFactoryProjectState({ ...identity, orient, work, error: null });
  assert.equal(withoutLast.orders[0].lastEvent, null);
  assert.notEqual(factoryStateSignature([project]), factoryStateSignature([withoutLast]));
});

test('factory shows a refusing orient with its own reasons when no work inspection exists', async () => {
  const orient = CoherenceOrient.parse(await readFixture('orient-refuse'));
  const project = buildFactoryProjectState({ ...identity, orient, work: null, error: null });
  assert.equal(project.error, null);
  assert.deepEqual(project.heading, { action: 'refuse', reasons: orient.reasons });
  assert.deepEqual(project.orders, []);
  assert.deepEqual(FactoryProjectState.parse(project), project);
});
