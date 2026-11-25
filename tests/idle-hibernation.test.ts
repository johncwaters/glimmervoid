import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import type { Session } from '../session/sessions.ts';
import type { SessionState } from '../shared/states.ts';
import { createBackendHealth } from '../server/backend/backend-health.ts';
import { STATES } from '../shared/states.ts';
import { clock } from '../shared/clock.ts';

const GIGABYTE = 1024 * 1024 * 1024;
type HealthSessionMap = Parameters<typeof createBackendHealth>[0]['sessions'];
type HealthSessionItem = HealthSessionMap extends Map<string, infer T> ? T : never;

function makeFakeSession({
  id,
  state,
  stateSince,
  hasLivePty = true,
  resumeSessionId = `conv-${id}`,
  ephemeral = false,
  hasBackgroundWork = false,
  snoozeOk = true,
}: {
  id: string;
  state: SessionState;
  stateSince: number;
  hasLivePty?: boolean;
  resumeSessionId?: string | null;
  ephemeral?: boolean;
  hasBackgroundWork?: boolean;
  snoozeOk?: boolean;
}) {
  let snoozeCalls = 0;
  let currentState: SessionState = state;
  let livePty = hasLivePty;
  const session: HealthSessionItem = {
    id,
    get state() { return currentState; },
    stateSince,
    get hasLivePty() { return livePty; },
    resumeSessionId,
    ephemeral,
    hasBackgroundWork,
    snooze: () => {
      snoozeCalls += 1;
      if (!snoozeOk) return { ok: false, reason: 'no-conversation' };
      currentState = STATES.DORMANT;
      livePty = false;
      return { ok: true };
    },
    getHealthStats: () => ({ id, name: id, state: currentState, destroyed: false, pendingRestart: false, hasPty: livePty, ptyPid: null, outputBufferEntries: 0, outputBufferBytes: 0, outputBufferTotal: 0, auditLogLength: 0, dataListenerCount: 0, hookSeen: false, timers: { killPoll: false } }),
    getDetectionStats: () => ({} as ReturnType<Session['getDetectionStats']>),
  };
  return { session, snoozeCount: () => snoozeCalls };
}

test('runIdleHibernationSweep snoozes TTL-expired unviewed idle/complete sessions and skips busy or actively viewed ones', async () => {
  const now = clock.nowMs();
  const expiredIdle = makeFakeSession({ id: 'expired-idle', state: STATES.IDLE, stateSince: now - 15 * 60 * 1000 });
  const unviewedSocketIdle = makeFakeSession({ id: 'unviewed-socket', state: STATES.IDLE, stateSince: now - 15 * 60 * 1000 });
  const viewedIdle = makeFakeSession({ id: 'viewed-idle', state: STATES.IDLE, stateSince: now - 15 * 60 * 1000 });
  const bgActive = makeFakeSession({ id: 'bg-active', state: STATES.COMPLETE, stateSince: now - 15 * 60 * 1000, hasBackgroundWork: true });
  const waiting = makeFakeSession({ id: 'waiting', state: STATES.WAITING, stateSince: now - 15 * 60 * 1000 });
  const freshIdle = makeFakeSession({ id: 'fresh-idle', state: STATES.IDLE, stateSince: now - 60 * 1000 });

  const sessions: HealthSessionMap = new Map([
    ['expired-idle', expiredIdle.session],
    ['unviewed-socket', unviewedSocketIdle.session],
    ['viewed-idle', viewedIdle.session],
    ['bg-active', bgActive.session],
    ['waiting', waiting.session],
    ['fresh-idle', freshIdle.session],
  ]);
  const sessionDataClients = new Map<string, Map<WebSocket, unknown>>([
    ['unviewed-socket', new Map([[{} as WebSocket, null]])],
    ['viewed-idle', new Map([[{} as WebSocket, { cols: 120, rows: 40 }]])],
  ]);

  const health = createBackendHealth({
    sessions,
    getAllSessions: () => [...sessions.values()],
    sessionDataClients,
    getMemoryGateStatus: () => ({ headroomBytes: 4 * GIGABYTE, headroomReadAtMs: now, heldStartCount: 0 }),
    idleHibernation: {
      idleHibernateMs: 10 * 60 * 1000,
      headroomFloorBytes: 2 * GIGABYTE,
      readHeadroom: async () => ({ ok: true, headroomBytes: 4 * GIGABYTE }),
    },
    controlWss: { clients: new Set() },
    viewerControlClientCount: () => 0,
    dataWss: { clients: new Set() },
    broadcastControl: () => {},
  });

  try {
    const snoozed = await health.runIdleHibernationSweep();
    assert.deepEqual(snoozed, ['expired-idle', 'unviewed-socket']);
    assert.equal(expiredIdle.snoozeCount(), 1);
    assert.equal(unviewedSocketIdle.snoozeCount(), 1);
    assert.equal(viewedIdle.snoozeCount(), 0);
    assert.equal(bgActive.snoozeCount(), 0);
    assert.equal(waiting.snoozeCount(), 0);
    assert.equal(freshIdle.snoozeCount(), 0);
  } finally {
    clearInterval(health.healthInterval);
  }
});

test('runIdleHibernationSweep under low headroom skips unresumable sessions and snoozes the single oldest resumable victim per tick', async () => {
  const now = clock.nowMs();
  const unresumableOld = makeFakeSession({ id: 'unresumable-old', state: STATES.IDLE, stateSince: now - 8 * 60 * 1000, resumeSessionId: null, snoozeOk: false });
  const older = makeFakeSession({ id: 'older', state: STATES.COMPLETE, stateSince: now - 5 * 60 * 1000 });
  const newer = makeFakeSession({ id: 'newer', state: STATES.IDLE, stateSince: now - 1 * 60 * 1000 });

  const sessions: HealthSessionMap = new Map([
    ['unresumable-old', unresumableOld.session],
    ['newer', newer.session],
    ['older', older.session],
  ]);

  const health = createBackendHealth({
    sessions,
    getAllSessions: () => [...sessions.values()],
    sessionDataClients: new Map(),
    getMemoryGateStatus: () => ({ headroomBytes: 1 * GIGABYTE, headroomReadAtMs: now, heldStartCount: 0 }),
    idleHibernation: {
      idleHibernateMs: 10 * 60 * 1000,
      headroomFloorBytes: 2 * GIGABYTE,
      readHeadroom: async () => ({ ok: true, headroomBytes: 1 * GIGABYTE }),
    },
    controlWss: { clients: new Set() },
    viewerControlClientCount: () => 0,
    dataWss: { clients: new Set() },
    broadcastControl: () => {},
  });

  try {
    const firstTick = await health.runIdleHibernationSweep();
    assert.deepEqual(firstTick, ['older']);
    assert.equal(unresumableOld.snoozeCount(), 0);
    assert.equal(older.snoozeCount(), 1);
    assert.equal(newer.snoozeCount(), 0);

    const secondTick = await health.runIdleHibernationSweep();
    assert.deepEqual(secondTick, ['newer']);
    assert.equal(newer.snoozeCount(), 1);
  } finally {
    clearInterval(health.healthInterval);
  }
});
