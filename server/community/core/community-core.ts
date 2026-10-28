import { CommunityItem, CommunityState } from '../../../shared/contracts/community.ts';
import type { CommunityStateEntry } from '../../../shared/contracts/community.ts';
import { resolvePosthogHost } from '../../radar/core/radar-lane-core.ts';

const COMMUNITY_LANE_ID = 'community';
const COMMUNITY_STATE_FILENAME = 'community-state.json';
const DEFAULT_PROJECT_ID = 2;
const DEFAULT_INTERVAL_MINUTES = 5;
const SOURCE_ROW_LIMIT = 50;
const ENTRY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const FORUM_QUESTION_URL = 'https://posthog.com/questions/';
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 20000;
const MAX_AUTHOR_CHARS = 100;

interface CommunitySettings {
  enabled: boolean;
  skill: string;
  projectId: number;
  intervalMinutes: number;
}

interface PosthogConnection {
  host: string;
  apiKey: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readCommunitySettings(config: { community?: unknown }): CommunitySettings {
  const block = recordOf(config.community);
  return {
    enabled: block.enabled === true,
    skill: typeof block.skill === 'string' ? block.skill.trim() : '',
    projectId: positiveIntegerOr(block.projectId, DEFAULT_PROJECT_ID),
    intervalMinutes: positiveIntegerOr(block.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
  };
}

function readPosthogConnection(config: { posthog?: unknown }): PosthogConnection | null {
  const block = recordOf(config.posthog);
  const apiKey = typeof block.apiKey === 'string' ? block.apiKey.trim() : '';
  if (!apiKey) return null;
  return { host: resolvePosthogHost(typeof block.host === 'string' ? block.host.trim() : null), apiKey };
}

function communityGate(config: { community?: unknown; posthog?: unknown }): { start: boolean; reason?: string } {
  if (!readCommunitySettings(config).enabled) return { start: false };
  if (!readPosthogConnection(config)) return { start: false, reason: 'community.enabled but posthog.apiKey is missing' };
  return { start: true };
}

function emptyCommunityState(): CommunityState {
  return { watermarks: { forum: null, discord: null }, entries: {} };
}

function forumQuery(): string {
  return [
    'SELECT id, attributes FROM custom.squeak.questions',
    "WHERE parseDateTimeBestEffort(JSONExtractString(attributes, 'createdAt')) > parseDateTimeBestEffort({since})",
    "ORDER BY parseDateTimeBestEffort(JSONExtractString(attributes, 'createdAt')) ASC",
    `LIMIT ${SOURCE_ROW_LIMIT}`,
  ].join(' ');
}

function parsedAttributes(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return recordOf(raw);
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return {};
  }
}

function forumAuthor(profile: unknown): string {
  const firstName = recordOf(recordOf(recordOf(profile).data).attributes).firstName;
  return typeof firstName === 'string' && firstName.trim() ? firstName.trim().slice(0, MAX_AUTHOR_CHARS) : 'unknown';
}

function forumItemFromRow(row: Record<string, unknown>): CommunityItem | null {
  const attributes = parsedAttributes(row.attributes);
  const permalink = typeof attributes.permalink === 'string' ? attributes.permalink : '';
  const createdAt = typeof attributes.createdAt === 'string' ? attributes.createdAt : '';
  if (!permalink || Number.isNaN(Date.parse(createdAt))) return null;
  const parsed = CommunityItem.safeParse({
    key: `forum:${String(row.id)}`,
    source: 'forum',
    title: String(attributes.subject ?? '').slice(0, MAX_TITLE_CHARS),
    body: String(attributes.body ?? '').slice(0, MAX_BODY_CHARS),
    url: `${FORUM_QUESTION_URL}${encodeURIComponent(permalink)}`,
    author: forumAuthor(attributes.profile),
    channel: null,
    createdAt: new Date(createdAt).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

function forumItemsFromRows(rows: readonly Record<string, unknown>[]): { items: CommunityItem[]; droppedRows: number } {
  const items = rows.map(forumItemFromRow).filter((item): item is CommunityItem => item !== null);
  return { items, droppedRows: rows.length - items.length };
}

function queuedEntry(item: CommunityItem, nowIso: string): CommunityStateEntry {
  return {
    item, status: 'queued', verdict: null, summary: '', goal: '', checked: [], gaps: [], draft: null,
    attempts: 0, seenAt: nowIso, finishedAt: null,
  };
}

function latestCreatedAt(items: readonly CommunityItem[], watermark: string): string {
  return items.reduce((latest, item) => (Date.parse(item.createdAt) > Date.parse(latest) ? item.createdAt : latest), watermark);
}

function admitForumItems(state: CommunityState, items: readonly CommunityItem[], nowIso: string): { state: CommunityState; admittedKeys: string[] } {
  const watermark = state.watermarks.forum;
  if (watermark === null) return { state: { ...state, watermarks: { ...state.watermarks, forum: nowIso } }, admittedKeys: [] };
  const freshItems = items.filter((item) => Date.parse(item.createdAt) > Date.parse(watermark) && !state.entries[item.key]);
  const entries = { ...state.entries };
  for (const item of freshItems) entries[item.key] = queuedEntry(item, nowIso);
  return {
    state: { watermarks: { ...state.watermarks, forum: latestCreatedAt(items, watermark) }, entries },
    admittedKeys: freshItems.map((item) => item.key),
  };
}

function shouldPruneEntry(entry: CommunityStateEntry, nowMs: number, retentionMs: number = ENTRY_RETENTION_MS): boolean {
  if (entry.status === 'queued' || entry.status === 'running') return false;
  const lastTouched = Date.parse(entry.finishedAt ?? entry.seenAt);
  return Number.isNaN(lastTouched) || nowMs - lastTouched > retentionMs;
}

function prunedState(state: CommunityState, nowMs: number): CommunityState {
  const entries = Object.fromEntries(Object.entries(state.entries).filter(([, entry]) => !shouldPruneEntry(entry, nowMs)));
  return { ...state, entries };
}

function parseCommunityState(raw: unknown, warn: (message: string) => void): CommunityState | null {
  const block = recordOf(raw);
  const watermarks = CommunityState.shape.watermarks.safeParse(block.watermarks);
  if (!watermarks.success) return null;
  const entries: CommunityState['entries'] = {};
  for (const [key, value] of Object.entries(recordOf(block.entries))) {
    const parsed = CommunityState.shape.entries.safeParse({ [key]: value });
    if (!parsed.success) {
      warn(`dropped an invalid saved community item ${key.slice(0, 160)}`);
      continue;
    }
    Object.assign(entries, parsed.data);
  }
  return { watermarks: watermarks.data, entries };
}

export {
  COMMUNITY_LANE_ID, COMMUNITY_STATE_FILENAME,
  admitForumItems, communityGate, emptyCommunityState, forumItemsFromRows, forumQuery, parseCommunityState, prunedState,
  readCommunitySettings, readPosthogConnection, shouldPruneEntry,
};
export type { CommunitySettings, PosthogConnection };
