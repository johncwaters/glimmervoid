import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { tokensFromUsage } from '../server/backend-lanes.ts';
import { createMillMetricsStore } from '../server/mill-metrics-store.ts';
import { createMillMetricsLane, createMillMetricsWiring } from '../server/mill-metrics-wiring.ts';
import type { MillMetricsPort, MillPromptSubmittedPayload } from '../server/mill-metrics-wiring.ts';
import type { MillMetricsStoreInstance } from '../server/mill-metrics-store.ts';
import type { MillMetricsConfig } from '../server/core/mill-metrics-core.ts';
import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import type { MillMetricSession } from '../shared/contracts/mill-metrics.ts';
import type { Session } from '../session/sessions.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';

interface StoredEvent {
  kind: string;
  sessionId: string;
  pack?: string;
  relPath?: string;
  promptClass?: string;
  disposition?: string | null;
  finalState?: string;
  transition?: string;
  version?: string;
  tokenEstimate?: number | null;
  agent?: string;
  ts?: number;
}

interface FakeStore extends MillMetricsStoreInstance {
  events: StoredEvent[];
  closed: MillMetricSession[];
  retainDays?: number;
}

interface VendorTotals {
  tokens: number | null;
  costUSD: number | null;
  identity?: string | null;
}

interface DeliveredPayload {
  packs: { name: string; version: string; tokenEstimate?: number | null }[];
  agent: string;
  ts: number;
  heldOut?: boolean;
}

const NOW = Date.parse('2026-08-30T12:00:00Z');

function storedEventAt(store: FakeStore, index: number): StoredEvent {
  const event = store.events.at(index);
  assert.ok(event);
  return event;
}

function closedAt(store: FakeStore, index: number): MillMetricSession {
  const record = store.closed[index];
  assert.ok(record);
  return record;
}

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  const events: StoredEvent[] = [];
  const closed: MillMetricSession[] = [];
  return {
    events,
    closed,
    appendEvent: (event: unknown) => { events.push(event as StoredEvent); },
    closeSession: (record: unknown) => { closed.push(record as MillMetricSession); },
    records: () => closed,
    load: async () => {},
    takeQueuedRecords: () => [],
    adoptQueuedRecords: () => {},
    whenIdle: async () => {},
    ...overrides,
  };
}

function millWiredSession(id: string): { session: Session; submitted: MillPromptSubmittedPayload[] } {
  const submitted: MillPromptSubmittedPayload[] = [];
  const millMetricsPort: MillMetricsPort = {
    onPacksDelivered: () => {},
    onPromptSubmitted: (_sessionId, payload) => { submitted.push(payload); },
    onSessionEnd: () => {},
    onSessionTeardown: () => {},
  };
  const session = plainSession(id);
  createSessionEventWiring({
    configStore: { save: () => null },
    config: { projects: [] },
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {} },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    millMetricsPort,
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  })(session);
  return { session, submitted };
}

function delivered(overrides: Partial<DeliveredPayload> = {}): DeliveredPayload {
  return {
    packs: [{ name: 'alpha', version: 'v1' }],
    agent: 'claude-code',
    ts: NOW,
    ...overrides,
  };
}

test('prompt classes are accumulated only for measured sessions', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPromptSubmitted('missing', { state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: true });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', { state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: true });
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING',
    ts: NOW,
    boundary: { ts: NOW - 5000, wasAwaitingInput: true },
    hasSeenTurnEnd: true,
  });
  assert.deepEqual(store.events.filter((event) => event.kind === 'prompt').map((event) => event.promptClass), [
    'interruption',
    'answer',
  ]);
});

test('a prompt before this session ended a turn is a followup, not an interruption', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', { state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: false });
  assert.deepEqual(store.events.filter((event) => event.kind === 'prompt').map((event) => event.promptClass), [
    'followup',
  ]);
});

test('a boundary-less prompt after the first is an interruption even before any turn end', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: false,
  });
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: false, hasSeenPriorPrompt: true,
  });
  assert.deepEqual(store.events.filter((event) => event.kind === 'prompt').map((event) => event.promptClass), [
    'followup',
    'interruption',
  ]);
});

test('a boundary the port cannot trust is not read as a turn end', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING',
    ts: NOW,
    boundary: { ts: Number.NaN, wasAwaitingInput: true },
    hasSeenTurnEnd: true,
  });
  assert.deepEqual(store.events.filter((event) => event.kind === 'prompt').map((event) => event.promptClass), [
    'interruption',
  ]);
});

test('session event wiring supplies and consumes the prior Stop or COMPLETE boundary', () => {
  const { session, submitted } = millWiredSession('mill-boundary');

  session.state = STATES.WAITING;
  session.emit('hook-event', { event: 'Stop', payload: {} });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('state-change', {
    from: STATES.RUNNING,
    to: STATES.COMPLETE,
    event: 'task_complete',
    detail: { signal: 'ready' },
  });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });

  assert.equal(submitted[0]?.boundary?.wasAwaitingInput, true);
  assert.equal(submitted[1]?.boundary?.wasAwaitingInput, false);
  assert.equal(submitted[2]?.boundary, null);
  assert.deepEqual(submitted.map((payload) => payload.hasSeenTurnEnd), [true, true, true]);
  session.destroy();
});

test('session event wiring keeps an answer boundary when RUNNING wins the prompt race', () => {
  const { session, submitted } = millWiredSession('mill-running-race');

  session.state = STATES.WAITING;
  session.emit('hook-event', { event: 'Stop', payload: {} });
  session.emit('state-change', {
    from: STATES.WAITING,
    to: STATES.RUNNING,
    event: 'user_input',
    detail: { signal: 'working' },
  });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: Date.now() });

  assert.equal(submitted[0]?.boundary?.wasAwaitingInput, true);
  session.destroy();
});

test('session event wiring reports no turn end until one has happened', () => {
  const { session, submitted } = millWiredSession('mill-first-prompt');

  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('hook-event', { event: 'Stop', payload: {} });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });

  assert.deepEqual(submitted.map((payload) => payload.hasSeenTurnEnd), [false, true, true]);
  assert.equal(submitted[0]?.boundary, null);
  session.destroy();
});

test('session event wiring marks every prompt after the first as having a prior prompt', () => {
  const { session, submitted } = millWiredSession('mill-prior-prompt');

  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });
  session.emit('hook-event', { event: 'Stop', payload: {} });
  session.emit('user-prompt', { state: STATES.RUNNING, ts: NOW });

  assert.deepEqual(submitted.map((payload) => payload.hasSeenPriorPrompt), [false, true, true]);
  assert.equal(submitted[1]?.boundary, null);
  session.destroy();
});

test('a session with no delivered packs creates no closed record', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.deepEqual(store.closed, []);
  assert.deepEqual(store.events, []);
});

test('session end persists disposition and the tokens this run added', () => {
  const store = fakeStore();
  let vendorTotals = { tokens: 200, costUSD: 0.5 };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW + 1000,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 1434, costUSD: 3 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).tokens, 1234);
  assert.equal(closedAt(store, 0).costUSD, 2.5);
  assert.equal(closedAt(store, 0).disposition, 'user-kill');
  assert.equal(storedEventAt(store, -1).kind, 'session-end');
  assert.equal(storedEventAt(store, -1).disposition, 'user-kill');
});

test('a close-out and a sleep-kill reach the same transition without scoring as aborts', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'close-out', finalState: 'DONE' });
  wiring.port.onPacksDelivered('s2', delivered());
  wiring.port.onSessionEnd('s2', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.deepEqual(store.closed.map((record) => record.disposition), ['natural', 'natural']);
});

test('a session torn down while live closes with no disposition instead of staying live', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionTeardown('s1');
  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).disposition, null);
  assert.equal(closedAt(store, 0).endedAt, NOW);
  assert.equal(wiring.scorecards().alpha.liveSessions, 0);
});

test('pack re-delivery closes the live accumulator before opening the replacement', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW + 2000,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW + 500, boundary: null, hasSeenTurnEnd: false,
  });
  vendorTotals = { tokens: 150, costUSD: 1.5, identity: 'conv-a' };
  wiring.port.onPacksDelivered('s1', delivered({
    packs: [{ name: 'beta', version: 'v2' }],
    ts: NOW + 1000,
  }));
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW + 1500, boundary: null, hasSeenTurnEnd: true,
  });

  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).prompts.followup, 1);
  assert.equal(closedAt(store, 0).tokens, 50);
  assert.equal(store.events.find((event) => event.transition === 'pack-redelivered')?.kind, 'session-end');
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 50);
  assert.equal(wiring.scorecards().beta.outcomes.meanTokens, 50);
  assert.equal(wiring.scorecards().beta.outcomes.meanInterruptions, 1);
});

test('a prompt arriving after teardown is attributed to the closed session', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionEnd('s1', {
    transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE',
  });
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW + 1000, boundary: null, hasSeenTurnEnd: true,
  });

  assert.equal(store.closed.length, 2);
  assert.equal(closedAt(store, 1).prompts.interruption, 1);
  const scorecard = wiring.scorecards().alpha;
  assert.equal(scorecard.outcomes.meanInterruptions, 1);
  assert.equal(scorecard.outcomes.abortRate, 1);
});

test('a torn-down session keeps no accumulator for a later prompt', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionTeardown('s1');
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: NOW + 1000, boundary: null, hasSeenTurnEnd: true,
  });

  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).prompts.interruption, 0);
});

test('a closed session is forgotten once its grace window has passed', () => {
  const store = fakeStore();
  let clock = NOW;
  const wiring = createMillMetricsWiring({ store, nowFn: () => clock });
  wiring.port.onPacksDelivered('s1', delivered());
  wiring.port.onSessionEnd('s1', {
    transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE',
  });
  clock = NOW + 11 * 60 * 1000;
  wiring.port.onPromptSubmitted('s1', {
    state: 'RUNNING', ts: clock, boundary: null, hasSeenTurnEnd: true,
  });

  assert.equal(store.closed.length, 1);
});

test('closed sessions are capped instead of retained for the life of the process', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  for (let index = 0; index < 65; index += 1) {
    const sessionId = `s${index}`;
    wiring.port.onPacksDelivered(sessionId, delivered());
    wiring.port.onSessionEnd(sessionId, {
      transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE',
    });
  }
  assert.equal(store.closed.length, 65);

  wiring.port.onPromptSubmitted('s0', {
    state: 'RUNNING', ts: NOW + 1000, boundary: null, hasSeenTurnEnd: true,
  });
  assert.equal(store.closed.length, 65);

  wiring.port.onPromptSubmitted('s64', {
    state: 'RUNNING', ts: NOW + 1000, boundary: null, hasSeenTurnEnd: true,
  });
  assert.equal(store.closed.length, 66);
});

test('live scorecards report the tokens the run has added so far', () => {
  const store = fakeStore();
  let vendorTotals = { tokens: 500, costUSD: 1 };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 1.5 };
  const scorecard = wiring.scorecards().alpha;
  assert.equal(scorecard.liveSessions, 1);
  assert.equal(scorecard.outcomes.meanTokens, 400);
  assert.equal(scorecard.outcomes.abortRate, null);
});

test('a run whose usage is unscanned when it starts waits for a real baseline instead of guessing zero', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = null;
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, null);
  vendorTotals = { tokens: 9000, costUSD: 20 };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 0);
  vendorTotals = { tokens: 9200, costUSD: 20.5 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
  assert.equal(closedAt(store, 0).costUSD, 0.5);
});

test('a conversation created mid-run is billed to this run in full, on top of what was banked', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 400, costUSD: 2, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 300);
  vendorTotals = { tokens: 50, costUSD: 0.5, identity: 'conv-b' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 350);
  vendorTotals = { tokens: 120, costUSD: 0.9, identity: 'conv-b' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 420);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 1.9);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-b');
});

test('a total that moves backward banks the delta already earned instead of erasing it', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 3, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 800);
  vendorTotals = { tokens: 40, costUSD: 0.4, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 800);
  vendorTotals = { tokens: 90, costUSD: 0.9, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 850);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 2.5);
});

test('an identity that only arrives after the baseline is not treated as a new conversation', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 9000, costUSD: 20, identity: null };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 9200, costUSD: 20.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-a');
});

test('measurement starts live and a retention change swaps the store behind it', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  let millMetricsConfig = { retainDays: 90, holdoutPercent: 0 };
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    createStore: ({ retainDays }) => {
      const store = fakeStore({ retainDays, whenIdle: async () => { order.push('drain'); } });
      order.push(`open:${retainDays}`);
      stores.push(store);
      return store;
    },
    nowFn: () => NOW,
  });
  lane.port.onPacksDelivered('s1', delivered());
  assert.equal(lane.scorecards().alpha.liveSessions, 1);

  millMetricsConfig = { retainDays: 30, holdoutPercent: 0 };
  await lane.restartIfConfigChanged();
  assert.deepEqual(order, ['open:90', 'drain', 'open:30']);
  assert.equal(lane.currentStore(), stores[1]);

  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(stores[0]?.closed.length, 0);
  assert.equal(stores[1]?.closed.length, 1);

  assert.equal(stores.length, 2);
});

function gatedLane(
  order: string[],
  stores: FakeStore[],
  gate: { promise: Promise<void>; open: () => void },
  initialConfig: MillMetricsConfig,
  logger: Pick<Console, 'warn'> | null = null,
) {
  let millMetricsConfig = initialConfig;
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    logger,
    createStore: ({ retainDays }) => {
      const index = stores.length;
      const store = fakeStore({
        retainDays,
        whenIdle: async () => {
          order.push(`drain:${retainDays}`);
          if (index === 0) await gate.promise;
        },
      });
      order.push(`open:${retainDays}`);
      stores.push(store);
      return store;
    },
    nowFn: () => NOW,
  });
  return { lane, setConfig: (next: MillMetricsConfig) => { millMetricsConfig = next; } };
}

function openGate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((settle) => { open = () => settle(); });
  return { promise, open };
}

const tick = () => new Promise<void>((settle) => { setImmediate(() => settle()); });

test('a session closing while the store is swapping is replayed into the replacement', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90, holdoutPercent: 0 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30, holdoutPercent: 0 });
  const swap = lane.restartIfConfigChanged();
  await tick();
  assert.equal(lane.currentStore(), null);
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await swap;
  assert.equal(stores.length, 2);
  assert.equal(stores[0]?.closed.length, 0);
  assert.equal(stores[1]?.closed.length, 1);
  assert.equal(stores[1].events.filter((event) => event.kind === 'session-end').length, 1);
});

test('two settings changes during one drain end on a single open store', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90, holdoutPercent: 0 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30, holdoutPercent: 0 });
  const first = lane.restartIfConfigChanged();
  await tick();
  setConfig({ retainDays: 60, holdoutPercent: 0 });
  const second = lane.restartIfConfigChanged();
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['open:90', 'drain:90', 'open:60']);
  assert.equal(stores.length, 2);
  assert.equal(lane.currentStore(), stores[1]);
  assert.equal(stores[1]?.closed.length, 1);
});

test('shutdown during a store swap drains the replacement as well', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90, holdoutPercent: 0 });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30, holdoutPercent: 0 });
  void lane.restartIfConfigChanged();
  await tick();
  lane.port.onSessionTeardown('s1');
  const idle = lane.whenIdle();
  gate.open();
  await idle;
  assert.deepEqual(order, ['open:90', 'drain:90', 'open:30', 'drain:30']);
  assert.equal(stores[1]?.closed.length, 1);
});

test('a swap buffer filled with events gives ground to a close instead of dropping it', async () => {
  const order: string[] = [];
  const stores: FakeStore[] = [];
  const gate = openGate();
  const warnings: string[] = [];
  const { lane, setConfig } = gatedLane(order, stores, gate, { retainDays: 90, holdoutPercent: 0 }, {
    warn: (message: string) => { warnings.push(message); },
  });
  lane.port.onPacksDelivered('s1', delivered());
  setConfig({ retainDays: 30, holdoutPercent: 0 });
  const swap = lane.restartIfConfigChanged();
  await tick();
  for (let index = 0; index < 600; index += 1) {
    lane.port.onPromptSubmitted('s1', { state: 'RUNNING', ts: NOW });
  }
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  gate.open();
  await swap;
  assert.equal(stores[1]?.closed.length, 1);
  assert.equal(stores[1].events.length, 499);
  assert.ok(warnings.some((message) => /dropping an event to keep a close/.test(message)));
});

test('a conversation first identified after the packs land is billed to this run in full', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = null;
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 300, costUSD: 0.75, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).costUSD, 0.75);
});

test('a conversation known at delivery but scanned later still bills only what this run added', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: null, costUSD: null, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 9000, costUSD: 20, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 0);
  vendorTotals = { tokens: 9200, costUSD: 20.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 200);
});

test('a tokens rewind keeps the cost that the same sample added', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 100, costUSD: 1, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 900, costUSD: 3, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 800);
  vendorTotals = { tokens: 40, costUSD: 3.5, identity: 'conv-a' };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 800);
  assert.equal(Math.round((closedAt(store, 0).costUSD ?? 0) * 100) / 100, 2.5);
});

test('a resumed card reports its own run, not the whole conversation', () => {
  const store = fakeStore();
  let vendorTotals: VendorTotals | null = { tokens: 900, costUSD: 2, identity: 'conv-a' };
  const wiring = createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: () => vendorTotals,
  });
  wiring.port.onPacksDelivered('s1', delivered());
  vendorTotals = { tokens: 1100, costUSD: 2.5, identity: 'conv-a' };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 200);
});

function laneFedByUsage(
  store: FakeStore,
  sessions: Map<string, { resumeSessionId: string | null }>,
  readTotals: () => VendorTotals | null,
) {
  return createMillMetricsWiring({
    store,
    nowFn: () => NOW,
    tokensForSession: (sessionId) => tokensFromUsage({ sessionTotals: readTotals }, sessions, sessionId),
  });
}

test('a resumed card whose usage is unscanned at delivery is never billed the prior conversation', () => {
  const store = fakeStore();
  const sessions = new Map([['s1', { resumeSessionId: 'conv-a' }]]);
  let vendorTotals: VendorTotals | null = null;
  const wiring = laneFedByUsage(store, sessions, () => vendorTotals);
  wiring.port.onPacksDelivered('s1', delivered());
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, null);
  vendorTotals = { tokens: 500000, costUSD: 12.5 };
  assert.equal(wiring.scorecards().alpha.outcomes.meanTokens, 0);
  vendorTotals = { tokens: 500300, costUSD: 12.6 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).resumeSessionId, 'conv-a');
});

test('a fresh session whose vendor identity arrives mid-run is billed the whole conversation', () => {
  const store = fakeStore();
  const sessions = new Map<string, { resumeSessionId: string | null }>([['s1', { resumeSessionId: null }]]);
  let vendorTotals: VendorTotals | null = null;
  const wiring = laneFedByUsage(store, sessions, () => vendorTotals);
  wiring.port.onPacksDelivered('s1', delivered());
  sessions.set('s1', { resumeSessionId: 'conv-new' });
  vendorTotals = { tokens: 300, costUSD: 0.75 };
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).tokens, 300);
  assert.equal(closedAt(store, 0).costUSD, 0.75);
});

test('a store replaced while holding unpersisted closes hands them to its replacement', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-mill-metrics-swap-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const recordsPath = path.join(root, 'mill-metrics.json');
  const eventsDir = path.join(root, 'mill-metrics');
  let readable = false;
  let millMetricsConfig = { retainDays: 90, holdoutPercent: 0 };
  const lane = createMillMetricsLane({
    resolveConfig: () => millMetricsConfig,
    nowFn: () => NOW,
    createStore: ({ retainDays }) => createMillMetricsStore({
      recordsPath,
      eventsDir,
      retainDays,
      nowFn: () => NOW,
      fsPromises: {
        ...fsp,
        readFile: async (target: string, encoding: 'utf8') => {
          if (target === recordsPath && !readable) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          }
          return fsp.readFile(target, encoding);
        },
      },
    }),
  });
  lane.port.onPacksDelivered('s1', delivered());
  lane.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'natural', finalState: 'DONE' });
  await lane.whenIdle();
  assert.equal(fs.existsSync(recordsPath), false);

  readable = true;
  millMetricsConfig = { retainDays: 30, holdoutPercent: 0 };
  await lane.restartIfConfigChanged();
  await lane.whenIdle();
  const persisted = JSON.parse(await fsp.readFile(recordsPath, 'utf8')) as { sessions: { sessionId: string }[] };
  assert.deepEqual(persisted.sessions.map((entry) => entry.sessionId), ['s1']);
});

test('a held-out spawn closes as a holdout record with no packs and no pack events', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered({ packs: [], heldOut: true }));
  wiring.port.onPromptSubmitted('s1', { state: 'RUNNING', ts: NOW, boundary: null, hasSeenTurnEnd: true });
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.equal(store.closed.length, 1);
  assert.equal(closedAt(store, 0).arm, 'holdout');
  assert.deepEqual(closedAt(store, 0).packs, []);
  assert.equal(closedAt(store, 0).prompts.interruption, 1);
  assert.equal(store.events.some((event) => event.kind === 'pack-delivered'), false);
});

test('a delivered spawn closes as the packs arm', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered({ heldOut: false }));
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.equal(closedAt(store, 0).arm, 'packs');
  assert.equal(closedAt(store, 0).packs.length, 1);
});

test('an empty pack list that was not held out is still not measured', () => {
  const store = fakeStore();
  const wiring = createMillMetricsWiring({ store, nowFn: () => NOW });
  wiring.port.onPacksDelivered('s1', delivered({ packs: [] }));
  wiring.port.onPacksDelivered('s2', delivered({ packs: [{ name: '', version: 'v1' }] }));
  wiring.port.onSessionEnd('s1', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  wiring.port.onSessionEnd('s2', { transitionEvent: 'user_kill', intent: 'operator-abort', finalState: 'DONE' });
  assert.deepEqual(store.closed, []);
});
