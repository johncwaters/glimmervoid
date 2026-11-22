import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBoardAnimationQueue,
  directTurnEvents,
  transitionBoardOverlay,
  transitionBoardQueue,
} from '../public/wargames/wargames-anim-queue.ts';
import { latestResolvedTickOf } from '../public/wargames/wargames-map.ts';

function createManualClock() {
  let nextId = 1;
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    scheduled,
    scheduleTimer: (callback: () => void, delayMs: number): number => {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, delayMs });
      return id;
    },
    cancelTimer: (handle: number) => {
      scheduled.delete(handle);
    },
    flushNext: () => {
      const first = scheduled.entries().next().value;
      if (!first) return null;
      const [id, entry] = first;
      scheduled.delete(id);
      entry.callback();
      return entry.delayMs;
    },
  };
}

test('board queue and overlay state machines enforce allowed transitions', () => {
  assert.equal(transitionBoardQueue('idle', 'enqueue'), 'playing');
  assert.equal(transitionBoardQueue('idle', 'step_complete'), null);
  assert.equal(transitionBoardQueue('playing', 'queue_drained'), 'idle');
  assert.equal(transitionBoardQueue('disposed', 'enqueue'), null);

  assert.equal(transitionBoardOverlay('idle', 'start_recap'), 'recap');
  assert.equal(transitionBoardOverlay('recap', 'show_previews'), null);
  assert.equal(transitionBoardOverlay('recap', 'recap_drained'), 'idle');
  assert.equal(transitionBoardOverlay('idle', 'show_previews'), 'preview');
  assert.equal(transitionBoardOverlay('preview', 'start_recap'), 'recap');

  assert.equal(latestResolvedTickOf({}), -1);
  assert.equal(latestResolvedTickOf({ 0: {} }), 0);
  assert.equal(latestResolvedTickOf({ 0: {}, 1: {}, 2: {} }), 2);
});

test('animation queue runs beats sequentially, cleans up on clear/dispose, scales long batches, and skips under reduced motion', () => {
  const clock = createManualClock();
  const events: string[] = [];
  let drainCount = 0;

  const queue = createBoardAnimationQueue({
    maxBatchDurationMs: 1000,
    minBeatDurationMs: 200,
    scheduleTimer: clock.scheduleTimer,
    cancelTimer: clock.cancelTimer,
    onDrain: () => {
      drainCount += 1;
      events.push('drained');
    },
  });

  assert.equal(queue.getState(), 'idle');
  queue.enqueueBatch([
    {
      id: 'beat-1',
      durationMs: 400,
      start: (duration) => {
        events.push(`start:1:${duration}`);
        return () => events.push('cleanup:1');
      },
    },
    {
      id: 'beat-2',
      durationMs: 400,
      start: (duration) => {
        events.push(`start:2:${duration}`);
        return () => events.push('cleanup:2');
      },
    },
  ]);

  assert.equal(queue.getState(), 'playing');
  assert.deepEqual(events, ['start:1:400']);
  assert.equal(clock.flushNext(), 400);
  assert.deepEqual(events, ['start:1:400', 'cleanup:1', 'start:2:400']);
  assert.equal(clock.flushNext(), 400);
  assert.equal(queue.getState(), 'idle');
  assert.equal(drainCount, 1);
  assert.deepEqual(events, ['start:1:400', 'cleanup:1', 'start:2:400', 'cleanup:2', 'drained']);

  const scaledDurations: number[] = [];
  queue.enqueueBatch([
    { id: 'long-1', durationMs: 1000, start: (duration) => { scaledDurations.push(duration); return () => events.push('cleanup:long-1'); } },
    { id: 'long-2', durationMs: 1000, start: (duration) => { scaledDurations.push(duration); return undefined; } },
  ]);
  assert.deepEqual(scaledDurations, [500]);
  queue.clear();
  assert.equal(queue.getState(), 'idle');
  assert.equal(clock.scheduled.size, 0);
  assert.equal(events[events.length - 1], 'cleanup:long-1');

  let skipDrainCount = 0;
  let skippedBeatRan = false;
  const reducedQueue = createBoardAnimationQueue({
    shouldSkip: () => true,
    onDrain: () => { skipDrainCount += 1; },
  });
  reducedQueue.enqueueBatch([
    { id: 'skip-me', durationMs: 500, start: () => { skippedBeatRan = true; return undefined; } },
  ]);
  assert.equal(skippedBeatRan, false);
  assert.equal(skipDrainCount, 1);
  assert.equal(reducedQueue.getState(), 'idle');

  queue.dispose();
  assert.equal(queue.getState(), 'disposed');
  queue.enqueueBatch([{ id: 'after-dispose', durationMs: 300, start: () => { events.push('should-not-run'); return undefined; } }]);
  assert.equal(queue.getState(), 'disposed');
  assert.equal(clock.scheduled.size, 0);
});

test('directTurnEvents merges low-impact training and departures while isolating high-impact battles and captures', () => {
  const directed = directTurnEvents([
    { id: 'train', troopDelta: 4, loyaltyDelta: 0, ownerChanged: false, hasIncomingGlide: false, hasHostileGlide: false },
    { id: 'departure', troopDelta: -6, loyaltyDelta: 0, ownerChanged: false, hasIncomingGlide: false, hasHostileGlide: false },
    { id: 'reinforce', troopDelta: 5, loyaltyDelta: 0, ownerChanged: false, hasIncomingGlide: true, hasHostileGlide: false },
    { id: 'bounce', troopDelta: 0, loyaltyDelta: 0, ownerChanged: false, hasIncomingGlide: true, hasHostileGlide: true },
    { id: 'casualties', troopDelta: -3, loyaltyDelta: 0, ownerChanged: false, hasIncomingGlide: true, hasHostileGlide: false },
    { id: 'loyalty', troopDelta: 0, loyaltyDelta: -25, ownerChanged: false, hasIncomingGlide: true, hasHostileGlide: true },
    { id: 'capture', troopDelta: 0, loyaltyDelta: 0, ownerChanged: true, hasIncomingGlide: true, hasHostileGlide: true },
  ]);

  assert.deepEqual(directed.lowImpact.map((item) => item.id), ['train', 'departure', 'reinforce']);
  assert.deepEqual(directed.highImpact.map((item) => item.id), ['bounce', 'casualties', 'loyalty', 'capture']);
});
