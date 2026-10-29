import type { CommunityStateEntry, CommunityStatus, CommunityVerdict } from '#shared/contracts/community.ts';
import type { StateTone } from '../state-tone-core.ts';
import type { CommunityQueueItem, QueueGroup } from '../github/review-queue-core.ts';

const VERDICT_TEXT: Readonly<Record<CommunityVerdict, string>> = { HIGH: 'High confidence', MEDIUM: 'Medium confidence', LOW: 'Low confidence' };

const VERDICT_TONES: Readonly<Record<CommunityVerdict, StateTone>> = { HIGH: 'ok', MEDIUM: 'warn', LOW: 'muted' };

const STATUS_TEXT: Readonly<Record<Exclude<CommunityStateEntry['status'], 'ready'>, string>> = {
  queued: 'Waiting to be researched', running: 'Researching', error: 'Research failed', aside: 'Set aside',
};

const SOURCE_TEXT: Readonly<Record<CommunityStateEntry['item']['source'], string>> = { forum: 'Forum', discord: 'Discord' };

interface CommunityBadge { text: string; tone: StateTone }

interface StartSessionCandidate { id: string; name: string; isWorkspace: boolean; isEphemeral: boolean }

export function communityBadge(entry: CommunityStateEntry): CommunityBadge {
  if (entry.status === 'ready' && entry.verdict) return { text: VERDICT_TEXT[entry.verdict], tone: VERDICT_TONES[entry.verdict] };
  if (entry.status === 'ready') return { text: 'Researched', tone: 'muted' };
  if (entry.status === 'error') return { text: STATUS_TEXT.error, tone: 'danger' };
  return { text: STATUS_TEXT[entry.status], tone: 'muted' };
}

export function communitySourceText(entry: CommunityStateEntry): string {
  const source = SOURCE_TEXT[entry.item.source];
  return entry.item.channel ? `${source} #${entry.item.channel}` : source;
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

export function communityCaughtUpText(groups: readonly QueueGroup<CommunityQueueItem>[]): string {
  const workingCount = groups.find((group) => group.id === 'working')?.items.length ?? 0;
  if (workingCount === 0) return 'No community question needs you right now.';
  return `No community question needs you right now. ${workingCount} ${workingCount === 1 ? 'question is' : 'questions are'} being researched.`;
}

export function communityEmptyText(status: CommunityStatus | null): string {
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
