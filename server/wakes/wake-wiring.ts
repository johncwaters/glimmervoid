import type { Session } from '../../session/sessions.ts';
import { WakeStoreFile } from '../../shared/contracts/wakes.ts';
import type { AgentWakeRequest, Wake, WakeKind } from '../../shared/contracts/wakes.ts';
import { clock } from '../../shared/clock.ts';
import { unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../../shared/timer-deps.ts';
import { createJsonStateStore } from '../json-file.ts';
import { admitWake, afterDelivery, decideDueWake, describeWakeLine, parseWakeWhen, viewOfWake, DEFAULT_WAKE_LIMITS, SELF_WAKE_CAP_NOTE, WAKE_RECHECK_MS } from '../core/wake-core.ts';
import type { WakeLimits } from '../core/wake-core.ts';
import type { AgentRefusalReply, AgentReplyOf } from '../core/agent-api-core.ts';
import type { ChildChannels } from '../agent-api/child-channels.ts';

type WakeBudget = Pick<ChildChannels, 'watchOperatorInput' | 'operatorWakeFactsOf' | 'flagWakeCap' | 'isWakeLineInFlight' | 'submitWakeLine'>;

interface WakeWiringOptions {
  filePath: string | null;
  findLiveSession(sessionId: string): Session | null;
  budget: WakeBudget;
  limits?: WakeLimits;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  now: () => number;
  logger: Pick<Console, 'warn'>;
}

interface SessionEnd {
  cause?: string;
}

const STORE_VERSION = 1;
const KEPT_STATUSES: ReadonlySet<Wake['status']> = new Set(['pending', 'missed', 'failed']);
const FIRE_TIME_FORMAT = { dayKeyOf: (ms: number) => clock.dayKeyOf(ms), hourMinuteOf: (ms: number) => clock.format(ms, 'hour-minute') };

function refusal(status: number, error: string): AgentRefusalReply {
  return { status, body: { ok: false, error } };
}

function createWakeWiring({ filePath, findLiveSession, budget, limits = DEFAULT_WAKE_LIMITS, setTimeoutFn, clearTimeoutFn, now, logger }: WakeWiringOptions) {
  let wakes: Wake[] = [];
  let lastWakeNumber = 0;
  let timer: TimerHandle | null = null;
  let isLoaded = false;
  const recheckAtById = new Map<string, number>();
  const watchedSessions = new WeakSet<Session>();

  const store = createJsonStateStore<WakeStoreFile>({
    name: 'wakes',
    filePath,
    parse: (raw) => WakeStoreFile.safeParse(raw).data ?? null,
    adopt: (loaded) => {
      wakes = loaded?.wakes ?? [];
      lastWakeNumber = loaded?.lastWakeNumber ?? 0;
      isLoaded = true;
      armTimer();
    },
    warn: (message, fields) => logger.warn(`[wakes] ${message} ${JSON.stringify(fields)}`),
  });

  async function persist(): Promise<boolean> {
    const file: WakeStoreFile = { version: STORE_VERSION, lastWakeNumber, wakes: wakes.filter((wake) => KEPT_STATUSES.has(wake.status)) };
    const isWritten = await store.write(file, () => `${JSON.stringify(file, null, 2)}\n`);
    return isWritten || filePath === null;
  }

  async function persistUntilWritten(): Promise<void> {
    if (await persist()) return;
    unrefTimer(setTimeoutFn(() => void persistUntilWritten(), WAKE_RECHECK_MS));
  }

  function pendingWakesOf(sessionId: string): Wake[] {
    return wakes.filter((wake) => wake.sessionId === sessionId && wake.status === 'pending');
  }

  function replaceWake(updated: Wake): void {
    wakes = wakes.flatMap((wake) => {
      if (wake.id !== updated.id) return [wake];
      return KEPT_STATUSES.has(updated.status) ? [updated] : [];
    });
  }

  function armTimer(): void {
    if (timer) clearTimeoutFn(timer);
    timer = null;
    const dueTimes = wakes.filter((wake) => wake.status === 'pending').map((wake) => Math.max(wake.nextFireAt, recheckAtById.get(wake.id) ?? 0));
    if (dueTimes.length === 0) return;
    timer = unrefTimer(setTimeoutFn(evaluate, Math.max(0, Math.min(...dueTimes) - now())));
  }

  function evaluateSoon(): void {
    unrefTimer(setTimeoutFn(evaluate, 0));
  }

  function cancelWakesOf(sessionId: string): void {
    const before = wakes.length;
    wakes = wakes.filter((wake) => wake.sessionId !== sessionId);
    if (wakes.length === before) return;
    void persistUntilWritten();
    armTimer();
  }

  function watchSession(session: Session): void {
    if (watchedSessions.has(session)) return;
    watchedSessions.add(session);
    budget.watchOperatorInput(session);
    session.on('state-change', evaluateSoon);
    session.once('teardown', ({ cause }: SessionEnd) => {
      if (cause === 'removed') cancelWakesOf(session.id);
    });
  }

  function settleDelivery(wakeId: string, isSubmitted: boolean): void {
    const wake = wakes.find((stored) => stored.id === wakeId && stored.status === 'pending');
    if (wake) {
      recheckAtById.delete(wakeId);
      replaceWake(afterDelivery(wake, isSubmitted, now(), limits));
      void persistUntilWritten();
    }
    evaluateSoon();
  }

  function deliver(wake: Wake, session: Session, nowMs: number): void {
    recheckAtById.set(wake.id, nowMs + WAKE_RECHECK_MS);
    budget.submitWakeLine(session, describeWakeLine(wake, FIRE_TIME_FORMAT.hourMinuteOf), (isSubmitted) => settleDelivery(wake.id, isSubmitted));
  }

  function evaluateWake(wake: Wake, nowMs: number): void {
    const session = findLiveSession(wake.sessionId);
    if (!session) {
      recheckAtById.set(wake.id, nowMs + WAKE_RECHECK_MS);
      return;
    }
    watchSession(session);
    const decision = decideDueWake(wake, { nowMs, sessionState: session.state, isDelivering: budget.isWakeLineInFlight(session), ...budget.operatorWakeFactsOf(session) });
    if (decision.kind === 'wait') {
      recheckAtById.set(wake.id, decision.untilMs);
      return;
    }
    if (decision.kind === 'flag-operator') {
      budget.flagWakeCap(session, 'self-wake-cap', SELF_WAKE_CAP_NOTE);
      recheckAtById.set(wake.id, nowMs + WAKE_RECHECK_MS);
      return;
    }
    deliver(wake, session, nowMs);
  }

  function evaluate(): void {
    const nowMs = now();
    const dueWakes = wakes
      .filter((wake) => wake.status === 'pending' && wake.nextFireAt <= nowMs && (recheckAtById.get(wake.id) ?? 0) <= nowMs)
      .sort((left, right) => left.nextFireAt - right.nextFireAt);
    for (const wake of dueWakes) evaluateWake(wake, nowMs);
    armTimer();
  }

  async function schedule(session: Session, kind: WakeKind, when: string, text: string): Promise<AgentReplyOf<'wake'>> {
    await store.load();
    const setAt = now();
    const timezone = clock.timezone();
    const parsed = parseWakeWhen(kind, when, setAt, timezone, limits);
    if (!parsed.ok) return refusal(400, parsed.reason);
    const candidate = { schedule: parsed.schedule, setAt, nextFireAt: parsed.nextFireAt };
    const admission = admitWake(pendingWakesOf(session.id), candidate, limits);
    if (!admission.ok) return refusal(409, admission.reason);
    const wake: Wake = { id: `w${lastWakeNumber + 1}`, sessionId: session.id, text, status: 'pending', ...candidate };
    lastWakeNumber += 1;
    wakes = [...wakes, wake];
    if (!(await persist())) {
      wakes = wakes.filter((stored) => stored.id !== wake.id);
      return refusal(503, 'Glimmervoid could not save the wake, so it is not set');
    }
    watchSession(session);
    armTimer();
    const view = viewOfWake(wake, setAt, FIRE_TIME_FORMAT);
    return { status: 200, body: { ok: true, wake: view, timezone, note: `wake ${wake.id} set: fires ${view.nextFire}, ${timezone}` } };
  }

  async function cancel(session: Session, wakeId: string): Promise<AgentReplyOf<'wake'>> {
    await store.load();
    const wake = pendingWakesOf(session.id).find((pending) => pending.id === wakeId);
    if (!wake) return refusal(404, `this session has no pending wake ${wakeId}; glimmervoid wake list shows them`);
    replaceWake({ ...wake, status: 'cancelled' });
    if (!(await persist())) {
      wakes = [...wakes, wake];
      return refusal(503, `Glimmervoid could not save the change, so wake ${wakeId} is still set`);
    }
    recheckAtById.delete(wakeId);
    armTimer();
    return { status: 200, body: { ok: true, cancelled: wakeId } };
  }

  async function list(session: Session): Promise<AgentReplyOf<'wake'>> {
    await store.load();
    const nowMs = now();
    const views = pendingWakesOf(session.id).sort((left, right) => left.nextFireAt - right.nextFireAt).map((wake) => viewOfWake(wake, nowMs, FIRE_TIME_FORMAT));
    return { status: 200, body: { ok: true, wakes: views, timezone: clock.timezone() } };
  }

  function handleAgent(session: Session, request: AgentWakeRequest): Promise<AgentReplyOf<'wake'>> {
    if (request.sub === 'list') return list(session);
    if (request.sub === 'cancel') return cancel(session, request.wake);
    return schedule(session, request.sub, request.when, request.text);
  }

  async function start(): Promise<void> {
    await store.load();
    armTimer();
    if (!isLoaded && filePath !== null) unrefTimer(setTimeoutFn(() => void start(), WAKE_RECHECK_MS));
  }

  return { handleAgent, start, watchSession };
}

type WakeWiring = ReturnType<typeof createWakeWiring>;

export { createWakeWiring };
export type { WakeWiring };
