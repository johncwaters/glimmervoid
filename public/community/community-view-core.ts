import { COMMUNITY_SOURCES, CommunityVerdict } from '#shared/contracts/community.ts';
import type { CommunitySource, CommunityStateEntry, CommunityStatus } from '#shared/contracts/community.ts';
import type { StateTone } from '../state-tone-core.ts';
import type { CommunityQueueGroup, CommunityQueueItem } from '../github/review-queue-core.ts';

const VERDICT_TEXT: Readonly<Record<CommunityVerdict, string>> = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };

const VERDICT_SHORT_TEXT: Readonly<Record<CommunityVerdict, string>> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

const VERDICT_TONES: Readonly<Record<CommunityVerdict, CommunityTone>> = { HIGH: 'ok', MEDIUM: 'neutral', LOW: 'muted' };

const VERDICT_FILLED_PIPS: Readonly<Record<CommunityVerdict, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const STATUS_TEXT: Readonly<Record<Exclude<CommunityStateEntry['status'], 'ready'>, string>> = {
  queued: 'Waiting to be researched', running: 'Researching', error: 'Research failed', aside: 'Set aside',
};

type CommunityTone = StateTone | 'neutral';

interface CommunityBadge { text: string; tone: CommunityTone; filledPips: number | null }

interface StartSessionCandidate { id: string; name: string; isWorkspace: boolean; isEphemeral: boolean }

export function communityBadge(entry: CommunityStateEntry): CommunityBadge {
  if (entry.status === 'ready' && entry.verdict) return { text: VERDICT_TEXT[entry.verdict], tone: VERDICT_TONES[entry.verdict], filledPips: VERDICT_FILLED_PIPS[entry.verdict] };
  if (entry.status === 'ready') return { text: 'Researched', tone: 'muted', filledPips: null };
  if (entry.status === 'error') return { text: STATUS_TEXT.error, tone: 'danger', filledPips: null };
  return { text: STATUS_TEXT[entry.status], tone: 'muted', filledPips: null };
}

export function communityItemLabel(item: CommunityQueueItem): string {
  return item.entry.item.title || 'Untitled question';
}

export function canRerunCommunityEntry(entry: CommunityStateEntry): boolean {
  return entry.status !== 'running' && entry.status !== 'queued';
}

export function canSetAsideCommunityEntry(entry: CommunityStateEntry): boolean {
  return entry.status !== 'aside';
}

export function communityCaughtUpText(groups: readonly CommunityQueueGroup[]): string {
  const workingCount = groups.find((group) => group.id === 'working')?.items.length ?? 0;
  if (workingCount === 0) return 'No community question needs you right now.';
  return `No community question needs you right now. ${workingCount} ${workingCount === 1 ? 'question is' : 'questions are'} being researched.`;
}

export function communityEmptyText(status: CommunityStatus | null, hiddenByFilterCount = 0): string {
  if (hiddenByFilterCount > 0) return `No question matches these filters. ${hiddenByFilterCount} ${hiddenByFilterCount === 1 ? 'question is' : 'questions are'} hidden.`;
  if (!status) return 'Waiting for the community lane to report.';
  if (status.configured === false) return status.reason ?? 'The community lane is not set up yet.';
  return 'No community questions yet. New ones asked after you turned this on show up here.';
}

export function startSessionChoices(candidates: readonly StartSessionCandidate[]): { id: string; name: string }[] {
  return candidates
    .filter((candidate) => !candidate.isWorkspace && !candidate.isEphemeral)
    .map(({ id, name }) => ({ id, name }))
    .toSorted((first, second) => first.name.localeCompare(second.name));
}

export type CommunitySort = 'oldest' | 'newest' | 'confidence' | 'source';

export const DEFAULT_COMMUNITY_SORT: CommunitySort = 'oldest';

export const COMMUNITY_SORT_CHOICES: readonly { value: CommunitySort; label: string; hint: string }[] = [
  { value: 'oldest', label: 'Oldest first', hint: 'waiting longest' },
  { value: 'newest', label: 'Newest first', hint: '' },
  { value: 'confidence', label: 'Confidence', hint: 'high first' },
  { value: 'source', label: 'Source', hint: 'grouped' },
];

const SORT_STATUS_TEXT: Readonly<Record<CommunitySort, string>> = { oldest: 'Oldest first', newest: 'Newest first', confidence: 'By confidence', source: 'By source' };

export function isCommunitySort(value: unknown): value is CommunitySort {
  return COMMUNITY_SORT_CHOICES.some((choice) => choice.value === value);
}

export interface CommunityFilterPrefs { sources: readonly string[]; verdicts: readonly string[]; channels: readonly string[] }

interface CommunityFilter { sources: ReadonlySet<CommunitySource>; verdicts: ReadonlySet<CommunityVerdict>; channels: ReadonlySet<string> }

export const SOURCE_NAMES: Readonly<Record<CommunitySource, string>> = { forum: 'PostHog forum', discord: 'Discord' };

export const VERDICT_FILTER_CHOICES: readonly { value: CommunityVerdict; label: string; filledPips: number; tone: CommunityTone }[] = CommunityVerdict.options.map((verdict) => ({
  value: verdict, label: VERDICT_SHORT_TEXT[verdict], filledPips: VERDICT_FILLED_PIPS[verdict], tone: VERDICT_TONES[verdict],
}));

const SORT_RANK_BY_VERDICT: Readonly<Record<CommunityVerdict, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function parseCommunityFilter(prefs: CommunityFilterPrefs): CommunityFilter {
  return {
    sources: new Set(COMMUNITY_SOURCES.filter((source) => prefs.sources.includes(source))),
    verdicts: new Set(CommunityVerdict.options.filter((verdict) => prefs.verdicts.includes(verdict))),
    channels: new Set(prefs.channels),
  };
}

function isCommunityFilterActive(filter: CommunityFilter): boolean {
  return filter.sources.size > 0 || filter.verdicts.size > 0 || filter.channels.size > 0;
}

function matchesFilter(entry: CommunityStateEntry, filter: CommunityFilter): boolean {
  if (filter.sources.size > 0 && !filter.sources.has(entry.item.source)) return false;
  if (filter.verdicts.size > 0 && (entry.verdict === null || !filter.verdicts.has(entry.verdict))) return false;
  if (filter.channels.size > 0 && (entry.item.channel === null || !filter.channels.has(entry.item.channel))) return false;
  return true;
}

function askedAtMsOf(entry: CommunityStateEntry): number {
  const askedAtMs = Date.parse(entry.item.createdAt);
  return Number.isNaN(askedAtMs) ? Number.POSITIVE_INFINITY : askedAtMs;
}

function verdictRank(entry: CommunityStateEntry): number {
  return entry.verdict === null ? CommunityVerdict.options.length : SORT_RANK_BY_VERDICT[entry.verdict];
}

const COMPARE_BY_SORT: Readonly<Record<CommunitySort, (first: CommunityStateEntry, second: CommunityStateEntry) => number>> = {
  oldest: (first, second) => askedAtMsOf(first) - askedAtMsOf(second),
  newest: (first, second) => askedAtMsOf(second) - askedAtMsOf(first),
  confidence: (first, second) => verdictRank(first) - verdictRank(second) || askedAtMsOf(first) - askedAtMsOf(second),
  source: (first, second) => COMMUNITY_SOURCES.indexOf(first.item.source) - COMMUNITY_SOURCES.indexOf(second.item.source) || askedAtMsOf(first) - askedAtMsOf(second),
};

export function arrangeCommunityGroups(groups: readonly CommunityQueueGroup[], sort: CommunitySort, filter: CommunityFilter): CommunityQueueGroup[] {
  const compare = COMPARE_BY_SORT[sort];
  return groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => matchesFilter(item.entry, filter)).toSorted((first, second) => compare(first.entry, second.entry)),
  }));
}

interface CommunityFilterCounts { sources: ReadonlyMap<CommunitySource, number>; verdicts: ReadonlyMap<CommunityVerdict, number>; channels: ReadonlyMap<string, number> }

function countBy<Key>(keys: readonly (Key | null)[]): Map<Key, number> {
  const counts = new Map<Key, number>();
  for (const key of keys) {
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function withSavedChoices<Key extends string>(counts: ReadonlyMap<Key, number>, order: readonly Key[], saved: ReadonlySet<Key>): Map<Key, number> {
  return new Map(order.filter((key) => counts.has(key) || saved.has(key)).map((key) => [key, counts.get(key) ?? 0]));
}

export function communityFilterCounts(groups: readonly CommunityQueueGroup[], filter: CommunityFilter): CommunityFilterCounts {
  const entries = groups.flatMap((group) => group.items.map((item) => item.entry));
  const channelCounts = countBy(entries.map((entry) => entry.item.channel));
  const channelOrder = [...new Set([...channelCounts.keys(), ...filter.channels])].toSorted((first, second) => first.localeCompare(second));
  return {
    sources: withSavedChoices(countBy(entries.map((entry) => entry.item.source)), COMMUNITY_SOURCES, filter.sources),
    verdicts: withSavedChoices(countBy(entries.map((entry) => entry.verdict)), CommunityVerdict.options, filter.verdicts),
    channels: withSavedChoices(channelCounts, channelOrder, filter.channels),
  };
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function communityStatusText(sort: CommunitySort, filter: CommunityFilter): string {
  const sortText = SORT_STATUS_TEXT[sort];
  if (!isCommunityFilterActive(filter)) return sortText;
  const verdictNames = VERDICT_FILTER_CHOICES.filter((choice) => filter.verdicts.has(choice.value)).map((choice) => choice.label.toLowerCase());
  const parts = [
    ...COMMUNITY_SOURCES.filter((source) => filter.sources.has(source)).map((source) => SOURCE_NAMES[source]),
    ...[...filter.channels].toSorted().map((channel) => `#${channel}`),
    ...(verdictNames.length > 0 ? [`${joinNames(verdictNames)} confidence`] : []),
  ];
  return `${sortText}, ${joinNames(parts)} only`;
}
