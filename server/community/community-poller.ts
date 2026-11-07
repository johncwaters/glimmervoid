import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickOutcome } from '../lanes/lane-runner.ts';
import * as core from './core/community-core.ts';
import type { CommunityAction, CommunityItem, CommunityRowsPayload, CommunityState, CommunityStateEntry } from '../../shared/contracts/community.ts';
import { watcherFeedError } from '../lanes/core/watchee-feed-core.ts';
import { errorMessage } from '../../shared/text.ts';

const MAX_RATE_LIMIT_WAIT_MS = 60 * 60000;

interface CommunityPollerDependencies {
  intervalMinutes: number;
  discord?: DiscordSource | null;
  feedSilenceMs?: () => number;
  discordChannels?: readonly string[];
  readState: () => Promise<CommunityState>;
  writeState: (state: CommunityState) => Promise<void>;
  runItem?: (entry: CommunityStateEntry, signal: AbortSignal) => Promise<core.CommunityRunResult>;
  maxConcurrentRuns?: number;
  onTickComplete?: (summary: Record<string, unknown>) => void;
  onDraftReady?: (entry: CommunityStateEntry) => void;
  firstTickDelayMs?: () => number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

interface DiscordSource {
  judgeQuestions: (candidates: readonly CommunityItem[], replyFacts: ReadonlyMap<string, core.DiscordReplyFacts>) => Promise<Set<string> | null>;
}

interface CommunityPoller {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  state(): CommunityState;
  acceptRows(payload: CommunityRowsPayload): Promise<void>;
  applyAction(key: string, action: CommunityAction): Promise<{ ok: true } | { ok: false; error: string }>;
}

function createCommunityPoller({
  intervalMinutes, discordChannels = [], discord = null, feedSilenceMs = () => 0, readState, writeState, runItem, maxConcurrentRuns = core.MAX_CONCURRENT_RUNS,
  onTickComplete = () => {}, onDraftReady = () => {}, firstTickDelayMs, now = Date.now, log = console,
}: CommunityPollerDependencies): CommunityPoller {
  let state: CommunityState = core.emptyCommunityState();
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
    onTickComplete({ type: 'community-status', ts: now(), intervalMinutes, error, entries: core.shownEntries(state) });
  }

  let stateLoaded: () => void = () => {};
  const stateLoading = new Promise<void>((resolve) => { stateLoaded = resolve; });

  async function acceptRows(payload: CommunityRowsPayload): Promise<void> {
    await stateLoading;
    if (loop.isStopped()) throw new Error('The community lane is not running');
    const nowIso = new Date(now()).toISOString();
    if (payload.source === 'forum') {
      const { items, droppedRows } = core.forumItemsFromRows(payload.rows);
      if (droppedRows > 0) log.warn(`[${core.COMMUNITY_LANE_ID}] dropped ${droppedRows} malformed forum row(s)`);
      state = core.withPendingItems(state, items, nowIso);
    }
    if (payload.source === 'discord') {
      if (core.pendingEntries(state, 'discord').length >= core.MAX_PENDING_DISCORD_ENTRIES) throw new Error('Too many Discord messages are waiting for the question judge');
      const { items, replyFacts, dropReasons } = core.discordItemsFromRows(payload.rows, discordChannels);
      const dropSummary = core.discordDropSummary(dropReasons);
      if (dropSummary) log.warn(`[${core.COMMUNITY_LANE_ID}] ${dropSummary}`);
      state = core.withPendingItems(state, items, nowIso, replyFacts);
    }
    if (!await loop.save()) throw new Error('The community rows could not be saved');
  }

  async function judgePendingDiscord(source: DiscordSource): Promise<string | null> {
    const candidates = core.pendingEntries(state, 'discord').slice(0, core.SOURCE_ROW_LIMIT);
    if (candidates.length === 0) return null;
    const replyFacts = new Map(candidates.flatMap((entry) => entry.replyFacts ? [[entry.item.key, entry.replyFacts] as const] : []));
    const questionKeys = await source.judgeQuestions(candidates.map((entry) => entry.item), replyFacts).catch(() => null);
    if (questionKeys === null) return 'The Discord question judge gave no usable answer; these messages are checked again next poll';
    state = core.admitPendingItems(state, candidates.map((entry) => entry.item.key), (key) => questionKeys.has(key));
    return null;
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

  async function runTick(): Promise<TickOutcome> {
    state = core.admitPendingItems(state, core.pendingEntries(state, 'forum').map((entry) => entry.item.key));
    const judgeError = discord === null ? null : await judgePendingDiscord(discord);
    const feedError = watcherFeedError('Community has no forum or Discord rows', feedSilenceMs(), intervalMs, 'PostHog');
    const pollError = judgeError ?? feedError;
    state = core.prunedState(state, now());
    dispatchRuns();
    await loop.persist();
    publishStatus(pollError);
    if (judgeError) return { failed: true, error: judgeError };
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
      stateLoaded();
      publishStatus(null);
    });
  }

  async function stop(): Promise<void> {
    const stopping = loop.stop();
    stateLoaded();
    for (const controller of runAborts.values()) controller.abort();
    await stopping;
  }

  return { start, stop, tick: loop.tick, state: () => state, acceptRows, applyAction };
}

export { createCommunityPoller };
export type { DiscordSource };
