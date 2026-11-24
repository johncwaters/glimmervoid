import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickOutcome } from '../lanes/lane-runner.ts';
import * as core from './core/community-core.ts';
import type { CommunityAction, CommunityItem, CommunitySource, CommunitySourceView, CommunityState, CommunityStateEntry } from '../../shared/contracts/community.ts';
import { errorMessage } from '../../shared/text.ts';
import { clock } from '../../shared/clock.ts';

type SourceFetch = { ok: true; items: CommunityItem[]; printedTimes: string[] } | { ok: false; error: string; isRateLimited?: boolean; retryAfterMs?: number | undefined };
type SourceFailure = { error: string; isRateLimited: boolean; retryAfterMs?: number | undefined };

const MAX_RATE_LIMIT_WAIT_MS = 60 * 60000;

function sourceFailure(fetched: { error: string; isRateLimited?: boolean; retryAfterMs?: number | undefined }): SourceFailure {
  return { error: fetched.error, isRateLimited: fetched.isRateLimited === true, retryAfterMs: fetched.retryAfterMs };
}

interface PollSource {
  id: CommunitySource;
  productName: string;
  isJudged: boolean;
  waitingFor: () => Promise<string[]>;
  fetch: (sinceIso: string) => Promise<SourceFetch>;
}

interface CommunityPollerDependencies {
  intervalMinutes: number;
  sources: () => readonly PollSource[];
  judgeQuestions?: ((candidates: readonly CommunityItem[], productName: string) => Promise<Set<string> | null>) | null;
  readState: () => Promise<CommunityState>;
  writeState: (state: CommunityState) => Promise<void>;
  runItem?: (entry: CommunityStateEntry, signal: AbortSignal) => Promise<core.CommunityRunResult>;
  maxConcurrentRuns?: number;
  onTickComplete?: (summary: Record<string, unknown>) => void;
  onDraftReady?: (entry: CommunityStateEntry) => void;
  sourceViews?: (errorBySource: ReadonlyMap<string, string>, waitingBySource: ReadonlyMap<string, string[]>) => CommunitySourceView[];
  firstTickDelayMs?: () => number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

interface CommunityPoller {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  pollSoon(): void;
  state(): CommunityState;
  applyAction(key: string, action: CommunityAction): Promise<{ ok: true } | { ok: false; error: string }>;
}

function createCommunityPoller({
  intervalMinutes, sources, judgeQuestions = null, readState, writeState, runItem, maxConcurrentRuns = core.MAX_CONCURRENT_RUNS,
  onTickComplete = () => {}, onDraftReady = () => {}, sourceViews = () => [], firstTickDelayMs, now = clock.nowMs, log = console,
}: CommunityPollerDependencies): CommunityPoller {
  let state: CommunityState = core.emptyCommunityState();
  const errorBySource = new Map<string, string>();
  const waitingBySource = new Map<string, string[]>();
  let fullPageCount = 0;
  const runAborts = new Map<string, AbortController>();

  const intervalMs = intervalMinutes * 60000;
  const loop = createTickLoop({
    tag: core.COMMUNITY_LANE_ID,
    intervalMs,
    minFailureWaitMs: intervalMs,
    backoffMaxMs: Math.max(MAX_RATE_LIMIT_WAIT_MS, intervalMs),
    tick: () => runTick(),
    writeState: () => writeState(state),
    firstTickDelayMs,
    now,
    log,
  });

  function publishStatus(error: string | null): void {
    onTickComplete({ type: 'community-status', ts: now(), intervalMinutes, error, entries: Object.values(state.entries), sources: sourceViews(errorBySource, waitingBySource) });
  }

  async function pollSource(source: PollSource): Promise<SourceFailure | null> {
    const watermark = state.watermarks[source.id] ?? null;
    const nowIso = new Date(now()).toISOString();
    if (watermark === null) {
      state = core.admitSourceItems(state, source.id, [], nowIso).state;
      return null;
    }
    const fetched = await source.fetch(watermark);
    if (!fetched.ok) return sourceFailure(fetched);
    const printedSinceWatermark = fetched.printedTimes.filter((printedAt) => Date.parse(printedAt) > Date.parse(watermark));
    if (printedSinceWatermark.length >= core.SOURCE_ROW_LIMIT) fullPageCount += 1;
    const newestPrintedAt = printedSinceWatermark.reduce<string | null>((newest, printedAt) => (newest === null || Date.parse(printedAt) > Date.parse(newest) ? printedAt : newest), null);
    const candidates = core.freshItems(state, source.id, fetched.items);
    const questionKeys = source.isJudged && candidates.length > 0 ? await (judgeQuestions?.(candidates, source.productName) ?? Promise.resolve(null)).catch(() => null) : new Set(candidates.map((item) => item.key));
    if (questionKeys === null) return { error: `The question judge gave no usable answer for ${source.id}; these messages are checked again next poll`, isRateLimited: false };
    state = core.withWatermarkAtLeast(core.admitSourceItems(state, source.id, fetched.items, nowIso, (key) => questionKeys.has(key)).state, source.id, newestPrintedAt);
    return null;
  }

  async function pollEverySource(): Promise<SourceFailure[]> {
    const failures: SourceFailure[] = [];
    errorBySource.clear();
    waitingBySource.clear();
    for (const source of sources()) {
      const waitingFor = await source.waitingFor();
      if (waitingFor.length > 0) {
        waitingBySource.set(source.id, waitingFor);
        continue;
      }
      const failure = await pollSource(source).catch((error: unknown): SourceFailure => ({ error: errorMessage(error), isRateLimited: false }));
      if (failure === null) continue;
      errorBySource.set(source.id, failure.error);
      failures.push(failure);
    }
    return failures;
  }

  function replaceEntry(entry: CommunityStateEntry): void {
    state = { ...state, entries: { ...state.entries, [entry.item.key]: entry } };
  }

  async function finishRun(key: string, run: core.CommunityRunResult): Promise<void> {
    runAborts.delete(key);
    const entry = state.entries[key];
    if (loop.isStopped() || !entry) return;
    const finished = core.entryFromRun(entry, run, new Date(now()).toISOString());
    if (!finished) {
      dispatchRuns();
      return;
    }
    if (finished.warning) log.warn(`[${core.COMMUNITY_LANE_ID}] ${finished.warning}`);
    replaceEntry(finished.entry);
    if (core.shouldNotifyDraft(finished.entry)) onDraftReady(finished.entry);
    dispatchRuns();
    await loop.persist();
    publishStatus(null);
  }

  function startRun(key: string): void {
    const entry = state.entries[key];
    if (!runItem || !entry) return;
    const running = core.markRunning(entry);
    replaceEntry(running);
    const controller = new AbortController();
    runAborts.set(key, controller);
    const failed = (error: unknown): core.CommunityRunResult => ({ report: null, posting: null, error: errorMessage(error) || 'the research run failed' });
    void loop.track(runItem(running, controller.signal).catch(failed).then((run) => finishRun(key, run)));
  }

  function dispatchRuns(): void {
    if (!runItem || loop.isStopped()) return;
    for (const key of core.selectRuns(state, maxConcurrentRuns - runAborts.size)) startRun(key);
  }

  function pollSoon(): void {
    loop.tickSoon();
  }

  async function runTick(): Promise<TickOutcome> {
    fullPageCount = 0;
    const failures = await pollEverySource();
    const polledCount = sources().length - waitingBySource.size;
    const pollError = failures.length > 0 && failures.length === polledCount ? (failures[0]?.error ?? null) : null;
    const retryAfterWaits = failures.map((failure) => failure.retryAfterMs).filter((waitMs) => waitMs !== undefined);
    const longestRetryAfterMs = retryAfterWaits.length > 0 ? Math.max(...retryAfterWaits) : undefined;
    state = core.prunedState(state, now());
    dispatchRuns();
    await loop.persist();
    publishStatus(pollError);
    if (!pollError && fullPageCount > 0) pollSoon();
    if (pollError && longestRetryAfterMs !== undefined) return { failed: true, error: pollError, retryAfterMs: longestRetryAfterMs };
    if (pollError) return { failed: true, error: pollError };
    return {};
  }

  async function applyAction(key: string, action: CommunityAction): Promise<{ ok: true } | { ok: false; error: string }> {
    if (loop.isStopped()) return { ok: false, error: 'The community lane is not running' };
    const entry = state.entries[key];
    if (!entry) return { ok: false, error: 'That question is no longer tracked' };
    if (action === 'rerun' && runAborts.has(key)) return { ok: false, error: 'The last research run for this question is still stopping' };
    const applied = core.applyCommunityAction(entry, action);
    if (!applied.ok) return applied;
    if (action === 'set-aside') runAborts.get(key)?.abort();
    replaceEntry(applied.entry);
    dispatchRuns();
    const isSaved = await loop.save();
    publishStatus(null);
    if (!isSaved) return { ok: false, error: 'The change applies now but could not be saved, so a restart would undo it' };
    return { ok: true };
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      state = core.requeueInterruptedRuns(await readState());
      publishStatus(null);
    });
  }

  async function stop(): Promise<void> {
    const stopping = loop.stop();
    for (const controller of runAborts.values()) controller.abort();
    await stopping;
  }

  return { start, stop, tick: loop.tick, pollSoon, state: () => state, applyAction };
}

export { createCommunityPoller };
export type { PollSource, SourceFetch };
