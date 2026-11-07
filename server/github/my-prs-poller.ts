import * as core from './core/my-prs-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from '../lanes/core/lane-backoff.ts';
import { prKey } from './core/team-review-core.ts';
import { drainPending, firstLine } from '../lanes/ephemeral-session.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { SharedClock } from '../lanes/lane-runner.ts';
import type { GithubLaneStore } from './github-store-wiring.ts';
import { storeReadingLaneClock } from './github-store-wiring.ts';
import type { PrGh } from './pr-gh.ts';
import type { MyPr, MyPrAutoRebase, MyPrsSnapshot, MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrKeepMergeableAttemptRecord, MyPrMergeabilityFixResult, MyPrMergeQueueFailure, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult } from '../../shared/contracts/my-prs.ts';
import { myPrFromGithubPr } from '../../shared/my-pr-merge.ts';
import { errorMessage } from '../../shared/text.ts';
import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import type { GithubPr } from '../../shared/contracts/github-prs.ts';
import type { MyPrsCandidatesPayload } from '../../shared/contracts/my-prs-candidates.ts';
import { isOlderObservation, watcherFeedError } from '../lanes/core/watchee-feed-core.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../../shared/timer-deps.ts';

const MY_PRS_RATE_LIMIT_RESOURCES = ['graphql'] as const;

interface MyPrsPollerDependencies {
  shouldAutoRebase?: boolean;
  isKeepMergeableEnabled?: boolean;
  isMergeQueueEnabled?: boolean;
  readState?: () => Promise<unknown>;
  writeState?: (state: core.MyPrsLaneState) => Promise<void>;
  fixMergeability?: (pr: MyPr, signal: AbortSignal, onPushStarted: (repairSha: string) => Promise<void>, latestListedPr: () => MyPr | undefined) => Promise<MyPrMergeabilityFixResult>;
  beforeStart?: () => Promise<void>;
  github: Pick<PrGh, 'rebasePr'>;
  store: GithubLaneStore;
  mergePr?: (pr: MyPr) => Promise<Omit<MyPrMergeResult, 'key'>>;
  onTickComplete: (status: MyPrsSnapshot) => void;
  now?: () => number;
  intervalMinutes?: number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  log?: Pick<Console, 'warn'>;
  feedSilenceMs?: () => number;
}

export function createMyPrsPoller(dependencies: MyPrsPollerDependencies) {
  const { shouldAutoRebase = false, isKeepMergeableEnabled = true, isMergeQueueEnabled = true, github, store, onTickComplete, now = Date.now, intervalMinutes = core.POLL_INTERVAL_MINUTES, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn, clock, firstTickDelayMs, log } = dependencies;
  let viewer: string | null = null;
  let acceptedCandidates: MyPrsCandidatesPayload | null = null;
  const feedSilenceMs = dependencies.feedSilenceMs ?? (() => 0);
  let previousPrs: MyPr[] = [];
  let previousTruncatedNote: string | null = null;
  let pollingError: string | null = null;
  const autoRebaseByKey = new Map<string, MyPrAutoRebase>();
  let failedAutoRebaseAttempts = new Set<string>();
  const failedAutoRebaseRecordsByAttemptKey = new Map<string, MyPrAutoRebase>();
  const keepMergeableKeys = new Set<string>();
  const keepMergeableAttemptKeys = new Set<string>();
  const keepMergeableAttemptsByKey = new Map<string, MyPrKeepMergeableAttemptRecord>();
  const keepMergeablePushedHeadKeys = new Set<string>();
  let mergeQueueKeys: string[] = [];
  let stageSinceByKey = new Map<string, core.StageSinceRecord>();
  let latestStageObservationMs = Number.NEGATIVE_INFINITY;
  const attemptedMergeKeys = new Set<string>();
  const mergeFailuresByKey = new Map<string, { attemptKey: string; failure: MyPrMergeQueueFailure }>();
  const fixesInFlight = new Set<string>();
  const pendingFixes = new Set<Promise<void>>();
  const fixControllersByKey = new Map<string, AbortController>();
  const shutdownController = new AbortController();
  let stateLoad: Promise<void> | null = null;
  let isLeftoverSweepRunning = false;

  let hasLoadedState = false;

  function readCandidates() {
    const snapshot = store.getSnapshot();
    if (acceptedCandidates === null) return { items: [], viewer: null, error: snapshot.freshness.error, isLoaded: false, returnedCount: 0, totalCount: 0, isComplete: false };
    const listedPrs = [...acceptedCandidates.open, ...acceptedCandidates.merged];
    const listedKeys = listedPrs.map(comparablePrKey);
    const heldPrs: GithubPr[] = [];
    for (const listedPr of listedPrs) {
      const heldPr = snapshot.prs[comparablePrKey(listedPr)];
      if (heldPr !== undefined) heldPrs.push(core.heldOrListedPr(listedPr, heldPr));
    }
    const { viewer: listedViewer, returnedCount, totalCount, isComplete: isListComplete } = acceptedCandidates;
    const isComplete = isListComplete && heldPrs.length === new Set(listedKeys).size;
    return { items: heldPrs, viewer: listedViewer, error: snapshot.freshness.error, isLoaded: true, returnedCount, totalCount, isComplete };
  }

  function rebuild(): void {
    if (loop.isStopped() || !hasLoadedState) return;
    const snapshot = readCandidates();
    if (snapshot.isLoaded) {
      const rebuiltAtMs = now();
      const listedPrs = core.sortedMyPrs(snapshot.items.map((pr) => core.withAutoRebase(myPrFromGithubPr(pr), autoRebaseByKey.get(prKey(pr.repo, pr.number)))), rebuiltAtMs);
      previousPrs = withOperatorFlags(stampStageClock(listedPrs, rebuiltAtMs, snapshot.isComplete));
      previousTruncatedNote = core.truncatedSearchNote(snapshot.returnedCount, snapshot.totalCount);
    }
    publishStatus();
  }

  function stampStageClock(prs: MyPr[], observedAtMs: number, isComplete: boolean): MyPr[] {
    if (observedAtMs < latestStageObservationMs) return core.withStageSince(prs, stageSinceByKey);
    latestStageObservationMs = observedAtMs;
    const stamped = core.stampStageSince(stageSinceByKey, prs, observedAtMs, isComplete);
    stageSinceByKey = stamped.stageSinceByKey;
    if (stamped.hasChanged) void loop.persist();
    return stamped.prs;
  }

  async function loadState(): Promise<void> {
    if (stateLoad) return stateLoad;
    stateLoad = (async () => {
      const state = core.MyPrsLaneState.parse(await dependencies.readState?.() ?? core.emptyMyPrsLaneState());
      for (const key of state.failedAutoRebaseAttemptKeys ?? []) failedAutoRebaseAttempts.add(key);
      for (const { attemptKey, autoRebase } of state.failedAutoRebaseRecords ?? []) {
        if (failedAutoRebaseAttempts.has(attemptKey)) failedAutoRebaseRecordsByAttemptKey.set(attemptKey, autoRebase);
      }
      for (const key of state.keepMergeableKeys) keepMergeableKeys.add(key);
      for (const key of state.keepMergeableAttemptKeys) keepMergeableAttemptKeys.add(key);
      for (const key of state.keepMergeablePushedHeadKeys) keepMergeablePushedHeadKeys.add(key);
      for (const attempt of state.keepMergeableAttempts) keepMergeableAttemptsByKey.set(attempt.key, attempt);
      mergeQueueKeys = [...new Set(state.mergeQueueKeys)];
      stageSinceByKey = new Map((state.stageSince ?? []).map((record) => [record.key, record]));
      hasLoadedState = true;
    })();
    return stateLoad;
  }

  function publishStatus(): void {
    onTickComplete({
      ...core.myPrsStatus({ ts: now(), configured: true, viewer, prs: previousPrs, error: pollingError ?? store.getSnapshot().freshness.error, truncatedNote: previousTruncatedNote, isKeepMergeableEnabled, isMergeQueueEnabled }),
      ...loop.scheduleStatus(),
    });
  }

  async function writeCurrentState(): Promise<void> {
    await dependencies.writeState?.(core.MyPrsLaneState.parse({ keepMergeableKeys: [...keepMergeableKeys], keepMergeableAttemptKeys: [...keepMergeableAttemptKeys], mergeQueueKeys, keepMergeablePushedHeadKeys: [...keepMergeablePushedHeadKeys], keepMergeableAttempts: [...keepMergeableAttemptsByKey.values()], ...(failedAutoRebaseAttempts.size > 0 ? { failedAutoRebaseAttemptKeys: [...failedAutoRebaseAttempts] } : {}), ...(failedAutoRebaseRecordsByAttemptKey.size > 0 ? { failedAutoRebaseRecords: [...failedAutoRebaseRecordsByAttemptKey].map(([attemptKey, autoRebase]) => ({ attemptKey, autoRebase })) } : {}), ...(stageSinceByKey.size > 0 ? { stageSince: [...stageSinceByKey.values()] } : {}) }));
  }

  const loop = createTickLoop({
    tag: core.MY_PRS_LANE_ID, intervalMs: intervalMinutes * 60000, setIntervalFn, clearIntervalFn, clock: storeReadingLaneClock(clock), firstTickDelayMs, setTimeoutFn, clearTimeoutFn, now, quickRetries: true,
    rateLimitWaitMs: () => store.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES),
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
    const rateLimitWaitMs = await store.rateLimitWaitMs(now(), MY_PRS_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(errorText);
    return rateLimitWaitMs === null ? { failed: true, error: errorText } : { failed: true, retryAfterMs: rateLimitWaitMs, error: errorText };
  }
  async function runTick() {
    await loadState();
    if (loop.isStopped()) return { failed: false };
    const timestamp = now();
    const feedError = watcherFeedError('My pull requests has no pull request list', feedSilenceMs(), intervalMinutes * 60000);
    const snapshot = readCandidates();
    if (snapshot.error) return failedOutcome(snapshot.error);
    if (!snapshot.isLoaded) {
      pollingError = feedError;
      publishStatus();
      return { failed: false };
    }
    viewer = snapshot.viewer;
    const items = snapshot.items.map(myPrFromGithubPr);
    const prs: MyPr[] = [];
    failedAutoRebaseAttempts = core.prunedFailedAutoRebaseAttempts(failedAutoRebaseAttempts, items, failedAutoRebaseRecordsByAttemptKey, timestamp);
    for (const attemptKey of [...failedAutoRebaseRecordsByAttemptKey.keys()]) {
      if (!failedAutoRebaseAttempts.has(attemptKey)) failedAutoRebaseRecordsByAttemptKey.delete(attemptKey);
    }
    const rebasedThisTickKeys = new Set<string>();
    for (const canonicalPr of snapshot.items) {
      const node = myPrFromGithubPr(canonicalPr);
      const key = node.key;
      const behindBy = node.behindBy;
      const attemptKey = core.autoRebaseAttemptKey(node);
      const isFailedRecordReleased = autoRebaseByKey.get(key)?.outcome === 'failed' && !failedAutoRebaseAttempts.has(attemptKey);
      if (isFailedRecordReleased) autoRebaseByKey.delete(key);
      const failureFromBeforeRestart = failedAutoRebaseRecordsByAttemptKey.get(attemptKey);
      if (failureFromBeforeRestart && !autoRebaseByKey.has(key)) autoRebaseByKey.set(key, failureFromBeforeRestart);
      if (core.shouldRebaseMyPr({ ...node, rollupState: canonicalPr.rollupState }, behindBy, failedAutoRebaseAttempts, { isAutoRebaseOn: shouldAutoRebase, mergeQueueKeys: new Set(isMergeQueueEnabled ? mergeQueueKeys : []), keepMergeablePushedHeadKeys })) {
        const rebase = await github.rebasePr(canonicalPr.id, node.headRefOid);
        const rebaseRecord = core.autoRebaseRecord(rebase, node.baseRefName, now());
        if (!rebase.ok) {
          failedAutoRebaseAttempts.add(attemptKey);
          failedAutoRebaseRecordsByAttemptKey.set(attemptKey, rebaseRecord);
          await loop.persist();
        }
        if (loop.isStopped()) return { failed: false };
        if (rebase.ok) rebasedThisTickKeys.add(key);
        if (!rebase.ok) log?.warn(`[${core.MY_PRS_LANE_ID}] auto-rebase of ${key} failed: ${rebase.err.trim()}`);
        autoRebaseByKey.set(key, rebaseRecord);
      }
      prs.push(core.withAutoRebase(node, autoRebaseByKey.get(key)));
    }
    const listedKeys = new Set(prs.map((pr) => pr.key));
    for (const key of [...autoRebaseByKey.keys()]) {
      if (!listedKeys.has(key)) autoRebaseByKey.delete(key);
    }
    previousPrs = stampStageClock(core.sortedMyPrs(prs, timestamp), timestamp, snapshot.isComplete);
    pruneMergeFailures(timestamp);
    if (snapshot.isComplete) pruneKeepMergeableState(snapshot.returnedCount, snapshot.totalCount);
    if (isMergeQueueEnabled) mergeQueueKeys = core.prunedMergeQueueKeys({ mergeQueueKeys, prs, returnedCount: snapshot.returnedCount, totalCount: snapshot.totalCount, isComplete: snapshot.isComplete });
    previousPrs = withOperatorFlags(previousPrs);
    cancelFixes(core.keepMergeableFixesToCancel(fixControllersByKey.keys(), keepMergeableKeys, previousPrs));
    previousTruncatedNote = core.truncatedSearchNote(snapshot.returnedCount, snapshot.totalCount);
    pollingError = feedError;
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

  function pruneMergeFailures(nowMs: number): void {
    const currentAttemptKeys = new Set(previousPrs.map(core.mergeAttemptKey));
    for (const [key, { attemptKey, failure }] of [...mergeFailuresByKey]) {
      if (currentAttemptKeys.has(attemptKey) && !core.isFailedAttemptRetryDue(failure.at, nowMs)) continue;
      attemptedMergeKeys.delete(attemptKey);
      if (!currentAttemptKeys.has(attemptKey)) mergeFailuresByKey.delete(key);
    }
  }

  function currentMergeFailure(pr: MyPr, isQueued: boolean): MyPrMergeQueueFailure | undefined {
    const recorded = mergeFailuresByKey.get(pr.key);
    if (!isQueued || recorded?.attemptKey !== core.mergeAttemptKey(pr)) return undefined;
    return recorded.failure;
  }

  function withOperatorFlags(prs: MyPr[]): MyPr[] {
    const queuePositionByKey = core.mergeQueuePositions(mergeQueueKeys, prs);
    return prs.map((pr) => ({
      ...pr, mergeQueueFailure: currentMergeFailure(pr, queuePositionByKey.has(pr.key)), keepMergeableAttempt: core.currentKeepMergeableAttempt(pr, keepMergeableAttemptsByKey.get(pr.key)), isKeepMergeableFixInFlight: fixesInFlight.has(pr.key), keepMergeable: keepMergeableKeys.has(pr.key), mergeQueuePosition: queuePositionByKey.get(pr.key) ?? null,
      isMergeQueueHeldForRepairPush: queuePositionByKey.has(pr.key) && core.isHeadPushedByKeepMergeable(pr, keepMergeablePushedHeadKeys),
    }));
  }

  async function mergeQueuedPrs(rebasedThisTickKeys: ReadonlySet<string>): Promise<void> {
    const mergePr = dependencies.mergePr;
    if (!isMergeQueueEnabled || !mergePr) return;
    for (const pr of core.mergeQueuePrsToMerge(mergeQueueKeys, previousPrs, { attemptedMergeKeys, keepMergeablePushedHeadKeys, rebasedThisTickKeys })) {
      if (loop.isStopped()) return;
      if (!mergeQueueKeys.includes(pr.key)) continue;
      const attemptKey = core.mergeAttemptKey(pr);
      attemptedMergeKeys.add(attemptKey);
      const merged = await mergePr(pr);
      if (merged.ok) {
        mergeFailuresByKey.delete(pr.key);
        if (merged.kind === 'merged') mergeQueueKeys = mergeQueueKeys.filter((queuedKey) => queuedKey !== pr.key);
        continue;
      }
      const message = firstLine(merged.error ?? '') || 'GitHub refused the merge';
      mergeFailuresByKey.set(pr.key, { attemptKey, failure: { at: now(), message } });
      log?.warn(`[${core.MY_PRS_LANE_ID}] merge when ready for ${pr.key} failed and retries in an hour or at a new head: ${message}`);
    }
    previousPrs = withOperatorFlags(previousPrs);
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

  function forgetMergeFailure(key: string): void {
    const recorded = mergeFailuresByKey.get(key);
    if (!recorded) return;
    attemptedMergeKeys.delete(recorded.attemptKey);
    mergeFailuresByKey.delete(key);
  }

  async function setMergeWhenReady(request: MyPrMergeWhenReadyRequest): Promise<Omit<MyPrMergeWhenReadyResult, 'key'>> {
    if (!isMergeQueueEnabled) return { ok: false, error: 'Merge when ready is turned off in Settings' };
    const refusal = await toggleRefusal(request, request.mergeWhenReady);
    if (refusal) return { ok: false, error: refusal };
    const key = prKey(request.repo, request.number);
    if (request.mergeWhenReady) forgetMergeFailure(key);
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
    store.setWatchedKeys(core.MY_PRS_HELD_WATCH_OWNER, []);
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

  async function refresh() {
    if (loop.isStopped()) return { ok: false, error: 'Reviews polling is stopped.' };
    return loop.refresh(async () => {
      const refreshed = await store.refreshWatches([]);
      rebuild();
      return refreshed;
    });
  }

  function acceptCandidates(searched: MyPrsCandidatesPayload): void {
    if (isOlderObservation(searched, acceptedCandidates)) return;
    acceptedCandidates = searched;
    if (loop.isStopped()) return;
    store.setWatchedKeys(core.MY_PRS_HELD_WATCH_OWNER, [...searched.open, ...searched.merged].map(comparablePrKey));
    rebuild();
    if (hasLoadedState && !loop.isStopped()) loop.tickSoon();
  }

  return { start, stop, tick: loop.tick, refresh, rebuild, acceptCandidates, setKeepMergeable, setMergeWhenReady };
}
