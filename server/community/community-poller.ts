import { createTickLoop } from '../lanes/lane-runner.ts';
import type { TickOutcome } from '../lanes/lane-runner.ts';
import * as core from './core/community-core.ts';
import type { CommunityState } from '../../shared/contracts/community.ts';

type SourceRows = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };

interface CommunityPollerDependencies {
  intervalMinutes: number;
  queryForum: (sinceIso: string) => Promise<SourceRows>;
  readState: () => Promise<CommunityState>;
  writeState: (state: CommunityState) => Promise<void>;
  onTickComplete?: (summary: Record<string, unknown>) => void;
  firstTickDelayMs?: () => number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

interface CommunityPoller {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  state(): CommunityState;
}

function createCommunityPoller({
  intervalMinutes, queryForum, readState, writeState,
  onTickComplete = () => {}, firstTickDelayMs, now = Date.now, log = console,
}: CommunityPollerDependencies): CommunityPoller {
  let state: CommunityState = core.emptyCommunityState();

  const loop = createTickLoop({
    tag: core.COMMUNITY_LANE_ID,
    intervalMs: intervalMinutes * 60000,
    tick: () => runTick(),
    writeState: () => writeState(state),
    firstTickDelayMs,
    log,
  });

  function publishStatus(error: string | null): void {
    onTickComplete({ type: 'community-status', ts: now(), intervalMinutes, error, entries: Object.values(state.entries) });
  }

  async function pollForum(): Promise<string | null> {
    const watermark = state.watermarks.forum;
    const nowIso = new Date(now()).toISOString();
    if (watermark === null) {
      state = core.admitForumItems(state, [], nowIso).state;
      return null;
    }
    const fetched = await queryForum(watermark);
    if (!fetched.ok) return fetched.error;
    const { items, droppedRows } = core.forumItemsFromRows(fetched.rows);
    if (droppedRows > 0) log.warn(`[${core.COMMUNITY_LANE_ID}] dropped ${droppedRows} malformed forum row(s)`);
    state = core.admitForumItems(state, items, nowIso).state;
    return null;
  }

  async function runTick(): Promise<TickOutcome> {
    const forumError = await pollForum();
    state = core.prunedState(state, now());
    await loop.persist();
    publishStatus(forumError);
    if (forumError) return { failed: true, error: forumError };
    return {};
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      state = await readState();
      publishStatus(null);
    });
  }

  return { start, stop: () => loop.stop(), tick: loop.tick, state: () => state };
}

export { createCommunityPoller };
export type { CommunityPoller, SourceRows };
