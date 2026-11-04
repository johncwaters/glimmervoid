import type { MyPrThread } from '../../../shared/contracts/my-prs.ts';
import type { PrFlowItem, PrFlowPriority, PrFlowSource } from '../../../shared/contracts/pr-flows.ts';

type PrFlowCandidate = {
  path: string; lineStart: number | null; lineEnd: number | null; priority: PrFlowPriority; source: PrFlowSource; body: string; url: string | null;
};

const MERGE_LINE_DISTANCE = 3;
const BODY_PREFIX_CHARACTERS = 120;
const PRIORITY_RANK: Readonly<Record<PrFlowPriority, number>> = { blocker: 0, high: 1, medium: 2, low: 3, unknown: 4 };

function normalizedBodyPrefix(body: string): string {
  return [...body.replace(/\s+/g, ' ').trim().toLowerCase()].slice(0, BODY_PREFIX_CHARACTERS).join('');
}

export function threadCandidates(threads: readonly MyPrThread[]): PrFlowCandidate[] {
  return threads.map((thread) => ({
    path: thread.path, lineStart: thread.line, lineEnd: thread.line, priority: 'unknown',
    source: { kind: 'thread', name: thread.author ?? 'a deleted account', threadId: thread.id, url: thread.url },
    body: thread.excerpt, url: thread.url,
  }));
}

function higherPriority(left: PrFlowPriority, right: PrFlowPriority): PrFlowPriority {
  return PRIORITY_RANK[right] < PRIORITY_RANK[left] ? right : left;
}

function itemOf(candidate: PrFlowCandidate): PrFlowItem {
  const identity = candidate.source.threadId ?? `${candidate.source.kind}:${candidate.source.name}`;
  return {
    key: `${candidate.path}:${candidate.lineStart ?? ''}:${identity}`, path: candidate.path, lineStart: candidate.lineStart, lineEnd: candidate.lineEnd,
    priority: candidate.priority, sources: [candidate.source], excerpt: candidate.body, url: candidate.url,
  };
}

function absorb(item: PrFlowItem, candidate: PrFlowCandidate): PrFlowItem {
  const lineEnd = item.lineEnd === null || candidate.lineEnd === null ? item.lineEnd : Math.max(item.lineEnd, candidate.lineEnd);
  return { ...item, lineEnd, priority: higherPriority(item.priority, candidate.priority), sources: [...item.sources, candidate.source] };
}

function compareByLine(left: PrFlowCandidate, right: PrFlowCandidate): number {
  return (left.lineStart ?? 0) - (right.lineStart ?? 0);
}

function mergeLinedCandidates(candidates: readonly PrFlowCandidate[]): PrFlowItem[] {
  const items: PrFlowItem[] = [];
  for (const candidate of [...candidates].sort(compareByLine)) {
    const previous = items.at(-1);
    const isNearPrevious = previous?.lineEnd != null && candidate.lineStart !== null && candidate.lineStart <= previous.lineEnd + MERGE_LINE_DISTANCE;
    if (previous && isNearPrevious) {
      items[items.length - 1] = absorb(previous, candidate);
      continue;
    }
    items.push(itemOf(candidate));
  }
  return items;
}

function mergeUnlinedCandidates(candidates: readonly PrFlowCandidate[]): PrFlowItem[] {
  const itemsByPrefix = new Map<string, PrFlowItem>();
  for (const candidate of candidates) {
    const prefix = normalizedBodyPrefix(candidate.body);
    const existing = itemsByPrefix.get(prefix);
    itemsByPrefix.set(prefix, existing ? absorb(existing, candidate) : itemOf(candidate));
  }
  return [...itemsByPrefix.values()];
}

function candidatesByPath(candidates: readonly PrFlowCandidate[]): Map<string, PrFlowCandidate[]> {
  const byPath = new Map<string, PrFlowCandidate[]>();
  for (const candidate of candidates) {
    const pathCandidates = byPath.get(candidate.path);
    if (pathCandidates) {
      pathCandidates.push(candidate);
      continue;
    }
    byPath.set(candidate.path, [candidate]);
  }
  return byPath;
}

export function mergeItems(candidates: readonly PrFlowCandidate[]): PrFlowItem[] {
  return [...candidatesByPath(candidates).values()].flatMap((pathCandidates) => [
    ...mergeLinedCandidates(pathCandidates.filter((candidate) => candidate.lineStart !== null)),
    ...mergeUnlinedCandidates(pathCandidates.filter((candidate) => candidate.lineStart === null)),
  ]).sort((left, right) => PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] || left.path.localeCompare(right.path) || (left.lineStart ?? 0) - (right.lineStart ?? 0));
}
