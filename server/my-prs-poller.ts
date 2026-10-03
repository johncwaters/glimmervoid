import * as core from './core/my-prs-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './core/lane-backoff.ts';
import { prKey } from './core/team-review-core.ts';
import { drainPending } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import { MyPrsState } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrAutoRebase, MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrsState as MyPrsStateType, MyPrsStatus, MyPrThreadNode } from '../shared/contracts/my-prs.ts';

const MY_PRS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

interface MyPrsPollerDependencies {
  org: string;
  shouldAutoRebase?: boolean;
  readState?: () => Promise<unknown>;
  writeState?: (state: MyPrsStateType) => Promise<void>;
  fixMergeability?: (pr: MyPr, signal: AbortSignal) => Promise<void>;
  github: Pick<PrGh, 'viewer' | 'searchMyPrs' | 'behindCounts' | 'reviewThreadsBatch' | 'rebasePr' | 'rateLimitWaitMs'>;
  onTickComplete: (status: MyPrsStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  setTimeoutFn?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  log?: Pick<Console, 'warn'>;
}

export function createMyPrsPoller(dependencies: MyPrsPollerDependencies) {
  const { org, shouldAutoRebase = false, github, onTickComplete, now = Date.now, intervalMinutes = core.POLL_INTERVAL_MINUTES, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn, clock, firstTickDelayMs, log } = dependencies;
  let viewer: string | null = null;
  let hasLookedUpViewer = false;
  let previousPrs: MyPr[] = [];
  let previousTruncatedNote: string | null = null;
  let pollingError: string | null = null;
  const autoRebaseByKey = new Map<string, MyPrAutoRebase>();
  const failedAutoRebaseAttempts = new Set<string>();
  const keepMergeableKeys = new Set<string>();
  const keepMergeableAttemptKeys = new Set<string>();
  const fixesInFlight = new Set<string>();
  const pendingFixes = new Set<Promise<void>>();
  const fixControllersByKey = new Map<string, AbortController>();
  const shutdownController = new AbortController();
  let stateLoad: Promise<void> | null = null;

  async function loadState(): Promise<void> {
    if (stateLoad) return stateLoad;
    stateLoad = (async () => {
      const state = MyPrsState.parse(await dependencies.readState?.() ?? { keepMergeableKeys: [], keepMergeableAttemptKeys: [] });
      for (const key of state.keepMergeableKeys) keepMergeableKeys.add(key);
      for (const key of state.keepMergeableAttemptKeys) keepMergeableAttemptKeys.add(key);
    })();
    return stateLoad;
  }

  function publishStatus(): void {
    onTickComplete({ ...core.myPrsStatus({ ts: now(), configured: true, viewer, prs: previousPrs, error: pollingError, truncatedNote: previousTruncatedNote }), ...loop.scheduleStatus() });
  }

  const loop = createTickLoop({
    tag: core.MY_PRS_LANE_ID, intervalMs: intervalMinutes * 60000, setIntervalFn, clearIntervalFn, clock, firstTickDelayMs, setTimeoutFn, clearTimeoutFn, now, quickRetries: true,
    rateLimitWaitMs: () => github.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES),
    onScheduleChange: publishStatus,
    writeState: () => dependencies.writeState?.(MyPrsState.parse({ keepMergeableKeys: [...keepMergeableKeys], keepMergeableAttemptKeys: [...keepMergeableAttemptKeys] })),
    backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        pollingError = error instanceof Error ? error.message : String(error);
        return failedOutcome(pollingError);
      }
    },
  });
  async function failedOutcome(errorText: string) {
    const rateLimitWaitMs = await github.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(errorText);
    return rateLimitWaitMs === null ? { failed: true } : { failed: true, retryAfterMs: rateLimitWaitMs };
  }
  async function runTick() {
    await loadState();
    if (loop.isStopped()) return { failed: false };
    if (!hasLookedUpViewer) {
      viewer = await github.viewer();
      if (loop.isStopped()) return { failed: false };
      if (viewer === null) {
        pollingError = 'Could not look up your GitHub account.';
        return failedOutcome(pollingError);
      }
      hasLookedUpViewer = true;
    }
    const timestamp = now();
    const search = await github.searchMyPrs(org, core.mergedSinceDate(timestamp));
    if (loop.isStopped()) return { failed: false };
    if (!search.ok) {
      pollingError = search.error;
      return failedOutcome(search.error);
    }
    const openPrs = search.items.filter((node) => node.state === 'OPEN').map((node) => ({ repo: node.repository.nameWithOwner, number: node.number, headSha: node.headRefOid }));
    const behindCounts = openPrs.length > 0 ? await github.behindCounts(openPrs) : new Map<string, number>();
    if (loop.isStopped()) return { failed: false };
    const threadedPrs = search.items.filter((node) => node.state === 'OPEN' && core.hasUnresolvedThreads(node)).map((node) => ({ repo: node.repository.nameWithOwner, number: node.number }));
    const threadsByPr = threadedPrs.length > 0 ? await github.reviewThreadsBatch(threadedPrs) : new Map<string, MyPrThreadNode[]>();
    if (loop.isStopped()) return { failed: false };
    const prs: MyPr[] = [];
    for (const node of search.items) {
      const key = `${node.repository.nameWithOwner}#${node.number}`;
      const behindBy = node.state === 'OPEN' ? behindCounts.get(key) ?? null : null;
      const isFailedRecordForAnotherHead = autoRebaseByKey.get(key)?.outcome === 'failed' && !failedAutoRebaseAttempts.has(core.autoRebaseAttemptKey(node));
      if (isFailedRecordForAnotherHead) autoRebaseByKey.delete(key);
      if (shouldAutoRebase && core.shouldAutoRebase(node, behindBy, failedAutoRebaseAttempts)) {
        const rebase = await github.rebasePr(node.id, node.headRefOid);
        if (loop.isStopped()) return { failed: false };
        if (!rebase.ok) failedAutoRebaseAttempts.add(core.autoRebaseAttemptKey(node));
        if (!rebase.ok) log?.warn(`[${core.MY_PRS_LANE_ID}] auto-rebase of ${key} failed: ${rebase.err.trim()}`);
        autoRebaseByKey.set(key, core.autoRebaseRecord(rebase, node.baseRefName, now()));
      }
      const threadNodes = threadsByPr.get(key) ?? [];
      prs.push(core.withAutoRebase(core.toMyPr(node, behindBy, threadNodes), autoRebaseByKey.get(key)));
    }
    const listedKeys = new Set(prs.map((pr) => pr.key));
    for (const key of [...autoRebaseByKey.keys()]) {
      if (!listedKeys.has(key)) autoRebaseByKey.delete(key);
    }
    previousPrs = core.sortedMyPrs(prs, timestamp);
    const prunedState = core.prunedKeepMergeableState({
      keepMergeableKeys, keepMergeableAttemptKeys, listedPrKeys: new Set(previousPrs.map((pr) => pr.key)), returnedCount: search.items.length, totalCount: search.totalCount,
    });
    keepMergeableKeys.clear();
    for (const key of prunedState.keepMergeableKeys) keepMergeableKeys.add(key);
    keepMergeableAttemptKeys.clear();
    for (const attemptKey of prunedState.keepMergeableAttemptKeys) keepMergeableAttemptKeys.add(attemptKey);
    previousPrs = previousPrs.map((pr) => ({ ...pr, keepMergeable: keepMergeableKeys.has(pr.key) }));
    cancelFixes(core.keepMergeableFixesToCancel(fixControllersByKey.keys(), keepMergeableKeys, previousPrs));
    previousTruncatedNote = core.truncatedSearchNote(search.items.length, search.totalCount);
    pollingError = null;
    await loop.persist();
    await dispatchFixes();
    return { failed: false };
  }

  async function launchFix(pr: MyPr, fixMergeability: NonNullable<MyPrsPollerDependencies['fixMergeability']>): Promise<boolean> {
    keepMergeableAttemptKeys.add(core.keepMergeableAttemptKey(pr));
    await loop.persist();
    if (loop.isStopped() || !keepMergeableKeys.has(pr.key)) return false;
    const fixController = new AbortController();
    fixControllersByKey.set(pr.key, fixController);
    const fixSignal = AbortSignal.any([shutdownController.signal, fixController.signal]);
    const fix = Promise.resolve().then(() => fixMergeability(pr, fixSignal)).catch((error: unknown) => {
      log?.warn(`[${core.MY_PRS_LANE_ID}] keep mergeable fix for ${pr.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      fixesInFlight.delete(pr.key);
      if (fixControllersByKey.get(pr.key) === fixController) fixControllersByKey.delete(pr.key);
      pendingFixes.delete(fix);
    });
    pendingFixes.add(fix);
    return true;
  }

  async function dispatchFixes(): Promise<void> {
    const fixMergeability = dependencies.fixMergeability;
    if (!fixMergeability || loop.isStopped()) return;
    for (const pr of previousPrs) {
      if (fixesInFlight.has(pr.key) || !core.shouldFixMergeability(pr, keepMergeableKeys, keepMergeableAttemptKeys)) continue;
      fixesInFlight.add(pr.key);
      let isLaunched = false;
      try {
        isLaunched = await launchFix(pr, fixMergeability);
      } finally {
        if (!isLaunched) fixesInFlight.delete(pr.key);
      }
      if (loop.isStopped()) return;
    }
  }

  function cancelFixes(keys: Iterable<string>): void {
    for (const key of keys) fixControllersByKey.get(key)?.abort();
  }

  async function setKeepMergeable(request: MyPrKeepMergeableRequest): Promise<Omit<MyPrKeepMergeableResult, 'key'>> {
    await loadState();
    if (loop.isStopped()) return { ok: false, error: 'My pull requests is not running' };
    const key = prKey(request.repo, request.number);
    const pr = previousPrs.find((candidate) => candidate.key === key);
    if (!pr) return { ok: false, error: 'That pull request is not one of your tracked pull requests' };
    if (request.keepMergeable && pr.state !== 'OPEN') return { ok: false, error: 'That pull request is no longer open' };
    if (request.keepMergeable) keepMergeableKeys.add(key);
    if (!request.keepMergeable) keepMergeableKeys.delete(key);
    if (!request.keepMergeable) cancelFixes([key]);
    previousPrs = previousPrs.map((candidate) => ({ ...candidate, keepMergeable: keepMergeableKeys.has(candidate.key) }));
    await loop.persist();
    if (!loop.isStopped()) publishStatus();
    await dispatchFixes();
    return { ok: true };
  }

  async function stop(): Promise<void> {
    shutdownController.abort();
    await loop.stop();
    await drainPending(Promise.allSettled([...pendingFixes]));
  }

  return { start: loop.start, stop, tick: loop.tick, refresh: loop.refresh, setKeepMergeable };
}
