import WebSocket from 'ws';
import { z } from 'zod';

import { KILLABLE_STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { dashboardClient, openRecordingSocket, waitForMessage } from '../../tests/helpers/dashboard-ws.ts';

export interface SnapshotSessionSummary {
  id: string;
  name: string;
  state: string;
  hasParent: boolean;
}

export interface PendingWakeSummary {
  sessionId: string;
  wakeId: string;
}

export interface CaseTeardownPlan {
  wakesToCancel: PendingWakeSummary[];
  sessionIdsToRemove: string[];
  baselineSessionIdsToKill: string[];
}

export interface CaseBaseline {
  sessionIds: Set<string>;
}

export interface CaseTeardownOutcome {
  ok: boolean;
  detail: string;
}

const TEARDOWN_DEADLINE_MS = 15000;
const CONTROL_REPLY_TIMEOUT_MS = 5000;
const SOCKET_CLOSE_TIMEOUT_MS = 500;
const TEARDOWN_POLL_INTERVAL_MS = 100;
const MAX_REMOVAL_ATTEMPTS = 4;

const KILLABLE_STATE_SET: ReadonlySet<string> = new Set<SessionState>(KILLABLE_STATES);

const SnapshotFrame = z.object({
  type: z.literal('snapshot'),
  sessions: z.array(z.object({
    id: z.string(),
    name: z.string().default(''),
    state: z.string().default(''),
    parent: z.unknown().nullish(),
  })),
});

const SessionWakesFrame = z.object({
  type: z.literal('session-wakes'),
  id: z.string(),
  wakes: z.array(z.object({ id: z.string() })),
});

const StartPicksFrame = z.object({
  type: z.literal('start-picks'),
  requestId: z.string().nullish(),
});

const RemoveSessionResultFrame = z.object({
  type: z.literal('remove-session-result'),
  requestId: z.string().nullish(),
  ok: z.boolean(),
  error: z.string().nullish(),
  canDiscardWork: z.boolean().optional(),
  keptPaths: z.array(z.object({ path: z.string() })).optional(),
});

const SessionActionResultFrame = z.object({
  type: z.literal('session-action-result'),
  requestId: z.string().nullish(),
  ok: z.boolean(),
  error: z.string().nullish(),
});

function isKillableSessionState(state: string): boolean {
  return KILLABLE_STATE_SET.has(state);
}

export function planCaseTeardown({
  caseSessionId,
  baselineSessionIds,
  sessions,
  wakes,
}: {
  caseSessionId: string;
  baselineSessionIds: ReadonlySet<string>;
  sessions: readonly SnapshotSessionSummary[];
  wakes: readonly PendingWakeSummary[];
}): CaseTeardownPlan {
  const childSessionIds: string[] = [];
  const topLevelSessionIds: string[] = [];
  const baselineSessionIdsToKill: string[] = [];

  for (const session of sessions) {
    const isCaseOwned = session.id === caseSessionId || !baselineSessionIds.has(session.id);
    if (isCaseOwned) {
      if (session.hasParent) {
        childSessionIds.push(session.id);
        continue;
      }
      topLevelSessionIds.push(session.id);
      continue;
    }
    if (isKillableSessionState(session.state)) {
      baselineSessionIdsToKill.push(session.id);
    }
  }

  return {
    wakesToCancel: [...wakes],
    sessionIdsToRemove: [...childSessionIds, ...topLevelSessionIds],
    baselineSessionIdsToKill,
  };
}

export function describeTeardownSurvivors({
  caseSessionId,
  baselineSessionIds,
  sessions,
  wakes,
}: {
  caseSessionId: string;
  baselineSessionIds: ReadonlySet<string>;
  sessions: readonly SnapshotSessionSummary[];
  wakes: readonly PendingWakeSummary[];
}): string | null {
  const parts: string[] = [];
  const survivingCaseSessions = sessions.filter((session) => session.id === caseSessionId || !baselineSessionIds.has(session.id));
  if (survivingCaseSessions.length > 0) {
    parts.push(`sessions=[${survivingCaseSessions.map((session) => `${session.name || session.id}(${session.state})`).join(', ')}]`);
  }
  const survivingLiveBaseline = sessions.filter((session) => session.id !== caseSessionId && baselineSessionIds.has(session.id) && isKillableSessionState(session.state));
  if (survivingLiveBaseline.length > 0) {
    parts.push(`liveBaseline=[${survivingLiveBaseline.map((session) => `${session.name || session.id}(${session.state})`).join(', ')}]`);
  }
  if (wakes.length > 0) {
    parts.push(`wakes=[${wakes.map((wake) => `${wake.sessionId}:${wake.wakeId}`).join(', ')}]`);
  }
  if (parts.length === 0) return null;
  return `leaked server state after case teardown: ${parts.join(' ')}`;
}

function portFromBaseUrl(baseUrl: string): number {
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(`harness baseUrl carries no numeric port: ${baseUrl}`);
  }
  return port;
}

interface ServerControlState {
  sessions: SnapshotSessionSummary[];
  wakes: PendingWakeSummary[];
}

function closeControlSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      ws.off('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      finish();
    }, SOCKET_CLOSE_TIMEOUT_MS);
    ws.once('close', finish);
    try {
      ws.close();
    } catch {
      finish();
    }
  });
}

async function readServerControlState(baseUrl: string, timeoutMs: number): Promise<ServerControlState> {
  const client = await dashboardClient(portFromBaseUrl(baseUrl), AbortSignal.timeout(timeoutMs));
  const socket = await openRecordingSocket<unknown>(client, '/control');
  try {
    const syncRequestId = `harness-teardown-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    socket.ws.send(JSON.stringify({ type: 'list-start-picks', requestId: syncRequestId }));
    await waitForMessage(
      socket.received,
      (frame) => {
        const parsed = StartPicksFrame.safeParse(frame);
        return parsed.success && parsed.data.requestId === syncRequestId;
      },
      'teardown state sync',
      timeoutMs,
    );

    const sessions: SnapshotSessionSummary[] = [];
    const wakesBySessionId = new Map<string, string[]>();
    let hasSnapshot = false;
    for (const frame of socket.received) {
      const snapshot = SnapshotFrame.safeParse(frame);
      if (snapshot.success) {
        hasSnapshot = true;
        sessions.length = 0;
        for (const session of snapshot.data.sessions) {
          sessions.push({
            id: session.id,
            name: session.name,
            state: session.state,
            hasParent: session.parent !== null && session.parent !== undefined,
          });
        }
        continue;
      }
      const wakeFrame = SessionWakesFrame.safeParse(frame);
      if (wakeFrame.success) {
        wakesBySessionId.set(wakeFrame.data.id, wakeFrame.data.wakes.map((wake) => wake.id));
      }
    }
    if (!hasSnapshot) {
      throw new Error('control server answered start-picks without a valid snapshot');
    }

    const wakes: PendingWakeSummary[] = [];
    for (const [sessionId, wakeIds] of wakesBySessionId) {
      for (const wakeId of wakeIds) {
        wakes.push({ sessionId, wakeId });
      }
    }
    return { sessions, wakes };
  } finally {
    await closeControlSocket(socket.ws);
  }
}

async function sendRemovalAttempt(
  socket: Awaited<ReturnType<typeof openRecordingSocket<unknown>>>,
  sessionId: string,
  confirmedKeptPaths: readonly string[] | undefined,
  attempt: number,
  timeoutMs: number,
): Promise<z.infer<typeof RemoveSessionResultFrame>> {
  const requestId = `harness-teardown-remove-${sessionId}-${attempt}-${Date.now()}`;
  const message: Record<string, unknown> = {
    type: 'remove-session',
    id: sessionId,
    discardWork: true,
    requestId,
  };
  if (confirmedKeptPaths && confirmedKeptPaths.length > 0) {
    message.confirmedKeptPaths = confirmedKeptPaths;
  }
  socket.ws.send(JSON.stringify(message));
  const reply = await waitForMessage(
    socket.received,
    (frame): frame is z.infer<typeof RemoveSessionResultFrame> => {
      const parsed = RemoveSessionResultFrame.safeParse(frame);
      return parsed.success && parsed.data.requestId === requestId;
    },
    `remove-session reply for ${sessionId}`,
    timeoutMs,
  );
  return RemoveSessionResultFrame.parse(reply);
}

async function removeSessionForTeardown(
  socket: Awaited<ReturnType<typeof openRecordingSocket<unknown>>>,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  let confirmedKeptPaths: string[] | undefined;
  for (let attempt = 1; attempt <= MAX_REMOVAL_ATTEMPTS; attempt += 1) {
    const reply = await sendRemovalAttempt(socket, sessionId, confirmedKeptPaths, attempt, timeoutMs);
    if (reply.ok) return;
    if (reply.error === 'Session not found') return;
    if (reply.canDiscardWork !== true) return;
    confirmedKeptPaths = reply.keptPaths?.map((kept) => kept.path);
  }
}

async function sendActionForTeardown(
  socket: Awaited<ReturnType<typeof openRecordingSocket<unknown>>>,
  payload: Record<string, unknown>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const requestId = `harness-teardown-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  socket.ws.send(JSON.stringify({ ...payload, requestId }));
  await waitForMessage(
    socket.received,
    (frame) => {
      const parsed = SessionActionResultFrame.safeParse(frame);
      return parsed.success && parsed.data.requestId === requestId;
    },
    label,
    timeoutMs,
  );
}

async function executeTeardownPlan(baseUrl: string, plan: CaseTeardownPlan, timeoutMs: number): Promise<void> {
  const client = await dashboardClient(portFromBaseUrl(baseUrl), AbortSignal.timeout(timeoutMs));
  const socket = await openRecordingSocket<unknown>(client, '/control');
  try {
    for (const wake of plan.wakesToCancel) {
      await sendActionForTeardown(socket, { type: 'cancel-wake', id: wake.sessionId, wake: wake.wakeId }, `cancel-wake ${wake.sessionId}:${wake.wakeId}`, timeoutMs);
    }
    for (const sessionId of plan.sessionIdsToRemove) {
      await removeSessionForTeardown(socket, sessionId, timeoutMs);
    }
    for (const sessionId of plan.baselineSessionIdsToKill) {
      await sendActionForTeardown(socket, { type: 'kill', id: sessionId }, `kill ${sessionId}`, timeoutMs);
    }
  } finally {
    await closeControlSocket(socket.ws);
  }
}

export async function captureCaseBaseline(baseUrl: string, timeoutMs = CONTROL_REPLY_TIMEOUT_MS): Promise<CaseBaseline> {
  const state = await readServerControlState(baseUrl, timeoutMs);
  return { sessionIds: new Set(state.sessions.map((session) => session.id)) };
}

export async function teardownCaseServerState({
  baseUrl,
  caseSessionId,
  baselineSessionIds,
}: {
  baseUrl: string;
  caseSessionId: string;
  baselineSessionIds: ReadonlySet<string>;
}): Promise<CaseTeardownOutcome> {
  const deadline = Date.now() + TEARDOWN_DEADLINE_MS;
  let removedSessionCount = 0;
  let cancelledWakeCount = 0;
  let killedBaselineCount = 0;
  let lastSurvivorDetail = 'teardown did not complete';

  while (Date.now() < deadline) {
    const remainingMs = Math.max(500, Math.min(CONTROL_REPLY_TIMEOUT_MS, deadline - Date.now()));
    const state = await readServerControlState(baseUrl, remainingMs);
    const survivors = describeTeardownSurvivors({
      caseSessionId,
      baselineSessionIds,
      sessions: state.sessions,
      wakes: state.wakes,
    });
    if (survivors === null) {
      return {
        ok: true,
        detail: `removed ${removedSessionCount} sessions, cancelled ${cancelledWakeCount} wakes, killed ${killedBaselineCount} baseline sessions`,
      };
    }
    lastSurvivorDetail = survivors;
    const plan = planCaseTeardown({
      caseSessionId,
      baselineSessionIds,
      sessions: state.sessions,
      wakes: state.wakes,
    });
    removedSessionCount += plan.sessionIdsToRemove.length;
    cancelledWakeCount += plan.wakesToCancel.length;
    killedBaselineCount += plan.baselineSessionIdsToKill.length;
    await executeTeardownPlan(baseUrl, plan, remainingMs);
    if (Date.now() + TEARDOWN_POLL_INTERVAL_MS < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, TEARDOWN_POLL_INTERVAL_MS); });
    }
  }

  return { ok: false, detail: lastSurvivorDetail };
}
