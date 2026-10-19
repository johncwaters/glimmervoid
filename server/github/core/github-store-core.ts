import { comparablePrKey, GithubPrKey } from '../../../shared/contracts/github-prs.ts';
import type { GithubPr, GithubPrDetailNode, GithubPrLightSearchNode } from '../../../shared/contracts/github-prs.ts';
import type { MyPrThreadNode } from '../../../shared/contracts/my-prs.ts';
import { toMyPr } from './my-prs-core.ts';
import { toWorkflowPr } from '../../core/workflows-core.ts';

export function normalizeGithubPr(node: GithubPrDetailNode, behindBy: number | null = null, threadNodes: readonly MyPrThreadNode[] = []): GithubPr {
  const myPr = toMyPr(node, behindBy, threadNodes);
  const workflowPr = toWorkflowPr(node);
  return {
    key: comparablePrKey(myPr), id: node.id,
    repo: myPr.repo, number: myPr.number, title: myPr.title, url: myPr.url,
    author: workflowPr.author, labels: workflowPr.labels, commentCount: workflowPr.commentCount,
    isDraft: myPr.isDraft, state: myPr.state,
    createdAt: myPr.createdAt, mergedAt: myPr.mergedAt, updatedAt: myPr.updatedAt,
    baseRefName: myPr.baseRefName, baseRefOid: myPr.baseRefOid,
    headRefName: myPr.headRefName, headRefOid: myPr.headRefOid,
    isCrossRepository: myPr.isCrossRepository, isInMergeQueue: myPr.isInMergeQueue,
    mergeMethod: myPr.mergeMethod, mergeable: myPr.mergeable, mergeStateStatus: myPr.mergeStateStatus,
    reviewDecision: node.reviewDecision, checks: myPr.checks, rollupState: node.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null,
    unresolvedThreads: myPr.unresolvedThreads, threads: myPr.threads, behindBy: myPr.behindBy,
    reviewRequests: myPr.reviewRequests, approvals: myPr.approvals, reviews: myPr.reviews,
  };
}

interface GithubPrChangeSet {
  lightByKey: Map<string, GithubPrLightSearchNode>;
  detailKeys: string[];
  removedKeys: string[];
}

function hasLightChanged(previous: GithubPrLightSearchNode, current: GithubPrLightSearchNode): boolean {
  return previous.updatedAt !== current.updatedAt
    || previous.headRefOid !== current.headRefOid
    || previous.state !== current.state
    || previous.reviewDecision !== current.reviewDecision
    || previous.mergeStateStatus !== current.mergeStateStatus
    || (previous.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null)
      !== (current.commits.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null);
}

export function githubPrChangeSet(previousLightByKey: ReadonlyMap<string, GithubPrLightSearchNode>, lightNodes: readonly GithubPrLightSearchNode[]): GithubPrChangeSet {
  const lightByKey = new Map(lightNodes.map((node) => [comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), node]));
  const detailKeys: string[] = [];
  const removedKeys: string[] = [];
  for (const [key, node] of lightByKey) {
    const previous = previousLightByKey.get(key);
    if (!previous || hasLightChanged(previous, node)) detailKeys.push(key);
  }
  for (const key of previousLightByKey.keys()) {
    if (!lightByKey.has(key)) removedKeys.push(key);
  }
  return { lightByKey, detailKeys, removedKeys };
}

export function applyGithubPrDetails(previousPrs: Readonly<Record<string, GithubPr>>, details: readonly GithubPr[], removedKeys: readonly string[]): Readonly<Record<string, GithubPr>> {
  if (details.length === 0 && removedKeys.length === 0) return previousPrs;
  const prs = { ...previousPrs };
  for (const key of removedKeys) delete prs[key];
  for (const pr of details) prs[pr.key] = pr;
  return prs;
}

export function notificationSubjectPrKey(subjectUrl: string): string | null {
  const subject = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/pulls\/([1-9][0-9]*)$/.exec(subjectUrl);
  if (!subject) return null;
  const parsedKey = GithubPrKey.safeParse(`${subject[1]}#${subject[2]}`.toLowerCase());
  return parsedKey.success ? parsedKey.data : null;
}

const GITHUB_STORE_CACHE_CAP = 128;

export const GITHUB_STORE_BEHIND_INTERVAL_MS = 300_000;

export function githubPrsWithChangedBehindCounts(prs: readonly GithubPr[], behindCountsByKey: ReadonlyMap<string, number>): GithubPr[] {
  return prs.flatMap((pr) => {
    const behindBy = behindCountsByKey.get(pr.key);
    if (behindBy === undefined || behindBy === pr.behindBy) return [];
    return [{ ...pr, behindBy }];
  });
}

export function githubStoreLightIntervalMs(isDashboardConnected: boolean): number {
  return isDashboardConnected ? 60_000 : 300_000;
}

export function isGithubStorePollDue(lastPolledAt: number | null, nowMs: number, intervalMs: number): boolean {
  return lastPolledAt === null || nowMs - lastPolledAt >= intervalMs;
}

export function githubStoreWatchUnion(watches: Iterable<{ nodes: readonly GithubPrLightSearchNode[]; needsDetail: boolean }>, watchedKeys: ReadonlySet<string>, previousLightByKey: ReadonlyMap<string, GithubPrLightSearchNode>) {
  const lightByKey = new Map<string, GithubPrLightSearchNode>();
  const detailKeys = new Set(watchedKeys);
  for (const watch of watches) {
    for (const node of watch.nodes) {
      const key = comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number });
      lightByKey.set(key, node);
      if (watch.needsDetail) detailKeys.add(key);
    }
  }
  for (const key of watchedKeys) {
    if (lightByKey.has(key)) continue;
    const previous = previousLightByKey.get(key);
    if (previous) lightByKey.set(key, previous);
  }
  return { lightByKey, detailKeys };
}

export function githubStoreWatchNodes(previousNodes: readonly GithubPrLightSearchNode[], returnedNodes: readonly GithubPrLightSearchNode[], isComplete: boolean): readonly GithubPrLightSearchNode[] {
  if (isComplete) return returnedNodes;
  const nodesByKey = new Map([...previousNodes, ...returnedNodes].map((node) => [comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), node]));
  return [...nodesByKey.values()];
}

export function githubStorePrReference(key: string): { repo: string; number: number } | null {
  const parsedKey = GithubPrKey.safeParse(key.toLowerCase());
  if (!parsedKey.success) return null;
  const separatorIndex = parsedKey.data.lastIndexOf('#');
  return { repo: parsedKey.data.slice(0, separatorIndex), number: Number(parsedKey.data.slice(separatorIndex + 1)) };
}

export function githubStoreCacheEvictionKey(cache: ReadonlyMap<string, unknown>, key: string): string | null {
  if (cache.has(key) || cache.size < GITHUB_STORE_CACHE_CAP) return null;
  return cache.keys().next().value ?? null;
}
