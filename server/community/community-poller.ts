import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickOutcome } from '../lanes/lane-runner.ts';
import * as core from './core/community-core.ts';
import type { CommunityAction, CommunityItem, CommunityState, CommunityStateEntry } from '../../shared/contracts/community.ts';
import { errorMessage } from '../../shared/text.ts';

type SourceRows = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };

interface CommunityPollerDependencies {
  intervalMinutes: number;
  queryForum: (sinceIso: string) => Promise<SourceRows>;
  discord?: DiscordSource | null;
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
  channels: readonly string[];
  query: (sinceIso: string) => Promise<SourceRows>;
  judgeQuestions: (candidates: readonly CommunityItem[]) => Promise<Set<string> | null>;
}

interface CommunityPoller {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  state(): CommunityState;
  applyAction(key: string, action: CommunityAction): Promise<{ ok: true } | { ok: false; error: string }>;
}

function createCommunityPoller({
  intervalMinutes, queryForum, discord = null, readState, writeState, runItem, maxConcurrentRuns = core.MAX_CONCURRENT_RUNS,
  onTickComplete = () => {}, onDraftReady = () => {}, firstTickDelayMs, now = Date.now, log = console,
}: CommunityPollerDependencies): CommunityPoller {
  let state: CommunityState = core.emptyCommunityState();
  const runAborts = new Map<string, AbortController>();

  const loop = createTickLoop({
    tag: core.COMMUNITY_LANE_ID,
    intervalMs: intervalMinutes * 60000,
    tick: () => runTick(),
    writeState: () => writeState(state),
    firstTickDelayMs,
    now,
    log,
  });

  function publishStatus(error: string | null): void {
    onTickComplete({ type: 'community-status', ts: now(), intervalMinutes, error, entries: Object.values(state.entries) });
  }

  async function pollForum(): Promise<string | null> {
    const watermark = state.watermarks.forum;
    const nowIso = new Date(now()).toISOString();
    if (watermark === null) {
      state = core.admitSourceItems(state, 'forum', [], nowIso).state;
      return null;
    }
    const fetched = await queryForum(watermark);
    if (!fetched.ok) return fetched.error;
    const { items, droppedRows } = core.forumItemsFromRows(fetched.rows);
    if (droppedRows > 0) log.warn(`[${core.COMMUNITY_LANE_ID}] dropped ${droppedRows} malformed forum row(s)`);
    state = core.admitSourceItems(state, 'forum', items, nowIso).state;
    return null;
  }

  async function pollDiscord(source: DiscordSource): Promise<string | null> {
    const watermark = state.watermarks.discord;
    const nowIso = new Date(now()).toISOString();
    if (watermark === null) {
      state = core.admitSourceItems(state, 'discord', [], nowIso).state;
      return null;
    }
    const fetched = await source.query(watermark);
    if (!fetched.ok) return fetched.error;
    const { items, droppedRows, newestRowAt } = core.discordItemsFromRows(fetched.rows, source.channels);
    if (droppedRows > 0) log.warn(`[${core.COMMUNITY_LANE_ID}] dropped ${droppedRows} malformed Discord event(s)`);
    const candidates = core.freshItems(state, 'discord', items);
    const questionKeys = candidates.length > 0 ? await source.judgeQuestions(candidates).catch(() => null) : new Set<string>();
    if (questionKeys === null) return 'The Discord question judge gave no usable answer; these messages are checked again next poll';
    const admitted = core.admitSourceItems(state, 'discord', items, nowIso, (key) => questionKeys.has(key)).state;
    state = core.withWatermarkAtLeast(admitted, 'discord', newestRowAt);
    return null;
  }

  function replaceEntry(entry: CommunityStateEntry): void {
    state = { ...state, entries: { ...state.entries, [entry.item.key]: entry } };
  }

  async function finishRun(key: string, run: core.CommunityRunResult): Promise<void> {
    runAborts.delete(key);
    const entry = state.entries[key];
    if (loop.isStopped() || !entry) return;
    if (entry.status !== 'running') {
      dispatchRuns();
      return;
    }
    const finished = core.entryFromRun(entry, run, new Date(now()).toISOString());
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
    const forumError = await pollForum();
    const discordError = discord && discord.channels.length > 0 ? await pollDiscord(discord) : null;
    const pollError = forumError ?? discordError;
    state = core.prunedState(state, now());
    dispatchRuns();
    await loop.persist();
    publishStatus(pollError);
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

  return { start, stop, tick: loop.tick, state: () => state, applyAction };
}

export { createCommunityPoller };
export type { DiscordSource, SourceRows };
