import { EventEmitter } from 'node:events';
import type { GithubPr, GithubPrLightSearchNode, GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import type { GithubPollingRefreshResult } from '../../shared/contracts/github-polling.ts';
import type { MyPrThreadNode } from '../../shared/contracts/my-prs.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import type { PrGh } from './pr-gh.ts';
import type { SharedClock, TickOutcome } from '../lanes/lane-runner.ts';
import { nextRetrySchedule, secondaryRateLimitWaitMs, shouldSkipTick } from '../lanes/core/lane-backoff.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { hasUnresolvedThreads } from './core/my-prs-core.ts';
import { applyGithubPrDetails, GITHUB_STORE_BEHIND_INTERVAL_MS, githubPrChangeSet, githubPrsWithChangedBehindCounts, githubStoreCacheEvictionKey, githubStoreLightIntervalMs, githubStorePrReference, githubStoreWatchNodes, githubStoreWatchUnion, isGithubStoreMembershipDue, isGithubStorePollDue, normalizeGithubPr } from './core/github-store-core.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../../shared/timer-deps.ts';
import { errorMessage } from '../../shared/text.ts';

interface GithubStoreWatch {
  name: string;
  qualifiers: string;
  needsDetail: boolean;
}

interface GithubStoreDependencies {
  github: Pick<PrGh, 'searchPrsLight' | 'prsLightByKey' | 'prDetails' | 'notificationsSince' | 'behindCounts' | 'reviewThreadsBatch' | 'rateLimitWaitMs' | 'viewPr' | 'prDiff' | 'prHead'> & Partial<Pick<PrGh, 'teamReviewCompare' | 'teamReviewThreads'>>;
  now: () => number;
  isDashboardConnected: () => boolean;
  exclusive: SharedClock['exclusive'];
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  log: Pick<Console, 'warn'>;
}

type GithubStoreSnapshot = Pick<GithubPrsFrame, 'prs' | 'freshness'>;
type GithubStoreReadMode = 'wait' | 'no-wait';
export type GithubStoreRead<Value> = { isRateLimited: false; value: Value } | { isRateLimited: true; waitMs: number };
type WatchState = GithubStoreWatch & { nodes: readonly GithubPrLightSearchNode[]; returnedKeys: readonly string[]; returnedCount: number; totalCount: number; isComplete: boolean; isLoaded: boolean; lastMembershipPolledAt: number | null; membershipRevision: number };

const REFRESH_DEBOUNCE_MS = 5_000;
const DEFAULT_NOTIFICATIONS_INTERVAL_MS = 60_000;
const RATE_LIMIT_RESOURCES = ['graphql', 'core'] as const;

export function githubStoreRateLimitedError(waitMs: number): string {
  return `GitHub rate limit asks to wait about ${Math.max(1, Math.ceil(waitMs / 60_000))} min before reading the pull request. Try again then`;
}

export function createGithubStorePoller({ github, now, isDashboardConnected, exclusive, setTimeoutFn, clearTimeoutFn, log }: GithubStoreDependencies) {
  const events = new EventEmitter<{
    change: [key: string, pr: GithubPr | null];
    'snapshot-changed': [snapshot: ReturnType<typeof getSnapshot>];
  }>();
  const watches = new Map<string, WatchState>();
  const watchedKeysByOwner = new Map<string, Set<string>>();
  const refreshTimersByKey = new Map<string, TimerHandle>();
  const prViewsByHead = new Map<string, NonNullable<Awaited<ReturnType<PrGh['viewPr']>>>>();
  const diffsByHead = new Map<string, string>();
  const teamReviewComparisonsByHeads = new Map<string, Extract<Awaited<ReturnType<PrGh['teamReviewCompare']>>, { ok: true }>>();
  let prs: GithubStoreSnapshot['prs'] = {};
  let lightByKey = new Map<string, GithubPrLightSearchNode>();
  let membershipRevision = 0;
  let lastLightPolledAt: number | null = null;
  let lastNotificationsPolledAt: number | null = null;
  let lastBehindPolledAt: number | null = null;
  let notificationsIntervalMs = DEFAULT_NOTIFICATIONS_INTERVAL_MS;
  let notificationsLastModified: string | undefined;
  let isNotificationsDisabled = false;
  let lastRefreshedAt: number | null = null;
  let pollingError: string | null = null;
  let backoffUntil = 0;
  let failureStreak = 0;
  const unavailableKeys = new Set<string>();

  function getSnapshot() {
    const watchSnapshots = Object.fromEntries([...watches].map(([name, watch]) => [name, {
      keys: watch.returnedKeys,
      returnedCount: watch.returnedCount, totalCount: watch.totalCount, isComplete: watch.isComplete, isLoaded: watch.isLoaded,
    }]));
    return { prs, freshness: { lastRefreshedAt, error: pollingError }, watches: watchSnapshots };
  }

  function registerWatch(watch: GithubStoreWatch): void {
    const previous = watches.get(watch.name);
    if (previous?.qualifiers === watch.qualifiers) {
      if (previous.needsDetail === watch.needsDetail) return;
      previous.needsDetail = watch.needsDetail;
      lastLightPolledAt = null;
      return;
    }
    watches.set(watch.name, { ...watch, nodes: [], returnedKeys: [], returnedCount: 0, totalCount: 0, isComplete: false, isLoaded: false, lastMembershipPolledAt: null, membershipRevision });
    lastLightPolledAt = null;
  }

  function unregisterWatch(name: string): void {
    watches.delete(name);
    lastLightPolledAt = null;
  }

  function setWatchedKeys(owner: string, keys: readonly string[]): void {
    const validKeys = keys.flatMap((key) => {
      const reference = githubStorePrReference(key);
      return reference ? [comparablePrKey(reference)] : [];
    });
    const previousKeys = watchedKeysByOwner.get(owner) ?? new Set<string>();
    const nextKeys = new Set(validKeys);
    if (nextKeys.size === previousKeys.size && [...nextKeys].every((key) => previousKeys.has(key))) return;
    watchedKeysByOwner.delete(owner);
    for (const key of validKeys) unavailableKeys.delete(key);
    if (validKeys.length > 0) watchedKeysByOwner.set(owner, nextKeys);
    lastLightPolledAt = null;
  }

  function publishChanges(details: readonly GithubPr[], removedKeys: readonly string[], previousError: string | null, hasWatchChanges = false): void {
    if (details.length === 0 && removedKeys.length === 0 && pollingError === previousError && !hasWatchChanges) return;
    for (const key of removedKeys) events.emit('change', key, null);
    for (const pr of details) events.emit('change', pr.key, pr);
    events.emit('snapshot-changed', getSnapshot());
  }

  function recordFailure(error: unknown): TickOutcome {
    pollingError = errorMessage(error);
    failureStreak += 1;
    const retryAfterMs = secondaryRateLimitWaitMs(pollingError) ?? undefined;
    const schedule = nextRetrySchedule({ failureStreak, quickRetryCount: 0, quickRetries: false, retryAfterMs, baseMs: 60_000, maxMs: GITHUB_RATE_LIMIT_WINDOW_MS, random: () => 1 });
    backoffUntil = now() + schedule.waitMs;
    log.warn(`[github-store] ${pollingError}`);
    return { failed: true, retryAfterMs: schedule.waitMs };
  }

  function recordReadFailure(error: unknown): void {
    log.warn(`[github-store] ${errorMessage(error)}`);
  }

  function recordSuccess(): void {
    pollingError = null;
    failureStreak = 0;
    backoffUntil = 0;
  }

  async function fetchDetails(keys: readonly string[]) {
    if (keys.length === 0) return { details: [], nodes: [], missingKeys: [] };
    const references = keys.flatMap((key) => {
      const reference = githubStorePrReference(key);
      return reference ? [reference] : [];
    });
    const detailsByKey = await github.prDetails(references);
    const nodes = keys.flatMap((key) => {
      const node = detailsByKey.get(key);
      return node ? [node] : [];
    });
    const missingKeys = keys.filter((key) => !detailsByKey.has(key));
    for (const key of missingKeys) unavailableKeys.add(key);
    for (const node of nodes) unavailableKeys.delete(comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }));
    const openNodes = nodes.filter((node) => node.state === 'OPEN');
    const behindCounts = openNodes.length === 0 ? new Map<string, number>() : await github.behindCounts(openNodes.map((node) => ({ repo: node.repository.nameWithOwner, number: node.number, headSha: node.headRefOid })));
    const threadedNodes = openNodes.filter(hasUnresolvedThreads);
    const threadsByPr = threadedNodes.length === 0 ? new Map<string, MyPrThreadNode[]>() : await github.reviewThreadsBatch(threadedNodes.map((node) => ({ repo: node.repository.nameWithOwner, number: node.number })));
    const comparableBehindCounts = new Map([...behindCounts].map(([key, count]) => [key.toLowerCase(), count]));
    const comparableThreads = new Map([...threadsByPr].map(([key, threads]) => [key.toLowerCase(), threads]));
    const details = nodes.map((node) => {
      const key = comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number });
      return normalizeGithubPr(node, node.state === 'OPEN' ? comparableBehindCounts.get(key) ?? null : null, comparableThreads.get(key) ?? []);
    });
    return { details, nodes, missingKeys };
  }

  async function pollLight(tickStartedAt: number, watchNames?: ReadonlySet<string>) {
    const watchResults: { watch: WatchState; nodes: readonly GithubPrLightSearchNode[]; returnedKeys: readonly string[]; returnedCount: number; totalCount: number; isComplete: boolean }[] = [];
    let hasWatchChanges = false;
    const pollMembershipRevision = membershipRevision;
    for (const watch of watches.values()) {
      if (watchNames && !watchNames.has(watch.name)) continue;
      if (!watchNames && watch.membershipRevision === pollMembershipRevision && !isGithubStoreMembershipDue(watch.lastMembershipPolledAt, tickStartedAt, isDashboardConnected())) continue;
      const search = await github.searchPrsLight(watch.qualifiers);
      if (!search.ok) throw new Error(search.error);
      const nodes = githubStoreWatchNodes(watch.nodes, search.items, search.isComplete);
      const returnedKeys = search.items.map((node) => comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }));
      const returnedCount = search.items.length;
      const totalCount = search.totalCount ?? returnedCount + Number(!search.isComplete);
      hasWatchChanges ||= !watch.isLoaded || watch.returnedCount !== returnedCount || watch.totalCount !== totalCount || watch.isComplete !== search.isComplete
        || watch.returnedKeys.length !== returnedKeys.length || watch.returnedKeys.some((key, index) => key !== returnedKeys[index]);
      watchResults.push({ watch, nodes, returnedKeys, returnedCount, totalCount, isComplete: search.isComplete });
    }
    const watchedKeys = new Set([...watchedKeysByOwner.values()].flatMap((keys) => [...keys]));
    const refreshedByName = new Map(watchResults.map((refreshed) => [refreshed.watch.name, refreshed]));
    const unchangedWatches = [...watches.values()].filter((watch) => !refreshedByName.has(watch.name));
    const unionWatches = [
      ...unchangedWatches,
      ...watchResults.map(({ watch, nodes }) => ({ nodes, needsDetail: watch.needsDetail })),
    ];
    const union = githubStoreWatchUnion(unionWatches, watchedKeys, lightByKey);
    const knownKeys = new Set([...union.lightByKey.keys(), ...watchedKeys]);
    const references = [...knownKeys].flatMap((key) => {
      const reference = githubStorePrReference(key);
      return reference ? [reference] : [];
    });
    const currentLightByKey = await github.prsLightByKey(references);
    const missingLightKeys = [...knownKeys].filter((key) => !currentLightByKey.has(key));
    const changes = githubPrChangeSet(lightByKey, [...currentLightByKey.values()]);
    const changedKeys = new Set(changes.detailKeys);
    for (const key of unavailableKeys) {
      if (!union.detailKeys.has(key)) unavailableKeys.delete(key);
    }
    const detailKeys = [...union.detailKeys].filter((key) => currentLightByKey.has(key) && (changedKeys.has(key) || (!prs[key] && !unavailableKeys.has(key))));
    const { details, nodes, missingKeys } = await fetchDetails(detailKeys);
    for (const refreshed of watchResults) {
      if (watches.get(refreshed.watch.name) !== refreshed.watch) continue;
      Object.assign(refreshed.watch, { nodes: refreshed.nodes, returnedKeys: refreshed.returnedKeys, returnedCount: refreshed.returnedCount, totalCount: refreshed.totalCount, isComplete: refreshed.isComplete, isLoaded: true, lastMembershipPolledAt: tickStartedAt, membershipRevision: pollMembershipRevision });
    }
    lightByKey = changes.lightByKey;
    for (const node of nodes) lightByKey.set(comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }), node);
    for (const key of missingLightKeys) unavailableKeys.add(key);
    const removedKeys = [...new Set([...changes.removedKeys, ...missingLightKeys.filter((key) => prs[key]), ...missingKeys.filter((key) => prs[key])])];
    prs = applyGithubPrDetails(prs, details, removedKeys);
    if (!watchNames) lastLightPolledAt = tickStartedAt;
    lastRefreshedAt = now();
    return { details, removedKeys, hasWatchChanges };
  }

  async function pollBehindCounts(tickStartedAt: number, refreshedKeys: ReadonlySet<string>): Promise<GithubPr[]> {
    const detailWatchKeys = new Set([...watches.values()].filter((watch) => watch.needsDetail)
      .flatMap((watch) => watch.nodes.map((node) => comparablePrKey({ repo: node.repository.nameWithOwner, number: node.number }))));
    const openPrs = Object.values(prs).filter((pr) => pr.state === 'OPEN' && detailWatchKeys.has(pr.key) && !refreshedKeys.has(pr.key));
    const behindCounts = openPrs.length === 0 ? new Map<string, number>() : await github.behindCounts(openPrs.map((pr) => ({ repo: pr.repo, number: pr.number, headSha: pr.headRefOid })));
    const changedPrs = githubPrsWithChangedBehindCounts(openPrs, new Map([...behindCounts].map(([key, count]) => [key.toLowerCase(), count])));
    prs = applyGithubPrDetails(prs, changedPrs, []);
    lastBehindPolledAt = tickStartedAt;
    return changedPrs;
  }

  async function pollNotifications(tickStartedAt: number): Promise<void> {
    const notifications = await github.notificationsSince(notificationsLastModified);
    lastNotificationsPolledAt = tickStartedAt;
    if (notifications.kind === 'forbidden') {
      isNotificationsDisabled = true;
      log.warn(`[github-store] notifications disabled until restart: ${notifications.message}`);
      return;
    }
    if (notifications.kind === 'error') throw new Error(notifications.message);
    notificationsLastModified = notifications.lastModified ?? notificationsLastModified;
    notificationsIntervalMs = Math.max(DEFAULT_NOTIFICATIONS_INTERVAL_MS, (notifications.pollIntervalSeconds ?? 0) * 1000);
    if (notifications.kind === 'unchanged') return;
    for (const key of notifications.prKeys) requestRefresh(key);
  }

  function tick(watchNames?: readonly string[]): Promise<TickOutcome> {
    return exclusive(async () => {
      const tickStartedAt = now();
      if (shouldSkipTick({ now: tickStartedAt, backoffUntil })) return { failed: watchNames !== undefined, retryAfterMs: backoffUntil - tickStartedAt };
      const previousError = pollingError;
      let details: GithubPr[] = [];
      let removedKeys: string[] = [];
      let hasWatchChanges = false;
      let behindChangedPrs: GithubPr[] = [];
      try {
        const isLightDue = watchNames !== undefined || isGithubStorePollDue(lastLightPolledAt, tickStartedAt, githubStoreLightIntervalMs(isDashboardConnected()));
        const isNotificationsDue = watchNames === undefined && !isNotificationsDisabled && isGithubStorePollDue(lastNotificationsPolledAt, tickStartedAt, notificationsIntervalMs);
        const isBehindDue = watchNames === undefined && isGithubStorePollDue(lastBehindPolledAt, tickStartedAt, GITHUB_STORE_BEHIND_INTERVAL_MS);
        if (!isLightDue && !isNotificationsDue && !isBehindDue) return { failed: false };
        const rateLimitWaitMs = await github.rateLimitWaitMs(now(), RATE_LIMIT_RESOURCES);
        if (rateLimitWaitMs !== null && rateLimitWaitMs > 0) {
          backoffUntil = now() + rateLimitWaitMs;
          return { failed: true, retryAfterMs: rateLimitWaitMs };
        }
        if (isLightDue) ({ details, removedKeys, hasWatchChanges } = await pollLight(tickStartedAt, watchNames ? new Set(watchNames) : undefined));
        if (isBehindDue) behindChangedPrs = await pollBehindCounts(tickStartedAt, new Set(details.map((pr) => pr.key)));
        if (isNotificationsDue) await pollNotifications(tickStartedAt);
        recordSuccess();
        return { failed: false };
      } catch (error: unknown) {
        return recordFailure(error);
      } finally {
        publishChanges([...details, ...behindChangedPrs], removedKeys, previousError, hasWatchChanges);
      }
    });
  }

  async function refreshWatches(names: readonly string[]): Promise<GithubPollingRefreshResult> {
    const outcome = await tick(names);
    if (outcome.failed) return { ok: false, error: pollingError ?? 'GitHub rate limit asks to wait before refreshing.' };
    return { ok: true };
  }

  async function readWaitMs(): Promise<number> {
    const rateLimitWaitMs = await github.rateLimitWaitMs(now(), RATE_LIMIT_RESOURCES);
    return Math.max(backoffUntil - now(), rateLimitWaitMs ?? 0);
  }

  async function readWhenAllowed<Value>(read: () => Promise<Value>, canSkipWait: () => boolean = () => false, mode: GithubStoreReadMode = 'wait'): Promise<GithubStoreRead<Value>> {
    while (true) {
      const attempt = await exclusive(async (): Promise<{ isReady: true; value: Value } | { isReady: false; waitMs: number }> => {
        const waitMs = canSkipWait() ? 0 : await readWaitMs();
        if (waitMs > 0) return { isReady: false, waitMs };
        return { isReady: true, value: await read() };
      });
      if (attempt.isReady) return { isRateLimited: false, value: attempt.value };
      if (mode === 'no-wait') return { isRateLimited: true, waitMs: attempt.waitMs };
      await new Promise<void>((resolve) => setTimeoutFn(resolve, attempt.waitMs));
    }
  }

  function requestRefresh(key: string): void {
    const reference = githubStorePrReference(key);
    if (!reference) return;
    const comparableKey = comparablePrKey(reference);
    if (!prs[comparableKey]) {
      membershipRevision += 1;
      lastLightPolledAt = null;
    }
    const previousTimer = refreshTimersByKey.get(comparableKey);
    if (previousTimer) clearTimeoutFn(previousTimer);
    refreshTimersByKey.set(comparableKey, setTimeoutFn(() => {
      refreshTimersByKey.delete(comparableKey);
      void readWhenAllowed(async () => {
        const previousError = pollingError;
        const refreshedLightByKey = await github.prsLightByKey([reference]);
        const lightNode = refreshedLightByKey.get(comparableKey);
        const previousLight = lightByKey.get(comparableKey);
        const changes = githubPrChangeSet(new Map(previousLight ? [[comparableKey, previousLight]] : []), lightNode ? [lightNode] : []);
        const { details, nodes, missingKeys } = await fetchDetails(lightNode && !prs[comparableKey] ? [comparableKey] : changes.detailKeys);
        const removedKeys = [...new Set([...changes.removedKeys, ...missingKeys])].filter((key) => prs[key]);
        lightByKey.delete(comparableKey);
        if (lightNode) lightByKey.set(comparableKey, lightNode);
        prs = applyGithubPrDetails(prs, details, removedKeys);
        for (const node of nodes) lightByKey.set(comparableKey, node);
        lastRefreshedAt = now();
        recordSuccess();
        publishChanges(details, removedKeys, previousError);
      }).catch(recordReadFailure);
    }, REFRESH_DEBOUNCE_MS));
  }

  async function requestRead<Value>(read: () => Promise<Value>, fallback: Value, hasCachedValue: () => boolean = () => false, mode: GithubStoreReadMode = 'wait'): Promise<GithubStoreRead<Value>> {
    try {
      return await readWhenAllowed(read, hasCachedValue, mode);
    } catch (error: unknown) {
      recordReadFailure(error);
      return { isRateLimited: false, value: fallback };
    }
  }

  function requestCached<Value>(cache: Map<string, Value>, key: string, read: () => Promise<Value | null>, mode: GithubStoreReadMode = 'wait'): Promise<GithubStoreRead<Value | null>> {
    return requestRead<Value | null>(async () => {
      if (cache.has(key)) return cache.get(key) ?? null;
      const value = await read();
      if (value === null) return null;
      const evictionKey = githubStoreCacheEvictionKey(cache, key);
      if (evictionKey !== null) cache.delete(evictionKey);
      cache.set(key, value);
      return value;
    }, null, () => cache.has(key), mode);
  }

  function requestPrView(repo: string, number: number, headSha: string, mode: GithubStoreReadMode = 'wait') {
    return requestCached(prViewsByHead, `${comparablePrKey({ repo, number })}@${headSha}`, async () => {
      const pr = await github.viewPr(repo, number);
      return pr?.headRefOid === headSha ? pr : null;
    }, mode);
  }

  function requestPrDiff(repo: string, number: number, headSha: string, mode: GithubStoreReadMode = 'wait') {
    return requestCached(diffsByHead, `${comparablePrKey({ repo, number })}@${headSha}`, async () => {
      if (await github.prHead(repo, number) !== headSha) return null;
      const diff = await github.prDiff(repo, number);
      if (await github.prHead(repo, number) !== headSha) return null;
      return diff;
    }, mode);
  }

  function requestTeamReviewCompare(repo: string, baseSha: string, headSha: string, mode: GithubStoreReadMode = 'wait'): Promise<GithubStoreRead<Awaited<ReturnType<PrGh['teamReviewCompare']>>>> {
    const key = `${repo.toLowerCase()}@${baseSha}...${headSha}`;
    return requestRead(async () => {
      const cached = teamReviewComparisonsByHeads.get(key);
      if (cached) {
        teamReviewComparisonsByHeads.delete(key);
        teamReviewComparisonsByHeads.set(key, cached);
        return cached;
      }
      if (!github.teamReviewCompare) return { ok: false as const, err: 'GitHub compare failed' };
      const comparison = await github.teamReviewCompare(repo, baseSha, headSha).catch((error: unknown) => ({ ok: false as const, err: errorMessage(error) }));
      if (!comparison.ok) return comparison;
      const evictionKey = githubStoreCacheEvictionKey(teamReviewComparisonsByHeads, key);
      if (evictionKey !== null) teamReviewComparisonsByHeads.delete(evictionKey);
      teamReviewComparisonsByHeads.set(key, comparison);
      return comparison;
    }, { ok: false, err: 'GitHub compare failed' }, () => teamReviewComparisonsByHeads.has(key), mode);
  }

  function requestTeamReviewThreads(prs: Parameters<PrGh['teamReviewThreads']>[0], mode: GithubStoreReadMode = 'wait'): Promise<GithubStoreRead<Awaited<ReturnType<PrGh['teamReviewThreads']>>>> {
    return requestRead(() => github.teamReviewThreads?.(prs) ?? Promise.resolve(new Map()), new Map(), () => false, mode);
  }

  return {
    events, registerWatch, unregisterWatch, setWatchedKeys, tick, requestRefresh, refreshWatches, getSnapshot,
    requestPrView, requestPrDiff, requestTeamReviewCompare, requestTeamReviewThreads,
    requestPrHead: (repo: string, number: number, mode: GithubStoreReadMode = 'wait') => requestRead(() => github.prHead(repo, number), null, () => false, mode),
  };
}
