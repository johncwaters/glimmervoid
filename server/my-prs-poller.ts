import * as core from './core/my-prs-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './core/lane-backoff.ts';
import { prKey } from './core/team-review-core.ts';
import { drainPending, firstLine } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { SharedClock } from './lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import { MyPrsState } from '../shared/contracts/my-prs.ts';
import type { MyPr, MyPrAutoRebase, MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrKeepMergeableAttemptRecord, MyPrMergeabilityFixResult, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsState as MyPrsStateType, MyPrsStatus, MyPrThreadNode } from '../shared/contracts/my-prs.ts';
import { errorMessage } from '../shared/text.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../shared/timer-deps.ts';

const MY_PRS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

interface MyPrsPollerDependencies {
  org: string;
  shouldAutoRebase?: boolean;
  isKeepMergeableEnabled?: boolean;
  isMergeQueueEnabled?: boolean;
  readState?: () => Promise<unknown>;
  writeState?: (state: MyPrsStateType) => Promise<void>;
  fixMergeability?: (pr: MyPr, signal: AbortSignal, onPushStarted: (repairSha: string) => Promise<void>, latestListedPr: () => MyPr | undefined) => Promise<MyPrMergeabilityFixResult>;
  beforeStart?: () => Promise<void>;
  github: Pick<PrGh, 'viewer' | 'searchMyPrs' | 'behindCounts' | 'reviewThreadsBatch' | 'rebasePr' | 'rateLimitWaitMs'>;
  mergePr?: (pr: MyPr) => Promise<Omit<MyPrMergeResult, 'key'>>;
  onTickComplete: (status: MyPrsStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  log?: Pick<Console, 'warn'>;
}

export function createMyPrsPoller(dependencies: MyPrsPollerDependencies) {
  const { org, shouldAutoRebase = false, isKeepMergeableEnabled = true, isMergeQueueEnabled = true, github, onTickComplete, now = Date.now, intervalMinutes = core.POLL_INTERVAL_MINUTES, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn, clock, firstTickDelayMs, log } = dependencies;
  let viewer: string | null = null;
  let hasLookedUpViewer = false;
  let previousPrs: MyPr[] = [];
  let previousTruncatedNote: string | null = null;
  let pollingError: string | null = null;
  const autoRebaseByKey = new Map<string, MyPrAutoRebase>();
  const failedAutoRebaseAttempts = new Set<string>();
  const keepMergeableKeys = new Set<string>();
  const keepMergeableAttemptKeys = new Set<string>();
  const keepMergeableAttemptsByKey = new Map<string, MyPrKeepMergeableAttemptRecord>();
  const keepMergeablePushedHeadKeys = new Set<string>();
  let mergeQueueKeys: string[] = [];
  const attemptedMergeKeys = new Set<string>();
  const fixesInFlight = new Set<string>();
  const pendingFixes = new Set<Promise<void>>();
  const fixControllersByKey = new Map<string, AbortController>();
  const shutdownController = new AbortController();
  let stateLoad: Promise<void> | null = null;
  let isLeftoverSweepRunning = false;

  async function loadState(): Promise<void> {
    if (stateLoad) return stateLoad;
    stateLoad = (async () => {
      const state = MyPrsState.parse(await dependencies.readState?.() ?? { keepMergeableKeys: [], keepMergeableAttemptKeys: [], mergeQueueKeys: [], keepMergeablePushedHeadKeys: [] });
      for (const key of state.keepMergeableKeys) keepMergeableKeys.add(key);
      for (const key of state.keepMergeableAttemptKeys) keepMergeableAttemptKeys.add(key);
      for (const key of state.keepMergeablePushedHeadKeys) keepMergeablePushedHeadKeys.add(key);
      for (const attempt of state.keepMergeableAttempts) keepMergeableAttemptsByKey.set(attempt.key, attempt);
      mergeQueueKeys = [...new Set(state.mergeQueueKeys)];
    })();
    return stateLoad;
  }

  function publishStatus(): void {
    onTickComplete({
      ...core.myPrsStatus({ ts: now(), configured: true, viewer, prs: previousPrs, error: pollingError, truncatedNote: previousTruncatedNote, isKeepMergeableEnabled, isMergeQueueEnabled }),
      ...loop.scheduleStatus(),
    });
  }

  async function writeCurrentState(): Promise<void> {
    await dependencies.writeState?.(MyPrsState.parse({ keepMergeableKeys: [...keepMergeableKeys], keepMergeableAttemptKeys: [...keepMergeableAttemptKeys], mergeQueueKeys, keepMergeablePushedHeadKeys: [...keepMergeablePushedHeadKeys], keepMergeableAttempts: [...keepMergeableAttemptsByKey.values()] }));
  }

  const loop = createTickLoop({
    tag: core.MY_PRS_LANE_ID, intervalMs: intervalMinutes * 60000, setIntervalFn, clearIntervalFn, clock, firstTickDelayMs, setTimeoutFn, clearTimeoutFn, now, quickRetries: true,
    rateLimitWaitMs: () => github.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES),
    onScheduleChange: publishStatus,
    writeState: writeCurrentState,
    backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        pollingError = errorMessage(error);
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
    const rebasedThisTickKeys = new Set<string>();
    for (const node of search.items) {
      const key = `${node.repository.nameWithOwner}#${node.number}`;
      const behindBy = node.state === 'OPEN' ? behindCounts.get(key) ?? null : null;
      const isFailedRecordForAnotherHead = autoRebaseByKey.get(key)?.outcome === 'failed' && !failedAutoRebaseAttempts.has(core.autoRebaseAttemptKey(node));
      if (isFailedRecordForAnotherHead) autoRebaseByKey.delete(key);
      if (core.shouldRebaseMyPr(node, behindBy, failedAutoRebaseAttempts, { isAutoRebaseOn: shouldAutoRebase, mergeQueueKeys: new Set(isMergeQueueEnabled ? mergeQueueKeys : []), keepMergeablePushedHeadKeys })) {
        const rebase = await github.rebasePr(node.id, node.headRefOid);
        if (loop.isStopped()) return { failed: false };
        if (rebase.ok) rebasedThisTickKeys.add(key);
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
    pruneKeepMergeableState(search.items.length, search.totalCount);
    if (isMergeQueueEnabled) mergeQueueKeys = core.prunedMergeQueueKeys({ mergeQueueKeys, prs, returnedCount: search.items.length, totalCount: search.totalCount });
    previousPrs = withOperatorFlags(previousPrs);
    cancelFixes(core.keepMergeableFixesToCancel(fixControllersByKey.keys(), keepMergeableKeys, previousPrs));
    previousTruncatedNote = core.truncatedSearchNote(search.items.length, search.totalCount);
    pollingError = null;
    await mergeQueuedPrs(rebasedThisTickKeys);
    if (loop.isStopped()) return { failed: false };
    await loop.persist();
    await dispatchFixes();
    return { failed: false };
  }

  function pruneKeepMergeableState(returnedCount: number, totalCount: number): void {
    if (!isKeepMergeableEnabled) return;
    const prunedState = core.prunedKeepMergeableState({
      keepMergeableKeys, keepMergeableAttemptKeys, keepMergeablePushedHeadKeys, keepMergeableAttempts: keepMergeableAttemptsByKey.values(), listedPrKeys: new Set(previousPrs.map((pr) => pr.key)), returnedCount, totalCount,
    });
    keepMergeableAttemptsByKey.clear();
    for (const attempt of prunedState.keepMergeableAttempts) keepMergeableAttemptsByKey.set(attempt.key, attempt);
    keepMergeableKeys.clear();
    for (const key of prunedState.keepMergeableKeys) keepMergeableKeys.add(key);
    keepMergeableAttemptKeys.clear();
    for (const attemptKey of prunedState.keepMergeableAttemptKeys) keepMergeableAttemptKeys.add(attemptKey);
    keepMergeablePushedHeadKeys.clear();
    for (const pushedHeadKey of prunedState.keepMergeablePushedHeadKeys) keepMergeablePushedHeadKeys.add(pushedHeadKey);
  }

  function withOperatorFlags(prs: MyPr[]): MyPr[] {
    const queuePositionByKey = core.mergeQueuePositions(mergeQueueKeys, prs);
    return prs.map((pr) => ({
      ...pr, keepMergeableAttempt: core.currentKeepMergeableAttempt(pr, keepMergeableAttemptsByKey.get(pr.key)), isKeepMergeableFixInFlight: fixesInFlight.has(pr.key), keepMergeable: keepMergeableKeys.has(pr.key), mergeQueuePosition: queuePositionByKey.get(pr.key) ?? null,
      isMergeQueueHeldForRepairPush: queuePositionByKey.has(pr.key) && core.isHeadPushedByKeepMergeable(pr, keepMergeablePushedHeadKeys),
    }));
  }

  async function mergeQueuedPrs(rebasedThisTickKeys: ReadonlySet<string>): Promise<void> {
    const mergePr = dependencies.mergePr;
    if (!isMergeQueueEnabled || !mergePr) return;
    for (const pr of core.mergeQueuePrsToMerge(mergeQueueKeys, previousPrs, { attemptedMergeKeys, keepMergeablePushedHeadKeys, rebasedThisTickKeys })) {
      if (loop.isStopped()) return;
      if (!mergeQueueKeys.includes(pr.key)) continue;
      attemptedMergeKeys.add(core.mergeAttemptKey(pr));
      const merged = await mergePr(pr);
      if (!merged.ok) log?.warn(`[${core.MY_PRS_LANE_ID}] merge when ready for ${pr.key} failed and waits for a new head: ${firstLine(merged.error ?? '')}`);
    }
  }

  function forgetAttempt(attemptKey: string): Promise<void> {
    keepMergeableAttemptKeys.delete(attemptKey);
    return loop.persist();
  }

  function launchFix(pr: MyPr, fixMergeability: NonNullable<MyPrsPollerDependencies['fixMergeability']>): Promise<void> | null {
    if (loop.isStopped() || !keepMergeableKeys.has(pr.key)) return null;
    const attemptKey = core.keepMergeableAttemptKey(pr);
    const fixController = new AbortController();
    fixControllersByKey.set(pr.key, fixController);
    const fixSignal = AbortSignal.any([shutdownController.signal, fixController.signal]);
    keepMergeableAttemptKeys.add(attemptKey);
    fixesInFlight.add(pr.key);
    const forgetAbortedAttempt = () => { void forgetAttempt(attemptKey); };
    fixSignal.addEventListener('abort', forgetAbortedAttempt, { once: true });
    const holdTheRepairHeadBeforeThePush = (repairSha: string): Promise<void> => {
      fixSignal.removeEventListener('abort', forgetAbortedAttempt);
      const repairHeadKey = core.keepMergeableAttemptKey({ key: pr.key, headRefOid: repairSha });
      keepMergeableAttemptKeys.add(repairHeadKey);
      keepMergeablePushedHeadKeys.add(repairHeadKey);
      return loop.persist().then(writeCurrentState);
    };
    const attemptSaved = loop.persist();
    const fix = attemptSaved.then((): Promise<MyPrMergeabilityFixResult> | MyPrMergeabilityFixResult => {
      if (fixSignal.aborted) return { outcome: 'stopped', reason: 'The repair was stopped' };
      return fixMergeability(pr, fixSignal, holdTheRepairHeadBeforeThePush, () => previousPrs.find((listed) => listed.key === pr.key));
    }).catch((error: unknown): MyPrMergeabilityFixResult => {
      const reason = errorMessage(error) || 'The repair failed';
      log?.warn(`[${core.MY_PRS_LANE_ID}] keep mergeable fix for ${pr.key} failed: ${reason}`);
      return { outcome: 'failed', reason };
    }).then(async (repairOutcome) => {
      if (fixSignal.aborted) return;
      if (repairOutcome.outcome === 'stopped') await forgetAttempt(attemptKey);
      const consecutiveAttempts = core.consecutiveKeepMergeableAttempts(pr, keepMergeableAttemptsByKey.get(pr.key));
      keepMergeableAttemptsByKey.set(pr.key, { key: pr.key, headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid, ...repairOutcome, at: now(), consecutiveAttempts });
      await loop.persist();
    }).finally(async () => {
      fixSignal.removeEventListener('abort', forgetAbortedAttempt);
      fixesInFlight.delete(pr.key);
      if (fixControllersByKey.get(pr.key) === fixController) fixControllersByKey.delete(pr.key);
      pendingFixes.delete(fix);
      previousPrs = withOperatorFlags(previousPrs);
      if (!loop.isStopped()) publishStatus();
      if (fixSignal.aborted) await dispatchFixes();
    });
    pendingFixes.add(fix);
    previousPrs = withOperatorFlags(previousPrs);
    publishStatus();
    return attemptSaved;
  }

  async function dispatchFixes(): Promise<void> {
    const fixMergeability = dependencies.fixMergeability;
    if (!isKeepMergeableEnabled || !fixMergeability || loop.isStopped() || isLeftoverSweepRunning) return;
    for (const pr of previousPrs) {
      if (fixesInFlight.has(pr.key) || !core.shouldFixMergeability(pr, keepMergeableKeys, { attemptedHeadKeys: keepMergeableAttemptKeys, keepMergeablePushedHeadKeys, lastAttempt: keepMergeableAttemptsByKey.get(pr.key), nowMs: now() })) continue;
      const attemptSaved = launchFix(pr, fixMergeability);
      if (!attemptSaved) continue;
      await attemptSaved;
      if (loop.isStopped()) return;
    }
  }

  function cancelFixes(keys: Iterable<string>): void {
    for (const key of keys) fixControllersByKey.get(key)?.abort();
  }

  async function toggleRefusal(request: { repo: string; number: number }, isTurningOn: boolean): Promise<string | null> {
    await loadState();
    if (loop.isStopped()) return 'My pull requests is not running';
    const pr = previousPrs.find((candidate) => candidate.key === prKey(request.repo, request.number));
    if (!pr) return 'That pull request is not one of your tracked pull requests';
    if (isTurningOn && pr.state !== 'OPEN') return 'That pull request is no longer open';
    return null;
  }

  async function saveAndPublishFlags(): Promise<void> {
    previousPrs = withOperatorFlags(previousPrs);
    await loop.persist();
    if (!loop.isStopped()) publishStatus();
  }

  async function setMergeWhenReady(request: MyPrMergeWhenReadyRequest): Promise<Omit<MyPrMergeWhenReadyResult, 'key'>> {
    if (!isMergeQueueEnabled) return { ok: false, error: 'Merge when ready is turned off in Settings' };
    const refusal = await toggleRefusal(request, request.mergeWhenReady);
    if (refusal) return { ok: false, error: refusal };
    const key = prKey(request.repo, request.number);
    if (request.mergeWhenReady && !mergeQueueKeys.includes(key)) mergeQueueKeys = [...mergeQueueKeys, key];
    if (!request.mergeWhenReady) mergeQueueKeys = mergeQueueKeys.filter((queuedKey) => queuedKey !== key);
    await saveAndPublishFlags();
    return { ok: true };
  }

  async function setKeepMergeable(request: MyPrKeepMergeableRequest): Promise<Omit<MyPrKeepMergeableResult, 'key'>> {
    if (!isKeepMergeableEnabled) return { ok: false, error: 'Keep mergeable is turned off in Settings' };
    const refusal = await toggleRefusal(request, request.keepMergeable);
    if (refusal) return { ok: false, error: refusal };
    const key = prKey(request.repo, request.number);
    if (request.keepMergeable) {
      keepMergeableKeys.add(key);
      const pr = previousPrs.find((candidate) => candidate.key === key);
      const canClearAttempt = !fixesInFlight.has(key) || fixControllersByKey.get(key)?.signal.aborted === true;
      if (pr && canClearAttempt) keepMergeableAttemptKeys.delete(core.keepMergeableAttemptKey(pr));
      if (canClearAttempt) keepMergeableAttemptsByKey.delete(key);
    }
    if (!request.keepMergeable) keepMergeableKeys.delete(key);
    if (!request.keepMergeable) cancelFixes([key]);
    await saveAndPublishFlags();
    await dispatchFixes();
    return { ok: true };
  }

  async function stop(): Promise<void> {
    shutdownController.abort();
    await loop.stop();
    await drainPending(Promise.allSettled([...pendingFixes]));
  }

  async function sweepLeftoversBeforeAnyRepair(beforeStart: () => Promise<void>): Promise<void> {
    isLeftoverSweepRunning = true;
    try {
      await beforeStart();
    } finally {
      isLeftoverSweepRunning = false;
    }
  }

  function start(): Promise<void> {
    const beforeStart = dependencies.beforeStart;
    return loop.start(beforeStart ? () => sweepLeftoversBeforeAnyRepair(beforeStart) : null);
  }

  return { start, stop, tick: loop.tick, refresh: loop.refresh, setKeepMergeable, setMergeWhenReady };
}
