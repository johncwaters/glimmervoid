import { extractRows } from '../../../server/radar/posthog-api.ts';
import { discordItemsFromRows, discordQuery, forumItemsFromRows, forumQuery } from '../../../server/community/core/community-core.ts';
import type { CommunityRowsPayload } from '../../../shared/contracts/community.ts';
import type { CommunityWatcheeSettings } from '../../../shared/contracts/watchee-settings.ts';
import type { DetectOutcome, Watchee, WatcheeContext, WatcheeDetector } from '../watchee.ts';
import { observedPayloadEventKey } from '../watchee-event-key.ts';
import { POSTHOG_API_KEY_ENV, createWatcheePosthog, posthogDetectFailure } from '../posthog-watchee.ts';

const MS_PER_MINUTE = 60_000;
const COMMUNITY_CURSORS_FILENAME = 'community-cursors.json';
const MAX_JOB_ROWS_BYTES = 600 * 1024;

type CommunitySourceName = CommunityRowsPayload['source'];
type CommunityCursors = Record<CommunitySourceName, string | null>;
type CommunityRow = Record<string, unknown>;

interface RowBatch {
  rows: CommunityRow[];
  coveredRows: CommunityRow[];
  bytes: number;
}

function cursorOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function laterTimestamp(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  if (current === null || Date.parse(candidate) > Date.parse(current)) return candidate;
  return current;
}

function newestRowAt(source: CommunitySourceName, rows: readonly CommunityRow[], discordChannels: readonly string[]): string | null {
  if (source === 'forum') return forumItemsFromRows(rows).newestRowAt;
  return discordItemsFromRows(rows, discordChannels).newestRowAt;
}

function sourceQuery(source: CommunitySourceName, cursor: string, discordChannels: readonly string[]): { query: string; values: Record<string, unknown> } {
  if (source === 'forum') return { query: forumQuery(), values: { since: cursor } };
  return { query: discordQuery(), values: { since: cursor, channels: discordChannels } };
}

function rowBatches(rows: readonly CommunityRow[]): { batches: RowBatch[]; oversizedRowCount: number } {
  const batches: RowBatch[] = [];
  let current: RowBatch = { rows: [], coveredRows: [], bytes: 0 };
  let oversizedRowCount = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (current.coveredRows.length > 0 && current.bytes + rowBytes > MAX_JOB_ROWS_BYTES) {
      batches.push(current);
      current = { rows: [], coveredRows: [], bytes: 0 };
    }
    current.coveredRows.push(row);
    if (rowBytes > MAX_JOB_ROWS_BYTES) {
      oversizedRowCount += 1;
      continue;
    }
    current.rows.push(row);
    current.bytes += rowBytes;
  }
  if (current.coveredRows.length > 0) batches.push(current);
  return { batches, oversizedRowCount };
}

function watchedSources(community: CommunityWatcheeSettings): CommunitySourceName[] {
  return community.discordChannels.length > 0 ? ['forum', 'discord'] : ['forum'];
}

function createCommunityDetector(context: Pick<WatcheeContext, 'files' | 'now' | 'log'>, fetchFn?: typeof fetch): WatcheeDetector<'community.rows'> {
  let cursors: CommunityCursors | null = null;

  async function loadedCursors(): Promise<CommunityCursors> {
    if (cursors !== null) return cursors;
    const saved = await context.files.read(COMMUNITY_CURSORS_FILENAME);
    const savedCursors: Record<string, unknown> = saved !== null && typeof saved === 'object' ? { ...saved } : {};
    cursors = { forum: cursorOrNull(savedCursors.forum), discord: cursorOrNull(savedCursors.discord) };
    return cursors;
  }

  async function detect({ community }: { community: CommunityWatcheeSettings }): Promise<DetectOutcome<'community.rows'>> {
    const posthog = createWatcheePosthog(community.host, fetchFn);
    if (posthog === null) return { ok: false, reason: `${POSTHOG_API_KEY_ENV} is not set for glimmervoid watch` };
    const savedCursors = await loadedCursors();
    const events: CommunityRowsPayload[] = [];
    for (const source of watchedSources(community)) {
      const observedAt = new Date(context.now()).toISOString();
      const cursor = savedCursors[source];
      if (cursor === null) {
        events.push({ observedAt, source, rows: [], cursorAfter: observedAt });
        continue;
      }
      const { query, values } = sourceQuery(source, cursor, community.discordChannels);
      const response = await posthog.api.runHogQL(community.projectId, query, values);
      if (!response.ok && source === 'forum') return posthogDetectFailure(`${source} query`, response);
      if (!response.ok) {
        context.log.warn(`[watcher] community ${posthogDetectFailure(`${source} query`, response).reason}; forum questions still go out`);
        continue;
      }
      const { batches, oversizedRowCount } = rowBatches(extractRows(response.body));
      if (oversizedRowCount > 0) context.log.warn(`[watcher] community skipped ${oversizedRowCount} ${source} row(s) too large for one job`);
      if (batches.length === 0) events.push({ observedAt, source, rows: [], cursorAfter: cursor });
      let cursorAfter: string | null = cursor;
      for (const batch of batches) {
        cursorAfter = laterTimestamp(cursorAfter, newestRowAt(source, batch.coveredRows, community.discordChannels));
        events.push({ observedAt, source, rows: batch.rows, cursorAfter });
      }
    }
    return { ok: true, events };
  }

  async function acknowledged(payload: CommunityRowsPayload): Promise<void> {
    const savedCursors = await loadedCursors();
    const advanced = { ...savedCursors, [payload.source]: laterTimestamp(savedCursors[payload.source], payload.cursorAfter) };
    await context.files.write(COMMUNITY_CURSORS_FILENAME, advanced);
    cursors = advanced;
  }

  return { detect, acknowledged, stop: () => {} };
}

const communityWatchee: Watchee<'community.rows'> = {
  kind: 'community.rows',
  laneId: 'community',
  trigger: (settings) => ({ kind: 'interval', everyMs: settings.community.intervalMinutes * MS_PER_MINUTE }),
  gate: ({ community }) => {
    if (!community.enabled) return { run: false, reason: 'Community is off' };
    return { run: true };
  },
  start: (context) => createCommunityDetector(context),
  eventKey: observedPayloadEventKey,
};

export { createCommunityDetector, communityWatchee };
