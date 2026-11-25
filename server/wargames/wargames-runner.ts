import { randomBytes } from 'node:crypto';

import type { WargamesSeatBinding, WargamesSeatPort, WargamesToolName, WargamesToolReply } from '../../mcp/wargames-tools.ts';
import { clock } from '../../shared/clock.ts';
import type { AgentModelCatalog } from '../../shared/contracts/agent-models.ts';
import { MessageChannel, OrderItem, SeatId } from '../../shared/contracts/wargames.ts';
import type { MessageRecord } from '../../shared/contracts/wargames.ts';
import type {
  ModelEloRow,
  SeatConfig,
  TickPhase,
  WargamesEvent,
  WargamesHistory,
  WargamesMatchSpec,
  WargamesMatchSummary,
  WargamesPhaseClock,
  WargamesRejection,
} from '../../shared/contracts/wargames.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn } from '../../shared/timer-deps.ts';
import { computeEloFromSummaries, summarizeMatch } from '../../shared/wargames/analytics.ts';
import {
  applyEvent,
  createInitialMatchState,
  projectSeatState,
  matchSeatIds,
  seatIndexOf,
} from '../../shared/wargames/engine.ts';
import type { MatchState } from '../../shared/wargames/engine.ts';
import { currentAgentModelCatalog } from '../agent-models/agent-models.ts';
import { createAwakeTimeoutFn } from '../awake-timer.ts';
import type { WargamesStore } from './wargames-store.ts';

type WargamesBroadcastFrame =
  | { type: 'wargames-status'; matches: WargamesMatchSummary[] }
  | { type: 'wargames-history'; history: WargamesHistory }
  | { type: 'wargames-events'; matchId: string; events: WargamesEvent[]; reset: boolean; phaseClock: WargamesPhaseClock | null };

type SeatLaunchFn = (
  matchId: string,
  seat: SeatConfig,
  bindSession: (sessionId: string) => void,
) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;

interface SeatSession {
  sessionId: string;
  seatId: SeatId;
}

interface WokenSeat extends SeatSession {
  messages: MessageRecord[];
}

interface WargamesMatchHooks {
  onPhaseChanged?: (state: MatchState, seatSessions: readonly SeatSession[]) => void;
  onSeatsWoken?: (state: MatchState, wokenSeats: readonly WokenSeat[]) => SeatId[];
  onMatchEnded?: (matchId: string, sessionIds: readonly string[]) => void;
}

const MAX_NOTE_WRITES_PER_TICK = 8;
const TIMED_PHASES_PER_TICK = 2;
const MAX_WAIT_FOR_CHANGE_MS = 30_000;

interface LiveMatch {
  state: MatchState;
  eventCount: number;
  deadlineTimer: NodeJS.Timeout | null;
  phaseDeadline: { deadlineAtMs: number; lengthMs: number } | null;
  sessionIds: string[];
  serialQueue: Promise<void>;
  tickToolCounts: Map<string, number>;
  phaseWaiters: Map<() => void, SeatId>;
  wokenSeatIds: Set<SeatId>;
  seenMessageCountBySeat: Map<SeatId, number>;
  hooks?: WargamesMatchHooks;
}

export interface WargamesRunner extends WargamesSeatPort {
  load(): Promise<void>;
  startMatch(spec: WargamesMatchSpec, launchSeat?: SeatLaunchFn, hooks?: WargamesMatchHooks): Promise<{ ok: true; matchId: string; error: string | null } | { ok: false; error: string }>;
  abortMatch(matchId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }>;
  seatSessionEnded(sessionId: string, reason: string): void;
  watchMatch(matchId: string, watcherId: string): Promise<{ ok: true; events: WargamesEvent[]; phaseClock: WargamesPhaseClock | null } | { ok: false; error: string }>;
  unwatchMatch(matchId: string, watcherId: string): void;
  removeWatcher(watcherId: string): void;
  statusFrame(): { type: 'wargames-status'; matches: WargamesMatchSummary[] };
  historyFrame(): { type: 'wargames-history'; history: WargamesHistory };
  dispose(): void;
}

interface WargamesRunnerDeps {
  store: WargamesStore;
  broadcast: (frame: WargamesBroadcastFrame) => void;
  log: Pick<Console, 'log' | 'warn'>;
  now?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  readAgentModels?: () => AgentModelCatalog;
}

function normalizeModelDisplay(candidate: string | null | undefined, fallback: string): string {
  const normalized = candidate?.trim().slice(0, 120) ?? '';
  return normalized.length > 0 ? normalized : fallback;
}

function resolveSeatModelDisplay(seat: SeatConfig, catalog: AgentModelCatalog): string {
  const explicitModel = seat.setup.model?.trim() || null;
  const entry = catalog.agents.find((candidate) => candidate.agent === seat.setup.agent);
  if (!entry) return normalizeModelDisplay(explicitModel, seat.modelDisplay);
  if (explicitModel) {
    const matched = entry.models.find(
      (model) => model.id === explicitModel || model.aliases.includes(explicitModel) || model.label === explicitModel,
    );
    return normalizeModelDisplay(matched ? matched.label : explicitModel, seat.modelDisplay);
  }
  const configuredId = entry.configuredDefault?.model?.trim() || null;
  if (configuredId) {
    const matched = entry.models.find((model) => model.id === configuredId || model.aliases.includes(configuredId));
    return normalizeModelDisplay(matched ? matched.label : configuredId, seat.modelDisplay);
  }
  const defaultModel = entry.models.find((model) => model.isDefault);
  return normalizeModelDisplay(defaultModel?.label, seat.modelDisplay);
}

function rejectionReply(code: WargamesRejection['code'], message: string): WargamesToolReply {
  return { ok: false, rejection: { code, message } };
}

export function createWargamesRunner({
  store,
  broadcast,
  log,
  now = clock.nowMs,
  setTimeoutFn = createAwakeTimeoutFn(),
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  readAgentModels = currentAgentModelCatalog,
}: WargamesRunnerDeps): WargamesRunner {
  const liveByMatchId = new Map<string, LiveMatch>();
  const seatBySessionId = new Map<string, WargamesSeatBinding>();
  const wargamesSessionIds = new Set<string>();
  const watchersByMatchId = new Map<string, Set<string>>();
  let eloByModel: ModelEloRow[] = [];

  function enqueueMatch<Result>(live: LiveMatch, task: () => Promise<Result>): Promise<Result> {
    const run = live.serialQueue.then(task, task);
    live.serialQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function load(): Promise<void> {
    const summaries = await store.load();
    for (const summary of summaries) {
      if (summary.status === 'finished' || summary.status === 'aborted') continue;
      await store.saveSummary({ ...summary, status: 'aborted', finishedAtMs: summary.finishedAtMs ?? now() });
    }
    eloByModel = computeEloFromSummaries(store.listSummaries());
  }

  function statusFrame(): { type: 'wargames-status'; matches: WargamesMatchSummary[] } {
    return { type: 'wargames-status', matches: store.listSummaries() };
  }

  function historyFrame(): { type: 'wargames-history'; history: WargamesHistory } {
    return {
      type: 'wargames-history',
      history: {
        eloByModel,
        matches: store.listSummaries(),
      },
    };
  }

  function phaseClockOf(live: LiveMatch | undefined): WargamesPhaseClock | null {
    if (!live?.phaseDeadline) return null;
    return {
      remainingMs: Math.max(0, live.phaseDeadline.deadlineAtMs - now()),
      lengthMs: live.phaseDeadline.lengthMs,
    };
  }

  function everySeatDone(live: LiveMatch): boolean {
    return matchSeatIds(live.state).every((id) => {
      const seat = live.state.seats[seatIndexOf(id)];
      return live.state.readySeatIds.includes(id) || seat.status === 'submitted' || seat.status === 'eliminated' || seat.status === 'timedOut';
    });
  }

  function clearDeadline(live: LiveMatch): void {
    live.phaseDeadline = null;
    if (!live.deadlineTimer) return;
    clearTimeoutFn(live.deadlineTimer);
    live.deadlineTimer = null;
  }

  function schedulePhaseDeadline(live: LiveMatch): void {
    clearDeadline(live);
    if (live.state.status !== 'running') return;
    const expectedTick = live.state.tick;
    const expectedPhase: TickPhase = live.state.phase;
    const phaseMs = Math.max(1000, Math.floor((live.state.spec.tickDeadlineSeconds * 1000) / TIMED_PHASES_PER_TICK));
    live.phaseDeadline = { deadlineAtMs: now() + phaseMs, lengthMs: phaseMs };
    if (hasWatchers(live.state.matchId)) {
      broadcast({ type: 'wargames-events', matchId: live.state.matchId, events: [], reset: false, phaseClock: phaseClockOf(live) });
    }
    live.deadlineTimer = setTimeoutFn(() => {
      live.deadlineTimer = null;
      void enqueueMatch(live, async () => {
        if (live.state.status !== 'running') return;
        if (live.state.tick !== expectedTick || live.state.phase !== expectedPhase) return;
        await advancePhaseSerialized(live, 'deadline');
      });
    }, phaseMs);
    unrefTimer(live.deadlineTimer);
  }

  function hasWatchers(matchId: string): boolean {
    const set = watchersByMatchId.get(matchId);
    return set !== undefined && set.size > 0;
  }

  async function commitEventSerialized(
    live: LiveMatch,
    rawEvent: WargamesEvent,
  ): Promise<{ ok: true; state: MatchState; event: WargamesEvent } | { ok: false; rejection: WargamesRejection }> {
    const outcome = applyEvent(live.state, rawEvent);
    if (!outcome.ok) return outcome;
    await store.appendEvent(live.state.matchId, rawEvent);
    live.state = outcome.state;
    live.eventCount += 1;
    const finishedAtMs = live.state.status === 'finished' || live.state.status === 'aborted' ? now() : null;
    const summary = summarizeMatch(live.state, finishedAtMs, live.eventCount);
    await store.saveSummary(summary);
    if (hasWatchers(live.state.matchId)) {
      broadcast({ type: 'wargames-events', matchId: live.state.matchId, events: [rawEvent], reset: false, phaseClock: phaseClockOf(live) });
    }
    if (live.state.status === 'finished') {
      clearDeadline(live);
      eloByModel = computeEloFromSummaries(store.listSummaries());
      liveByMatchId.delete(live.state.matchId);
      wakePhaseWaiters(live);
      live.hooks?.onMatchEnded?.(live.state.matchId, [...live.sessionIds]);
      broadcast(historyFrame());
    }
    if (live.state.status === 'aborted') {
      clearDeadline(live);
      liveByMatchId.delete(live.state.matchId);
      wakePhaseWaiters(live);
      live.hooks?.onMatchEnded?.(live.state.matchId, [...live.sessionIds]);
    }
    broadcast(statusFrame());
    return { ok: true, state: live.state, event: rawEvent };
  }

  function isMatchTerminal(live: LiveMatch): boolean {
    return live.state.status === 'aborted' || live.state.status === 'finished';
  }

  function activeSeatSessions(live: LiveMatch): SeatSession[] {
    return live.sessionIds.flatMap((sessionId) => {
      const binding = seatBySessionId.get(sessionId);
      if (!binding || live.state.seats[seatIndexOf(binding.seatId)].status === 'eliminated') return [];
      return [{ sessionId, seatId: binding.seatId }];
    });
  }

  function wakePhaseWaiters(live: LiveMatch): void {
    live.wokenSeatIds.clear();
    const waiters = [...live.phaseWaiters.keys()];
    live.phaseWaiters.clear();
    for (const notify of waiters) notify();
  }

  function wakeSeatWaiters(live: LiveMatch, seatId: SeatId): void {
    for (const [notify, waitingSeatId] of [...live.phaseWaiters]) {
      if (waitingSeatId === seatId) notify();
    }
  }

  function unseenTalkMessagesOf(live: LiveMatch, seatId: SeatId): MessageRecord[] {
    if (live.state.phase !== 'talk') return [];
    const seenCount = live.seenMessageCountBySeat.get(seatId) ?? 0;
    return live.state.messages.slice(seenCount).filter((message) => message.tick === live.state.tick
      && message.from !== seatId
      && (message.channel === 'public' || message.to === seatId));
  }

  function markMessagesSeen(live: LiveMatch, seatId: SeatId): void {
    live.seenMessageCountBySeat.set(seatId, live.state.messages.length);
    live.wokenSeatIds.delete(seatId);
  }

  function takeNewMessages(live: LiveMatch, seatId: SeatId): MessageRecord[] {
    const newMessages = unseenTalkMessagesOf(live, seatId);
    markMessagesSeen(live, seatId);
    return newMessages;
  }

  function wakeSeats(live: LiveMatch, wokenSeatIds: readonly SeatId[]): void {
    if (wokenSeatIds.length === 0) return;
    const waitingSeatIds = new Set(live.phaseWaiters.values());
    for (const seatId of wokenSeatIds) {
      live.wokenSeatIds.add(seatId);
      wakeSeatWaiters(live, seatId);
    }
    const wokenSeats = activeSeatSessions(live)
      .filter((seatSession) => wokenSeatIds.includes(seatSession.seatId) && !waitingSeatIds.has(seatSession.seatId))
      .map((seatSession) => ({ ...seatSession, messages: unseenTalkMessagesOf(live, seatSession.seatId) }));
    const nudgedSeatIds = live.hooks?.onSeatsWoken?.(live.state, wokenSeats) ?? [];
    for (const seatId of nudgedSeatIds) markMessagesSeen(live, seatId);
  }

  async function advancePhaseSerialized(live: LiveMatch, reason: 'all_submitted' | 'deadline'): Promise<void> {
    clearDeadline(live);
    if (live.state.status !== 'running') return;
    const stepped = await commitEventSerialized(live, {
      seq: live.state.lastSeq + 1,
      type: 'phase_advanced',
      reason,
    });
    if (!stepped.ok) return;
    if (live.state.status !== 'running') return;
    if (live.state.phase === 'reported') {
      await commitEventSerialized(live, {
        seq: live.state.lastSeq + 1,
        type: 'phase_advanced',
        reason: 'all_submitted',
      });
      live.tickToolCounts.clear();
    }
    wakePhaseWaiters(live);
    if (live.state.status === 'running') {
      schedulePhaseDeadline(live);
      live.hooks?.onPhaseChanged?.(live.state, activeSeatSessions(live));
    }
  }

  async function startMatch(
    spec: WargamesMatchSpec,
    launchSeat?: SeatLaunchFn,
    hooks?: WargamesMatchHooks,
  ): Promise<{ ok: true; matchId: string; error: string | null } | { ok: false; error: string }> {
    const createdAtMs = now();
    const catalog = readAgentModels();
    const pinnedSpec: WargamesMatchSpec = {
      ...spec,
      seats: spec.seats.map((seat) => ({
        ...seat,
        modelDisplay: resolveSeatModelDisplay(seat, catalog),
      })),
    };
    const matchId = `wg-${createdAtMs.toString(36)}-${randomBytes(3).toString('hex')}`;
    const initialState = createInitialMatchState(matchId, createdAtMs, pinnedSpec);
    const live: LiveMatch = {
      state: initialState,
      eventCount: 1,
      deadlineTimer: null,
      phaseDeadline: null,
      sessionIds: [],
      serialQueue: Promise.resolve(),
      tickToolCounts: new Map(),
      phaseWaiters: new Map(),
      wokenSeatIds: new Set(),
      seenMessageCountBySeat: new Map(),
      hooks,
    };
    liveByMatchId.set(matchId, live);
    const createdEvent: WargamesEvent = { seq: 0, type: 'match_created', matchId, createdAtMs, spec: pinnedSpec };
    await store.appendEvent(matchId, createdEvent);
    await store.saveSummary(summarizeMatch(initialState, null, 1));
    await enqueueMatch(live, () => commitEventSerialized(live, { seq: 1, type: 'seating_started' }));
    if (launchSeat) {
      const launchErrors: string[] = [];
      for (const seat of pinnedSpec.seats) {
        if (isMatchTerminal(live)) {
          return { ok: false, error: live.state.abortReason ?? 'Match aborted during launch' };
        }
        let boundSessionId: string | null = null;
        const bindSession = (sessionId: string) => {
          boundSessionId = sessionId;
          live.sessionIds.push(sessionId);
          wargamesSessionIds.add(sessionId);
          seatBySessionId.set(sessionId, { matchId, seatId: seat.seatId });
        };
        const launched = await launchSeat(matchId, seat, bindSession);
        if (isMatchTerminal(live)) {
          const lateSessionId = launched.ok ? launched.sessionId : boundSessionId;
          if (lateSessionId) live.hooks?.onMatchEnded?.(matchId, [lateSessionId]);
          return { ok: false, error: live.state.abortReason ?? 'Match aborted during launch' };
        }
        if (!launched.ok) {
          launchErrors.push(`${seat.seatId}: ${launched.error}`);
          continue;
        }
        if (!seatBySessionId.has(launched.sessionId)) bindSession(launched.sessionId);
      }
      if (launchErrors.length > 0) {
        const reason = `Seat launch failed: ${launchErrors.join('; ')}`;
        await abortMatch(matchId, reason);
        return { ok: false, error: reason };
      }
    }
    log.log(`[wargames] started match ${matchId} (${spec.title})`);
    return { ok: true, matchId, error: null };
  }

  async function abortMatch(matchId: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const live = liveByMatchId.get(matchId);
    if (!live) return { ok: false, error: `Match ${matchId} is not active` };
    return enqueueMatch(live, async () => {
      const committed = await commitEventSerialized(live, {
        seq: live.state.lastSeq + 1,
        type: 'match_aborted',
        reason: reason || 'Aborted by operator',
      });
      if (!committed.ok) return { ok: false, error: committed.rejection.message };
      return { ok: true };
    });
  }

  function seatSessionEnded(sessionId: string, reason: string): void {
    const binding = seatBySessionId.get(sessionId);
    const live = binding ? liveByMatchId.get(binding.matchId) : undefined;
    if (!binding || !live) return;
    void enqueueMatch(live, async () => {
      if (live.state.status !== 'seating') return;
      if (live.state.seats[seatIndexOf(binding.seatId)].status !== 'disconnected') return;
      await commitEventSerialized(live, {
        seq: live.state.lastSeq + 1,
        type: 'match_aborted',
        reason: `Seat ${binding.seatId} could not start: ${reason}`.slice(0, 400),
      });
    });
  }

  async function watchMatch(matchId: string, watcherId: string): Promise<{ ok: true; events: WargamesEvent[]; phaseClock: WargamesPhaseClock | null } | { ok: false; error: string }> {
    const events = await store.readEvents(matchId);
    if (events.length === 0) return { ok: false, error: `No log found for match ${matchId}` };
    const watchers = watchersByMatchId.get(matchId) ?? new Set<string>();
    watchers.add(watcherId);
    watchersByMatchId.set(matchId, watchers);
    return { ok: true, events, phaseClock: phaseClockOf(liveByMatchId.get(matchId)) };
  }

  function unwatchMatch(matchId: string, watcherId: string): void {
    const watchers = watchersByMatchId.get(matchId);
    if (!watchers) return;
    watchers.delete(watcherId);
    if (watchers.size === 0) watchersByMatchId.delete(matchId);
  }

  function removeWatcher(watcherId: string): void {
    for (const [matchId, watchers] of watchersByMatchId) {
      watchers.delete(watcherId);
      if (watchers.size === 0) watchersByMatchId.delete(matchId);
    }
  }

  function seatForSession(sessionId: string): WargamesSeatBinding | null {
    return seatBySessionId.get(sessionId) ?? null;
  }

  function isWargamesSession(sessionId: string): boolean {
    return wargamesSessionIds.has(sessionId);
  }

  async function ensureSeatConnectedSerialized(live: LiveMatch, seatId: SeatId): Promise<void> {
    const seat = live.state.seats[seatIndexOf(seatId)];
    if (seat.status !== 'disconnected') return;
    const wasSeating = live.state.status === 'seating';
    await commitEventSerialized(live, { seq: live.state.lastSeq + 1, type: 'seat_connected', seatId });
    if (wasSeating && live.state.status === 'running') {
      wakePhaseWaiters(live);
      schedulePhaseDeadline(live);
      live.hooks?.onPhaseChanged?.(live.state, activeSeatSessions(live));
    }
  }

  function waitForPhaseChange(live: LiveMatch, seatId: SeatId): Promise<void> {
    const phaseMs = Math.max(1000, Math.floor((live.state.spec.tickDeadlineSeconds * 1000) / TIMED_PHASES_PER_TICK));
    const waitMs = Math.min(phaseMs, MAX_WAIT_FOR_CHANGE_MS);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeoutFn(timer);
        live.phaseWaiters.delete(done);
        resolve();
      };
      const timer = setTimeoutFn(done, waitMs);
      unrefTimer(timer);
      live.phaseWaiters.set(done, seatId);
    });
  }

  function takeTickQuota(live: LiveMatch, seatId: SeatId, tool: string, limit: number): boolean {
    const key = `${live.state.tick}:${seatId}:${tool}`;
    const used = live.tickToolCounts.get(key) ?? 0;
    if (used >= limit) return false;
    live.tickToolCounts.set(key, used + 1);
    return true;
  }

  async function callTool(
    matchId: string,
    seatId: SeatId,
    toolName: WargamesToolName,
    args: Record<string, unknown>,
  ): Promise<WargamesToolReply> {
    const live = liveByMatchId.get(matchId);
    if (!live) return rejectionReply('invalid_match_state', `match ${matchId} is not live`);
    if (toolName === 'get_state') {
      const readyFlag = args.ready === true;
      const waitFlag = args.wait_for_change === true;
      const before = await enqueueMatch(live, async () => {
        if (live.state.status === 'finished' || live.state.status === 'aborted') {
          return { ended: true as const, status: live.state.status, tick: live.state.tick, phase: live.state.phase, changed: true };
        }
        const startTick = live.state.tick;
        const startPhase = live.state.phase;
        const startStatus = live.state.status;
        await ensureSeatConnectedSerialized(live, seatId);
        if (live.wokenSeatIds.has(seatId)) {
          return { ended: false as const, status: live.state.status, tick: live.state.tick, phase: live.state.phase, changed: true };
        }
        const canReady = live.state.status === 'running'
          && live.state.phase === 'talk'
          && live.state.seats[seatIndexOf(seatId)].status === 'acting'
          && !live.state.readySeatIds.includes(seatId);
        if (readyFlag && canReady) {
          await commitEventSerialized(live, { seq: live.state.lastSeq + 1, type: 'seat_ready', seatId });
          if (everySeatDone(live)) await advancePhaseSerialized(live, 'all_submitted');
        }
        const changed = live.state.tick !== startTick || live.state.phase !== startPhase || live.state.status !== startStatus;
        return { ended: false as const, status: live.state.status, tick: live.state.tick, phase: live.state.phase, changed };
      });
      if (before.ended) return rejectionReply('invalid_match_state', `match ${matchId} is ${before.status}`);
      if (waitFlag && !before.changed && liveByMatchId.has(matchId)) {
        await waitForPhaseChange(live, seatId);
      }
      return { ok: true, payload: { state: projectSeatState(live.state, seatId), newMessages: takeNewMessages(live, seatId) } };
    }
    return enqueueMatch(live, async () => {
      if (live.state.status === 'finished' || live.state.status === 'aborted') {
        return rejectionReply('invalid_match_state', `match ${matchId} is ${live.state.status}`);
      }
      await ensureSeatConnectedSerialized(live, seatId);
      if (toolName === 'get_reports') {
        const sinceTick = typeof args.since_tick === 'number' ? args.since_tick : 0;
        const reports = live.state.reportsBySeat[seatId].filter((report) => report.tick >= sinceTick);
        return { ok: true, payload: { reports } };
      }
      if (toolName === 'read_messages') {
        const sinceTick = typeof args.since_tick === 'number' ? args.since_tick : 0;
        const messages = live.state.messages.filter((message) => {
          if (message.tick < sinceTick) return false;
          if (message.channel === 'public') return true;
          return message.from === seatId || message.to === seatId;
        });
        markMessagesSeen(live, seatId);
        return { ok: true, payload: { messages } };
      }
      if (toolName === 'read_notes') {
        return { ok: true, payload: { text: live.state.seats[seatIndexOf(seatId)].note } };
      }
      if (toolName === 'write_note') {
        if (!takeTickQuota(live, seatId, 'write_note', MAX_NOTE_WRITES_PER_TICK)) {
          return rejectionReply('message_limit_exceeded', `at most ${MAX_NOTE_WRITES_PER_TICK} note writes per tick`);
        }
        const text = typeof args.text === 'string' ? args.text : '';
        const committed = await commitEventSerialized(live, { seq: live.state.lastSeq + 1, type: 'note_written', seatId, text });
        if (!committed.ok) return committed;
        return { ok: true, payload: { savedBytes: Buffer.byteLength(text, 'utf8') } };
      }
      if (toolName === 'send_message') {
        const channel = MessageChannel.safeParse(args.channel ?? 'dm');
        const to = args.to === null || args.to === undefined ? null : SeatId.safeParse(args.to);
        if (!channel.success || (to !== null && !to.success) || typeof args.text !== 'string') {
          return rejectionReply('invalid_order', 'invalid message arguments');
        }
        const readyBefore = [...live.state.readySeatIds];
        const committed = await commitEventSerialized(live, {
          seq: live.state.lastSeq + 1,
          type: 'message_sent',
          seatId,
          channel: channel.data,
          to: to ? to.data : null,
          text: args.text,
        });
        if (!committed.ok) return committed;
        wakeSeats(live, readyBefore.filter((readySeatId) => !live.state.readySeatIds.includes(readySeatId)));
        return { ok: true, payload: { sent: true } };
      }
      if (toolName === 'submit_orders') {
        const parsedOrders = OrderItem.array().max(64).safeParse(args.orders);
        if (!parsedOrders.success) return rejectionReply('invalid_order', 'invalid orders payload');
        const committed = await commitEventSerialized(live, {
          seq: live.state.lastSeq + 1,
          type: 'orders_submitted',
          seatId,
          orders: parsedOrders.data,
        });
        if (!committed.ok) return committed;
        if (everySeatDone(live)) await advancePhaseSerialized(live, 'all_submitted');
        return { ok: true, payload: { submitted: true, tick: live.state.tick, phase: live.state.phase } };
      }
      return rejectionReply('invalid_order', `unknown tool ${toolName}`);
    });
  }

  function dispose(): void {
    for (const live of liveByMatchId.values()) {
      clearDeadline(live);
      wakePhaseWaiters(live);
    }
    liveByMatchId.clear();
    watchersByMatchId.clear();
  }

  return {
    load,
    startMatch,
    abortMatch,
    seatSessionEnded,
    watchMatch,
    unwatchMatch,
    removeWatcher,
    seatForSession,
    isWargamesSession,
    callTool,
    statusFrame,
    historyFrame,
    dispose,
  };
}
