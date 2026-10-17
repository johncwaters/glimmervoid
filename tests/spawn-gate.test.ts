import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdmission, createSpawnGate, isQueueAdmissionAbandoned, isQueueAdmissionTimeout } from '../server/spawn-gate.ts';
import { waitFor } from './helpers/wait-for.ts';

function deferredResolve(): { promise: Promise<void>; resolve: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, resolve: () => settle() };
}


test('run executes queued work one-at-a-time, in submission order', async () => {
  const gate = createSpawnGate();
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];

  const task = (id: string) => gate.run(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(id);
    inFlight -= 1;
    return id;
  });

  const results = await Promise.all([task('a'), task('b'), task('c')]);
  assert.equal(maxInFlight, 1, 'spawns never overlapped');
  assert.deepEqual(order, ['a', 'b', 'c'], 'ran in order');
  assert.deepEqual(results, ['a', 'b', 'c'], 'each caller got its own result');
});

test('a rejected task is surfaced to its caller and does not deadlock the gate', async () => {
  const gate = createSpawnGate();
  await assert.rejects(gate.run(async () => {
    throw new Error('boom');
  }), /boom/);
  const ok = await gate.run(async () => 'ok');
  assert.equal(ok, 'ok', 'gate still runs after a rejection');
});

test('an admission timeout rejects the caller and never starts the work afterwards', async () => {
  const gate = createSpawnGate();
  const blocked = deferredResolve();
  let lateWorkRan = false;
  const holding = gate.run(() => blocked.promise);
  const admission = gate.run(() => { lateWorkRan = true; }, { admissionTimeoutMs: 5 });
  await assert.rejects(admission, (error: unknown) => isQueueAdmissionTimeout(error));
  blocked.resolve();
  await holding;
  await gate.run(() => 'after');
  assert.equal(lateWorkRan, false, 'the abandoned task never reached the front of the queue');
});

test('work admitted before the deadline keeps running past it', async () => {
  const gate = createSpawnGate();
  const slow = await gate.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'done';
  }, { admissionTimeoutMs: 5 });
  assert.equal(slow, 'done');
});

test('an admission timeout leaves the queue usable for the next caller', async () => {
  const gate = createSpawnGate();
  const blocked = deferredResolve();
  const holding = gate.run(() => blocked.promise);
  await assert.rejects(gate.run(() => 'never', { admissionTimeoutMs: 5 }));
  blocked.resolve();
  await holding;
  assert.equal(await gate.run(() => 'ok'), 'ok');
});

test('an unreadable memory probe lets every start through and warns once per failure streak', async () => {
  const readings = [false, false, true, false];
  const warnings: string[] = [];
  const memoryAdmission = createMemoryAdmission({
    readHeadroom: async () => (readings.shift() ? { ok: true, headroomBytes: 1e12 } : { ok: false, reason: 'no cgroup' }),
    reserveBytesFor: () => 1,
    warn: (message) => warnings.push(message),
  });
  const gate = createSpawnGate({ memoryAdmission });
  const started = await Promise.all([1, 2, 3, 4].map((startNumber) => gate.run(() => startNumber)));
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.equal(warnings.length, 2, 'one warning for each run of failed reads');
});

test('a start that is no longer wanted takes no memory reservation, so the next real start is admitted at once', async () => {
  const megabyte = 1024 * 1024;
  let sleepCount = 0;
  const memoryAdmission = createMemoryAdmission({
    readHeadroom: async () => ({ ok: true, headroomBytes: 1300 * megabyte }),
    reserveBytesFor: () => 600 * megabyte,
    sleep: async () => { sleepCount += 1; },
    warn: () => {},
  });
  const gate = createSpawnGate({ memoryAdmission });
  const abandonedStarts = [1, 2].map(() => gate.run(() => 'skipped', { isStillWanted: () => false }));
  assert.equal(await gate.run(() => 'started'), 'started');
  assert.deepEqual(await Promise.all(abandonedStarts), ['skipped', 'skipped']);
  assert.equal(sleepCount, 0);
});

test('a queued start whose signal aborts while the head is held for memory leaves at once and its work never runs', async () => {
  const memoryAdmission = createMemoryAdmission({
    readHeadroom: async () => ({ ok: true, headroomBytes: 0 }),
    reserveBytesFor: () => 1,
    sleep: () => new Promise(() => {}),
    warn: () => {},
  });
  const gate = createSpawnGate({ memoryAdmission, kind: 'checkRun' });
  const memoryWaits: boolean[] = [];
  let abandonedWorkRan = false;
  void gate.run(() => 'held');
  const queuedController = new AbortController();
  const queued = gate.run(() => { abandonedWorkRan = true; }, { signal: queuedController.signal, onMemoryWait: (isWaiting) => memoryWaits.push(isWaiting) });
  await waitFor(() => memoryWaits.length === 1, 'the queued start is flagged as waiting for memory');
  queuedController.abort();
  await assert.rejects(queued, (error: unknown) => isQueueAdmissionAbandoned(error));
  assert.deepEqual(memoryWaits, [true, false]);
  assert.equal(abandonedWorkRan, false);
});
