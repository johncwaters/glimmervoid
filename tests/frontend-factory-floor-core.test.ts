import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildFactoryFloor, pickFactoryProject } from '../public/factory/factory-floor-core.ts';
import { ANIMALS } from '../public/nyan-animals.ts';
import { buildFactoryProjectState } from '../server/core/factory-core.ts';
import { CoherenceOrient, CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import type { FactoryProjectState } from '../shared/contracts/factory.ts';

type FactoryOrder = FactoryProjectState['orders'][number];

function makeOrder(id: string, overrides: Partial<FactoryOrder> = {}): FactoryOrder {
  return {
    id, objective: `Objective ${id}`, openedAt: '2026-10-08T10:00:00.000Z', criteria: [], boundary: 'This repository', risk: 'low', state: 'open', readiness: 'ready',
    parent: 'intent', dependsOn: [], writeScopes: [], owner: null, lastEvent: null, ...overrides,
  };
}

function makeProject(orders: FactoryOrder[], overrides: Partial<FactoryProjectState> = {}): FactoryProjectState {
  return {
    projectId: 'project', projectName: 'Factory', headSha: null, error: null, paused: false, orchestrator: null,
    heading: { action: 'dispatch', reasons: ['Ready work', 'Another reason'] },
    orders, conflicts: [], unverifiedCompletedWork: [], ...overrides,
  };
}

async function readFixtureProject(action: string): Promise<FactoryProjectState> {
  const [orientation, inspection] = await Promise.all([
    readFile(new URL(`./fixtures/coherence/0.37.1/orient-${action}.json`, import.meta.url), 'utf8'),
    readFile(new URL(`./fixtures/coherence/0.37.1/work-${action}.json`, import.meta.url), 'utf8'),
  ]);
  return buildFactoryProjectState({
    projectId: 'project', projectName: 'Factory', headSha: null, error: null,
    orient: CoherenceOrient.parse(JSON.parse(orientation)), work: CoherenceWorkInspect.parse(JSON.parse(inspection)),
  });
}

test('stations map open, dependency waiting, blocked, active and completed children', () => {
  const floor = buildFactoryFloor(makeProject([
    makeOrder('intent', { parent: null, criteria: ['All tests pass'] }),
    makeOrder('ready'), makeOrder('waiting', { readiness: 'waiting' }),
    makeOrder('blocked', { state: 'blocked', readiness: 'blocked' }),
    makeOrder('active', { state: 'active', readiness: 'active' }),
    makeOrder('review', { state: 'completed', readiness: 'done' }),
    makeOrder('shipped', { state: 'completed', readiness: 'done' }),
    makeOrder('cancelled', { state: 'cancelled', readiness: 'done' }),
    makeOrder('outside', { parent: 'another' }),
  ], { unverifiedCompletedWork: ['review'] }), null);
  assert.deepEqual(floor.stations.queue.map((crate) => [crate.id, crate.status]), [
    ['ready', 'Ready'], ['waiting', 'Waiting on dependency'], ['blocked', 'Blocked'],
  ]);
  assert.deepEqual(floor.stations.queue.map((crate) => [crate.id, crate.isHeld]), [['ready', false], ['waiting', true], ['blocked', true]]);
  assert.deepEqual(floor.stations.workers.map((crate) => [crate.id, crate.status]), [['active', 'Running']]);
  assert.equal(floor.stations.workers[0]?.isHeld, false);
  assert.deepEqual(floor.stations.review.map((crate) => crate.id), ['review']);
  assert.deepEqual(floor.stations.shipped.map((crate) => crate.id), ['shipped']);
  assert.deepEqual(floor.stations.watch, []);
  assert.equal(floor.intent?.shippedCount, 1);
  assert.equal(floor.intent?.childCount, 7);
  assert.deepEqual(floor.intent?.criteria, [{ text: 'All tests pass', isMet: false }]);
});

test('active child selects its first open root and up next keeps ledger order', () => {
  const project = makeProject([
    makeOrder('first', { parent: null }), makeOrder('closed', { parent: null, state: 'completed' }),
    makeOrder('second', { parent: null }), makeOrder('third', { parent: null }),
    makeOrder('cancelled', { parent: null, state: 'cancelled' }),
    makeOrder('child', { parent: 'second', state: 'active' }),
    makeOrder('other-child', { parent: 'third', state: 'active' }),
  ]);
  const floor = buildFactoryFloor(project, null);
  assert.equal(floor.intent?.id, 'second');
  assert.deepEqual(floor.upNext.map((order) => order.id), ['first', 'third']);
  project.orders[5].state = 'completed';
  project.orders[6].state = 'completed';
  assert.equal(buildFactoryFloor(project, null).intent?.id, 'first');
});

test('closed roots and empty ledgers have no active intent or stations', () => {
  const floor = buildFactoryFloor(makeProject([makeOrder('intent', { parent: null, state: 'completed' })]), null);
  assert.equal(floor.intent, null);
  assert.deepEqual(floor.upNext, []);
  assert.equal(Object.values(floor.stations).flat().length, 0);
  assert.equal(buildFactoryFloor(makeProject([]), null).intent, null);
});

test('shipped count excludes unverified work and does not mark root criteria met', () => {
  const project = makeProject([
    makeOrder('intent', { parent: null, criteria: ['Test suite passes', 'Release verified'] }),
    makeOrder('done', { state: 'completed' }), makeOrder('unchecked', { state: 'completed' }),
  ], { unverifiedCompletedWork: ['unchecked'] });
  const floor = buildFactoryFloor(project, null);
  assert.equal(floor.intent?.shippedCount, 1);
  assert.equal(floor.intent?.childCount, 2);
  assert.equal(floor.intent?.criteria.every((criterion) => !criterion.isMet), true);
});

test('worker animals remain stable across ordering and changing objectives', () => {
  const project = makeProject([
    makeOrder('intent', { parent: null }),
    makeOrder('worker', { state: 'active', owner: 'session-1' }),
    makeOrder('sibling', { state: 'active', owner: 'session-1' }),
    makeOrder('unowned', { state: 'active' }),
  ]);
  const workers = buildFactoryFloor(project, null).stations.workers;
  assert.deepEqual(workers[0].animal, workers[1].animal);
  assert.ok(ANIMALS.includes(workers[0].animal));
  assert.ok(ANIMALS.includes(workers[2].animal));
  const reordered = buildFactoryFloor({ ...project, orders: [...project.orders].reverse().map((order) => ({ ...order, objective: 'Renamed' })) }, null);
  for (const worker of workers) assert.deepEqual(reordered.stations.workers.find((crate) => crate.id === worker.id)?.animal, worker.animal);
});

test('orchestrator shows the first reason or replaces it with the project error', () => {
  const project = makeProject([]);
  assert.deepEqual(buildFactoryFloor(project, null).orchestrator, { action: 'dispatch', reason: 'Ready work', isException: false, sessionId: null, state: null });
  assert.deepEqual(buildFactoryFloor({ ...project, error: 'Inspection failed' }, null).orchestrator, { action: 'Exception', reason: 'Inspection failed', isException: true, sessionId: null, state: null });
  assert.equal(buildFactoryFloor({ ...project, heading: { action: 'steady', reasons: [] } }, null).orchestrator.reason, '');
});

test('ledger uses fixture last events with newest first and a fifty line cap', async () => {
  const project = await readFixtureProject('continue');
  const lastEvent = project.orders[0].lastEvent;
  assert.ok(lastEvent);
  assert.equal(lastEvent.event, 'transitioned');
  assert.deepEqual(buildFactoryFloor(project, null).ledger, [{ orderId: project.orders[0].id, ...lastEvent }]);
  const orders = Array.from({ length: 60 }, (_, index) => makeOrder(`order-${index}`, {
    lastEvent: { event: 'opened', at: new Date(Date.UTC(2026, 9, 8, 10, index)).toISOString(), session: 'session' },
  }));
  const floor = buildFactoryFloor(makeProject([makeOrder('no-event'), ...orders]), null);
  assert.equal(floor.ledger.length, 50);
  assert.equal(floor.ledger[0].orderId, 'order-59');
  assert.equal(floor.ledger[49].orderId, 'order-10');
  assert.equal(orders[0].id, 'order-0');
});

test('selected detail holds only intent, fence, dependencies, station and owner', () => {
  const project = makeProject([
    makeOrder('intent', { parent: null }),
    makeOrder('child', { state: 'active', owner: 'session', writeScopes: ['src/a.ts'], dependsOn: ['dependency'] }),
  ]);
  const floor = buildFactoryFloor(project, 'child');
  assert.deepEqual(floor.selectedOrder, {
    id: 'child', intent: 'Objective intent', writeScopes: ['src/a.ts'], dependsOn: ['dependency'], station: 'workers', owner: 'session',
  });
  assert.equal(floor.stations.workers[0].isSelected, true);
  assert.equal(buildFactoryFloor(project, 'missing').selectedOrder, null);
  assert.equal(buildFactoryFloor(project, null).selectedOrder, null);
  assert.equal(buildFactoryFloor(project, 'intent').selectedOrder?.station, 'intent');
});

test('detail resolves ancestors and handles orphaned or cyclic parent references', () => {
  const project = makeProject([
    makeOrder('intent', { parent: null }), makeOrder('child'), makeOrder('grandchild', { parent: 'child' }),
    makeOrder('orphan', { parent: 'missing' }), makeOrder('cycle', { parent: 'cycle' }),
  ]);
  assert.equal(buildFactoryFloor(project, 'grandchild').selectedOrder?.intent, 'Objective intent');
  assert.equal(buildFactoryFloor(project, 'orphan').selectedOrder?.intent, null);
  assert.equal(buildFactoryFloor(project, 'cycle').selectedOrder?.intent, null);
});

test('both conflicting orders are flagged using coherence conflict fixtures', async () => {
  const project = await readFixtureProject('resolve-conflict');
  const root = makeOrder('intent', { parent: null });
  project.orders = [root, ...project.orders.map((order) => ({ ...order, parent: root.id }))];
  const crates = Object.values(buildFactoryFloor(project, null).stations).flat();
  assert.equal(crates.length, 2);
  assert.equal(crates.every((crate) => crate.hasConflict && crate.status === 'Scope conflict'), true);
});

test('project picking retains a selected id or falls back to first by name without mutation', () => {
  const projects = [makeProject([], { projectId: 'z', projectName: 'Zulu' }), makeProject([], { projectId: 'a', projectName: 'Alpha' })];
  assert.equal(pickFactoryProject(projects, 'z')?.projectId, 'z');
  assert.equal(pickFactoryProject(projects, null)?.projectId, 'a');
  assert.equal(pickFactoryProject(projects, 'missing')?.projectId, 'a');
  assert.equal(projects[0].projectId, 'z');
  assert.equal(pickFactoryProject([], null), null);
});

test('paused factory keeps its floor and exposes a paused marker separately from the heading', () => {
  const project = makeProject([makeOrder('intent', { parent: null }), makeOrder('child')]);
  const running = buildFactoryFloor(project, null);
  const paused = buildFactoryFloor({ ...project, paused: true }, null);
  assert.equal(running.paused, false);
  assert.equal(paused.paused, true);
  assert.deepEqual({ ...paused, paused: false }, running);
});

test('intent and up next follow opening time rather than coherence work id order', () => {
  const project = makeProject([
    makeOrder('first-id', { parent: null, openedAt: '2026-10-08T12:00:00.000Z' }),
    makeOrder('oldest', { parent: null, openedAt: '2026-10-08T10:00:00.000Z' }),
    makeOrder('middle', { parent: null, openedAt: '2026-10-08T11:00:00.000Z' }),
  ]);
  const floor = buildFactoryFloor(project, null);
  assert.equal(floor.intent?.id, 'oldest');
  assert.deepEqual(floor.upNext.map((order) => order.id), ['middle', 'first-id']);
  assert.equal(project.orders[0].id, 'first-id');
});


test('floor shows live orchestrator state and selects the intent held by its session', () => {
  const project = makeProject([
    makeOrder('first', { parent: null }), makeOrder('held', { parent: null }),
  ], { orchestrator: { sessionId: 'factory-orch-project', intentId: 'held', state: 'RUNNING' } });
  const floor = buildFactoryFloor(project, null);
  assert.equal(floor.intent?.id, 'held');
  assert.equal(floor.orchestrator.state, 'RUNNING');
  assert.equal(floor.orchestrator.sessionId, 'factory-orch-project');
  assert.equal(buildFactoryFloor({ ...project, error: 'factory-exception: backoff' }, null).orchestrator.reason, 'factory-exception: backoff');
});


test('worker crates carry only their registered live terminal id', () => {
  const floor = buildFactoryFloor(makeProject([
    makeOrder('intent', { parent: null }), makeOrder('active', { state: 'active' }), makeOrder('ended', { state: 'active' }),
  ], { liveWorkers: [{ workId: 'active', sessionId: 'factory-work-active' }] }), null);
  assert.deepEqual(floor.stations.workers.map(({ id, sessionId }) => [id, sessionId]), [['active', 'factory-work-active'], ['ended', null]]);
});


test('in-flight close-out prefers Review over ledger state for crates and selected orders', () => {
  const project = makeProject([
    makeOrder('intent', { parent: null }), makeOrder('active', { state: 'active' }), makeOrder('blocked', { state: 'blocked' }),
  ], { reviewing: ['active', 'blocked'], liveWorkers: [{ workId: 'active', sessionId: 'factory-work-active' }] });
  const floor = buildFactoryFloor(project, 'active');
  assert.deepEqual(floor.stations.review.map((crate) => [crate.id, crate.status]), [['active', 'Reviewing'], ['blocked', 'Reviewing']]);
  assert.equal(floor.stations.review[0].sessionId, 'factory-work-active');
  assert.equal(floor.selectedOrder?.station, 'review');
  assert.equal(floor.stations.workers.length, 0);
  assert.equal(floor.stations.queue.length, 0);
});

test('open watches occupy Watch and the floor shows factory spend and non-exception notes', () => {
  const floor = buildFactoryFloor(makeProject([makeOrder('intent', { parent: null }), makeOrder('watch', { state: 'completed' })], {
    watches: [{ workId: 'watch', intentId: 'intent', projectId: 'project', mergedSha: 'a'.repeat(40), mergedAt: '2026-10-08T12:00:00.000Z', writeScopes: ['src'] }],
    unverifiedCompletedWork: ['watch'], spentTodayUsd: 12.5, dailyBudgetUsd: 20, note: 'Watch query unavailable',
  }), 'watch');
  assert.deepEqual(floor.stations.watch.map((crate) => [crate.id, crate.status]), [['watch', 'Watching']]);
  assert.equal(floor.stations.review.length, 0);
  assert.equal(floor.selectedOrder?.station, 'watch');
  assert.equal(floor.spend, 'Factory today: $12.50 / $20.00');
  assert.equal(floor.note, 'Watch query unavailable');
  assert.equal(floor.orchestrator.isException, false);
  assert.equal(buildFactoryFloor(makeProject([]), null).spend, 'Factory today: $0.00 / unlimited');
});
