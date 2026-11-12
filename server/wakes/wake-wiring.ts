import type { Session } from '../../session/sessions.ts';
import { WakeStoreFile } from '../../shared/contracts/wakes.ts';
import type { AgentWakeRequest, Wake, WakeKind, WakeView } from '../../shared/contracts/wakes.ts';
import { clock } from '../../shared/clock.ts';
import { STATES } from '../../shared/states.ts';
import { unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../../shared/timer-deps.ts';
import { createJsonStateStore } from '../json-file.ts';
import { admitWake, afterFire, afterSkipped, decideDueWake, describeWakeFailedNote, describeWakeLine, parseWakeWhen, viewOfWake, DEFAULT_WAKE_LIMITS, SELF_WAKE_CAP_NOTE, WAKE_RECHECK_MS } from '../core/wake-core.ts';
import type { WakeFailureCause, WakeLimits } from '../core/wake-core.ts';
import type { AgentRefusalReply, AgentReplyOf } from '../core/agent-api-core.ts';
import type { ChildChannels } from '../agent-api/child-channels.ts';

interface WakeSpawnGate {
  run: (task: () => unknown, options?: { isStillWanted?: () => boolean }) => Promise<unknown>;
}

type ResumeOutcome = 'started' | 'start-failed' | 'not-wanted';

type WakeBudget = Pick<ChildChannels, 'watchOperatorInput' | 'operatorWakeFactsOf' | 'flagWakeCap' | 'isWakeLineInFlight' | 'submitWakeLine'>;

interface WakeWiringOptions {
  filePath: string | null;
  findLiveSession(sessionId: string): Session | null;
  budget: WakeBudget;
  limits?: WakeLimits;
  spawnGate?: WakeSpawnGate | null;
  onSessionWakesChange?: (sessionId: string, wakes: WakeView[]) => void;
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

function createWakeWiring({ filePath, findLiveSession, budget, limits = DEFAULT_WAKE_LIMITS, spawnGate = null, onSessionWakesChange = () => {}, setTimeoutFn, clearTimeoutFn, now, logger }: WakeWiringOptions) {
  let wakes: Wake[] = [];
  let lastWakeNumber = 0;
  let timer: TimerHandle | null = null;
  let isLoaded = false;
  const recheckAtById = new Map<string, number>();
  const resumingWakeIds = new Set<string>();
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
      for (const sessionId of sessionIdsWithPendingWakes()) announce(sessionId);
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

  function pendingViewsOf(sessionId: string): WakeView[] {
    const nowMs = now();
    return pendingWakesOf(sessionId).sort((left, right) => left.nextFireAt - right.nextFireAt).map((wake) => viewOfWake(wake, nowMs, FIRE_TIME_FORMAT));
  }

  function sessionIdsWithPendingWakes(): Set<string> {
    return new Set(wakes.filter((wake) => wake.status === 'pending').map((wake) => wake.sessionId));
  }

  function announce(sessionId: string): void {
    onSessionWakesChange(sessionId, pendingViewsOf(sessionId));
  }

  function pendingWakesBySession(): { sessionId: string; wakes: WakeView[] }[] {
    return [...sessionIdsWithPendingWakes()].map((sessionId) => ({ sessionId, wakes: pendingViewsOf(sessionId) }));
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
    const dueTimes = wakes.filter((wake) => wake.status === 'pending' && !resumingWakeIds.has(wake.id)).map((wake) => Math.max(wake.nextFireAt, recheckAtById.get(wake.id) ?? 0));
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

  function pendingWakeById(wakeId: string): Wake | undefined {
    return wakes.find((stored) => stored.id === wakeId && stored.status === 'pending');
  }

  function settleWake(wake: Wake, settled: Wake): void {
    recheckAtById.delete(wake.id);
    replaceWake(settled);
    void persistUntilWritten();
    announce(wake.sessionId);
  }

  function settleDelivery(wakeId: string, isSubmitted: boolean): void {
    const wake = pendingWakeById(wakeId);
    if (wake) settleWake(wake, isSubmitted ? afterFire(wake, now(), limits) : afterSkipped(wake, 'failed', now(), limits));
    evaluateSoon();
  }

  function failWake(wake: Wake, session: Session, cause: WakeFailureCause): void {
    settleWake(wake, afterSkipped(wake, 'failed', now(), limits));
    session.raiseAttention('wake-failed', describeWakeFailedNote(wake, cause));
  }

  async function startDormantSession(wake: Wake, session: Session, isStillWanted: () => boolean): Promise<ResumeOutcome> {
    if (!isStillWanted()) return 'not-wanted';
    await session.start({ resumePrompt: describeWakeLine(wake, FIRE_TIME_FORMAT.hourMinuteOf) });
    return session.state === STATES.DORMANT || session.state === STATES.FAILED ? 'start-failed' : 'started';
  }

  async function runResume(wake: Wake, session: Session): Promise<ResumeOutcome> {
    const isStillWanted = () => !session._destroyed && session.state === STATES.DORMANT && pendingWakeById(wake.id) !== undefined && now() - wake.nextFireAt <= limits.missedGraceMs;
    const startTask = () => startDormantSession(wake, session, isStillWanted);
    try {
      const outcome = await (spawnGate ? spawnGate.run(startTask, { isStillWanted }) : startTask());
      return outcome === 'started' || outcome === 'start-failed' ? outcome : 'not-wanted';
    } catch (error) {
      logger.warn(`[wakes] resuming ${session.id} for wake ${wake.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return 'start-failed';
    }
  }

  async function resumeWithLine(wake: Wake, session: Session): Promise<void> {
    resumingWakeIds.add(wake.id);
    const outcome = await runResume(wake, session);
    resumingWakeIds.delete(wake.id);
    const stillPending = pendingWakeById(wake.id);
    if (outcome === 'started' && stillPending) {
      settleDelivery(wake.id, true);
      return;
    }
    if (outcome === 'start-failed' && stillPending) failWake(stillPending, session, 'start-failed');
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
    const decision = decideDueWake(wake, {
      nowMs, sessionState: session.state, hasConversationId: Boolean(session._resumeSessionId), isDelivering: budget.isWakeLineInFlight(session), ...budget.operatorWakeFactsOf(session),
    }, limits);
    switch (decision.kind) {
      case 'wait':
        recheckAtById.set(wake.id, decision.untilMs);
        return;
      case 'flag-operator':
        budget.flagWakeCap(session, 'self-wake-cap', SELF_WAKE_CAP_NOTE);
        recheckAtById.set(wake.id, nowMs + WAKE_RECHECK_MS);
        return;
      case 'missed':
        settleWake(wake, afterSkipped(wake, 'missed', nowMs, limits));
        session.raiseAttention('wake-failed', describeWakeFailedNote(wake, 'missed'));
        return;
      case 'failed':
        failWake(wake, session, decision.cause);
        return;
      case 'resume-with-line':
        void resumeWithLine(wake, session);
        return;
      case 'type-line':
        deliver(wake, session, nowMs);
        return;
    }
  }

  function evaluate(): void {
    const nowMs = now();
    const dueWakes = wakes
      .filter((wake) => wake.status === 'pending' && !resumingWakeIds.has(wake.id) && wake.nextFireAt <= nowMs && (recheckAtById.get(wake.id) ?? 0) <= nowMs)
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
    announce(session.id);
    const view = viewOfWake(wake, setAt, FIRE_TIME_FORMAT);
    return { status: 200, body: { ok: true, wake: view, timezone, note: `wake ${wake.id} set: fires ${view.nextFire}, ${timezone}` } };
  }

  async function cancel(sessionId: string, wakeId: string): Promise<AgentReplyOf<'wake'>> {
    await store.load();
    const wake = pendingWakesOf(sessionId).find((pending) => pending.id === wakeId);
    if (!wake) return refusal(404, `this session has no pending wake ${wakeId}; glimmervoid wake list shows them`);
    replaceWake({ ...wake, status: 'cancelled' });
    if (!(await persist())) {
      wakes = [...wakes, wake];
      return refusal(503, `Glimmervoid could not save the change, so wake ${wakeId} is still set`);
    }
    recheckAtById.delete(wakeId);
    armTimer();
    announce(sessionId);
    return { status: 200, body: { ok: true, cancelled: wakeId } };
  }

  async function cancelForOperator(sessionId: string, wakeId: string): Promise<string | null> {
    const reply = await cancel(sessionId, wakeId);
    if (reply.body.ok) return null;
    announce(sessionId);
    return reply.body.error;
  }

  async function list(session: Session): Promise<AgentReplyOf<'wake'>> {
    await store.load();
    return { status: 200, body: { ok: true, wakes: pendingViewsOf(session.id), timezone: clock.timezone() } };
  }

  function handleAgent(session: Session, request: AgentWakeRequest): Promise<AgentReplyOf<'wake'>> {
    if (request.sub === 'list') return list(session);
    if (request.sub === 'cancel') return cancel(session.id, request.wake);
    return schedule(session, request.sub, request.when, request.text);
  }

  async function start(): Promise<void> {
    await store.load();
    armTimer();
    if (!isLoaded && filePath !== null) unrefTimer(setTimeoutFn(() => void start(), WAKE_RECHECK_MS));
  }

  return { cancelForOperator, handleAgent, pendingWakesBySession, start, watchSession };
}

type WakeWiring = ReturnType<typeof createWakeWiring>;

export { createWakeWiring };
export type { WakeWiring };
