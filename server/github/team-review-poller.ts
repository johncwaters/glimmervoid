import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import { pullRequestKeyFromReference } from '../../shared/contracts/control-messages.ts';
import type { GithubLaneStore } from './github-store-wiring.ts';
import { storeReadingLaneClock } from './github-store-wiring.ts';
import { githubStoreRateLimitedError } from './github-store-poller.ts';
import type { GithubStoreRead } from './github-store-poller.ts';
import { viewerThreadTally, hasPresentableThreads, isThreadPlaceholderDraft, answeredViewerThreads, shouldAutoResolveThread, shouldJudgeThread, buildThreadJudgePrompt, parseThreadJudgeResult, threadJudgePatch, THREAD_JUDGE_BACKOFF_MS, THREAD_PLACEHOLDER_ERROR } from './core/team-review-threads-core.ts';
import * as core from './core/team-review-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from '../lanes/core/lane-backoff.ts';
import type { ReviewProgressEvent, ReviewTier, TeamReviewCandidate, TeamReviewSettings } from './core/team-review-core.ts';
import { firstLine } from '../lanes/ephemeral-session.ts';
import { createTickLoop } from '../lanes/lane-runner.ts';
import type { SharedClock, TickOutcome } from '../lanes/lane-runner.ts';
import type { PrGh } from './pr-gh.ts';
import type { Telemetry } from '../telemetry.ts';
import { allowGuardedSpawn } from '../guardrails/guardrails-deps.ts';
import type { GuardrailsSpawnRefusal } from '../guardrails/guardrails-deps.ts';
import { hasStandingViewerApproval, ReviewDraft } from '../../shared/contracts/team-review.ts';
import type {
  InFlightReview, PrDetail, PriorReview, ResumableReview, ReviewDraft as ReviewDraftType, TeamReviewState, TeamReviewStateEntry, TeamReviewStatus,
} from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../../shared/timer-deps.ts';

const TEAM_REVIEW_RATE_LIMIT_RESOURCES = ['search', 'graphql', 'core'] as const;

type TeamReviewGithub = Partial<Pick<PrGh, 'resolveReviewThread'>>;

interface SpawnReviewArgs {
  candidate: TeamReviewCandidate;
  detail: PrDetail;
  tier: ReviewTier;
  reasons: string[];
  resume?: ResumableReview;
  priorReview?: PriorReview;
  reportProgress?: (event: ReviewProgressEvent) => void;
  signal?: AbortSignal;
}

type ReviewOutcome = ReviewDraftType | { kind: 'stopped'; resumable: ResumableReview | null };

type DraftPatch = Partial<Omit<ReviewDraftType, 'key' | 'repo' | 'number'>>;

type NotMineOutcome = { ok: true } | { ok: false; error: string };

type ReviewRequestOutcome = { ok: true; key: string; status: 'queued' | 'running' } | { ok: false; error: string };

const ASKED_FOR_WATCH_OWNER = 'team-review-asked-for';
const REQUEUE_REFUSAL = 'only a failed, ready, stale, discarded or posted review can be queued again';

interface DraftExpectation {
  reviewedHead: ReviewDraftType['reviewedHead'];
  status: ReviewDraftType['status'];
}

interface TeamReviewPollerDependencies {
  org: string;
  teams: TeamReviewSettings['teams'];
  github: TeamReviewGithub;
  store: GithubLaneStore;
  judgeThread?: (prompt: string) => Promise<unknown>;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewOutcome>;
  discardResumable?: (record: ResumableReview) => Promise<void>;
  readState?: () => Promise<TeamReviewState>;
  writeState?: (state: TeamReviewState) => Promise<void>;
  beforeStart?: (keepPaths: ReadonlySet<string>) => Promise<void>;
  guardrailsRefusal?: GuardrailsSpawnRefusal;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  log?: Pick<Console, 'warn'>;
  telemetry?: Pick<Telemetry, 'capture'> | null;
  onTickComplete?: (status: TeamReviewStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  maxConcurrentReviews?: number;
  reReviewAfterMs?: number;
  skipIdleAfterMs?: number;
}

const REQUEUEABLE_STATUSES: ReadonlySet<ReviewDraftType['status']> = new Set(['error', 'ready', 'stale', 'discarded', 'posted']);

function createTeamReviewPoller(deps: TeamReviewPollerDependencies) {
  const {
    org, teams, github, store, spawnReview, discardResumable = async () => {},
    readState = async () => ({}), writeState = async () => {}, beforeStart = async () => {}, guardrailsRefusal = allowGuardedSpawn,
    setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn, clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
    setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn, clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
    log = console, telemetry = null, onTickComplete = () => {}, now = () => Date.now(),
  } = deps;
  const maxConcurrentReviews = deps.maxConcurrentReviews ?? core.MAX_CONCURRENT_REVIEWS;
  const reReviewAfterMs = deps.reReviewAfterMs ?? core.DEFAULT_RE_REVIEW_AFTER_HOURS * 60 * 60 * 1000;
  const skipIdleAfterMs = deps.skipIdleAfterMs ?? core.DEFAULT_SKIP_IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  let state: TeamReviewState = {};
  let self: string | null = null;
  let teamProfile: TeamReviewStatus['team'] = null;
  const progressByKey = new Map<string, InFlightReview>();
  const reviewCancellersByKey = new Map<string, AbortController>();
  const notMineWhileReviewingKeys = new Set<string>();
  let waitingForSlot: TeamReviewCandidate[] = [];
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pendingProgressEmit: NodeJS.Timeout | null = null;
  let hasSlotFreedSinceSlotCount = false;
  let pollingError: string | null = null;
  const watches = new Map<string, { qualifiers: string; source: 'direct' | 'team' | 'authored' }>();
  let hasLoadedState = false;
  let lastRebuildQueueSignature: string | null = null;
  let tickRateLimitWaitMs: number | null = null;
  let teamCandidateKeys: ReadonlySet<string> = new Set<string>();

  const loop = createTickLoop({
    tag: core.TEAM_REVIEW_LANE_ID, intervalMs: (deps.intervalMinutes ?? core.POLL_INTERVAL_MINUTES) * 60000,
    tick: async () => {
      try {
        return await runTick();
      } catch (error: unknown) {
        pollingError = errorMessage(error);
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] poll failed: ${pollingError}`);
        return rateLimitedOutcome();
      }
    },
    quickRetries: true, now, setTimeoutFn, clearTimeoutFn, onScheduleChange: emitStatus,
    rateLimitWaitMs: () => store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES),
    writeState: () => writeState(state), setIntervalFn, clearIntervalFn, clock: storeReadingLaneClock(deps.clock), firstTickDelayMs: deps.firstTickDelayMs, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
  });
  const persist = () => loop.persist();

  function inFlightKeys(): string[] {
    return Object.keys(state).filter((key) => state[key]?.inFlight);
  }

  function inFlightReviews(): InFlightReview[] {
    return inFlightKeys().flatMap((key) => {
      const progress = progressByKey.get(key);
      return progress ? [progress] : [];
    });
  }

  function cancelPendingProgressEmit(): void {
    if (pendingProgressEmit === null) return;
    clearTimeoutFn(pendingProgressEmit);
    pendingProgressEmit = null;
  }

  function emitStatus(): void {
    cancelPendingProgressEmit();
    lastEmitAt = now();
    onTickComplete({ ...core.teamReviewStatus({
      ts: now(), configured: true, reason: guardrailsRefusal(), team: teamProfile, drafts: core.draftsNewestFirst(state), inFlight: inFlightReviews(),
      handReview: core.handReviewRows(state),
      queued: waitingForSlot.filter((candidate) => !state[candidate.key]?.inFlight),
    }), error: pollingError, ...loop.scheduleStatus() });
  }

  function progressReporter(key: string): (event: ReviewProgressEvent) => void {
    return (event) => {
      const progress = progressByKey.get(key);
      if (!progress) return;
      progressByKey.set(key, core.applyReviewProgress(progress, event, now()));
      emitProgressCoalesced();
    };
  }

  function emitProgressCoalesced(): void {
    if (pendingProgressEmit !== null || loop.isStopped()) return;
    const waitMs = lastEmitAt + core.PROGRESS_EMIT_INTERVAL_MS - now();
    if (waitMs <= 0) {
      emitStatus();
      return;
    }
    pendingProgressEmit = setTimeoutFn(() => {
      pendingProgressEmit = null;
      if (loop.isStopped()) return;
      emitStatus();
    }, waitMs);
  }

  function entryFor(key: string): TeamReviewStateEntry {
    const existing = state[key];
    if (existing) return existing;
    const created: TeamReviewStateEntry = { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: now() };
    state[key] = created;
    return created;
  }

  async function runReview(args: SpawnReviewArgs): Promise<void> {
    const outcome = await spawnReview(args).catch((error: unknown) => core.errorDraft({
      candidate: args.candidate, tier: args.tier, reasons: args.reasons,
      reviewedHead: args.detail.headRefOid, error: firstLine(errorMessage(error)) || 'review crashed',
    }));
    const entry = entryFor(args.candidate.key);
    entry.inFlight = false;
    hasSlotFreedSinceSlotCount = true;
    progressByKey.delete(args.candidate.key);
    reviewCancellersByKey.delete(args.candidate.key);
    if (notMineWhileReviewingKeys.delete(args.candidate.key)) {
      await settleNotMineReview(entry, args, outcome);
      return;
    }
    if ('kind' in outcome) {
      if (outcome.resumable) entry.resumable = outcome.resumable;
      await persist();
      emitStatus();
      return;
    }
    const draft = outcome;
    const wasRequeuedAtReviewedHead = entry.requeuedHead === draft.reviewedHead;
    entry.resumable = null;
    if (draft.status !== 'error') {
      delete entry.requeuedHead;
      delete entry.discardedReviewHead;
    }
    entry.reviewAttempts = core.reviewAttemptsAfter(entry, draft.reviewedHead);
    entry.draft = {
      ...draft,
      ...(args.candidate.prCreatedAt ? { prCreatedAt: args.candidate.prCreatedAt } : {}),
      ...(args.priorReview ? { priorReviewedHead: args.priorReview.head } : {}),
      ...(wasRequeuedAtReviewedHead ? { requeuedHead: draft.reviewedHead } : {}),
    };
    entry.reviewedHead = draft.reviewedHead;
    entry.skipReason = null;
    entry.updatedAt = now();
    entry.reviewedAt = entry.updatedAt;
    entry.draft.reviewedAt = entry.reviewedAt;
    await persist();
    emitStatus();
    if (draft.status === 'ready') telemetry?.capture('team_review_drafted', { inline_comment_count: draft.comments.length });
    if (waitingForSlot.length > 0 && !loop.isStopped()) void loop.tick();
  }

  async function settleNotMineReview(entry: TeamReviewStateEntry, args: SpawnReviewArgs, outcome: ReviewOutcome): Promise<void> {
    if ('kind' in outcome && outcome.resumable) await discardResumable(outcome.resumable);
    entry.resumable = null;
    const hasFinishedReview = !('kind' in outcome) && outcome.status !== 'error';
    entry.draft = hasFinishedReview ? { ...outcome, status: 'discarded' } : core.notMineDraft(args.candidate, args.detail.headRefOid);
    entry.reviewedHead = entry.draft.reviewedHead;
    entry.skipReason = null;
    await settleNotMine(args.candidate.key, entry);
    if (waitingForSlot.length > 0 && !loop.isStopped()) void loop.tick();
  }

  function headsToReview(candidates: TeamReviewCandidate[]): { queue: TeamReviewCandidate[]; isDirty: boolean } {
    const queue: TeamReviewCandidate[] = [];
    let isDirty = false;
    const prs = store.getSnapshot().prs;
    for (const candidate of candidates) {
      let entry = state[candidate.key];
      if (entry?.inFlight) continue;
      const pr = prs[comparablePrKey(candidate)];
      if (!pr) continue;
      const snapshot = core.reviewSnapshotFromGithubPr(pr);
      const head = snapshot.head;
      const githubReviews = core.githubReviewsFrom(snapshot.reviews, self ?? '');
      const reviewDecision = snapshot.reviewDecision ?? null;
      candidate.reviewDecision = reviewDecision;
      candidate.isDraft = snapshot.isDraft;
      candidate.checksState = snapshot.checksState;
      const isReviewedByViewer = core.hasViewerReviewedAt(githubReviews, head) || hasStandingViewerApproval({ githubReviews, reviewDecision });
      if (!entry && !githubReviews.some((review) => review.isViewer)) {
        queue.push(candidate);
        continue;
      }
      if (!entry) {
        entry = entryFor(candidate.key);
        entry.reviewedHead = isReviewedByViewer ? head : null;
        isDirty = true;
      }
      if (entry.handReview && (entry.skipReason !== 'fork' || entry.reviewedHead !== head)) {
        delete entry.handReview;
        isDirty = true;
      }
      if (entry.skipReason === 'fork' && entry.reviewedHead === head && entry.draft?.status !== 'discarded' && !core.isSameQueuedReview(entry.handReview, candidate)) {
        entry.handReview = { ...candidate };
        isDirty = true;
      }
      if (entry.draft) {
        const priority = { requestSource: candidate.requestSource, isDraft: candidate.isDraft, checksState: candidate.checksState, reviewDecision };
        const previousPriority = { requestSource: entry.draft.requestSource, isDraft: entry.draft.isDraft, checksState: entry.draft.checksState, reviewDecision: entry.draft.reviewDecision ?? null };
        if (JSON.stringify(priority) !== JSON.stringify(previousPriority)) {
          entry.draft = { ...entry.draft, ...priority };
          isDirty = true;
        }
      }
      if (entry.draft && candidate.prCreatedAt && entry.draft.prCreatedAt !== candidate.prCreatedAt) {
        entry.draft.prCreatedAt = candidate.prCreatedAt;
        isDirty = true;
      }
      if (!core.isSameGithubReviews(entry.githubReviews, githubReviews)) {
        entry.githubReviews = githubReviews;
        isDirty = true;
      }
      if ((entry.reviewDecision ?? null) !== reviewDecision) {
        entry.reviewDecision = reviewDecision;
        isDirty = true;
      }
      if (entry.liveHead !== head) {
        entry.liveHead = head;
        isDirty = true;
      }
      const isRequeuePending = entry.requeuedHead !== undefined && entry.reviewedHead === null;
      if (isRequeuePending && entry.requeuedHead !== head) {
        entry.requeuedHead = head;
        isDirty = true;
      }
      if (core.restoreDraftAtReviewedHead(entry, head, now())) isDirty = true;
      const canAutoReview = core.shouldAutoReview(entry, head, now(), reReviewAfterMs);
      if (entry.reviewedHead !== head && entry.draft?.status === 'ready') entry.reviewedAt ??= entry.updatedAt;
      if (entry.reviewedHead !== head && core.markDraftStale(entry, now())) isDirty = true;
      if (!canAutoReview || (isReviewedByViewer && entry.requeuedHead !== head)) continue;
      queue.push(candidate);
    }
    return { queue, isDirty };
  }

  async function handleAnsweredThreads(candidates: TeamReviewCandidate[]): Promise<boolean> {
    if (!github.resolveReviewThread) return false;
    const eligible = candidates.filter(({ key }) => {
      const entry = state[key];
      return entry?.githubReviews?.some((review) => review.isViewer) || entry?.draft?.status === 'posted';
    });
    if (eligible.length === 0) return false;
    const fetchedRead = await store.requestTeamReviewThreads(eligible, 'no-wait');
    if (fetchedRead.isRateLimited) {
      tickRateLimitWaitMs = fetchedRead.waitMs;
      return false;
    }
    const fetched = fetchedRead.value;
    let isDirty = false;
    for (const candidate of eligible) {
      if (loop.isStopped()) break;
      const entry = state[candidate.key];
      const nodes = fetched.get(candidate.key);
      const head = entry?.liveHead;
      if (!entry || !nodes || !head) continue;
      const viewerThreads = viewerThreadTally(nodes);
      if (viewerThreads.total !== entry.viewerThreads?.total || viewerThreads.resolved !== entry.viewerThreads?.resolved) {
        entry.viewerThreads = viewerThreads;
        isDirty = true;
      }
      const threads = answeredViewerThreads(nodes, entry.threads ?? [], head, entry.autoResolvedThreadIds);
      if (JSON.stringify(threads) !== JSON.stringify(entry.threads)) isDirty = true;
      entry.threads = threads;
      for (const thread of threads) {
        if (loop.isStopped()) break;
        if (!shouldAutoResolveThread(thread)) continue;
        thread.resolveAttemptReplyAt = thread.lastReplyAt;
        isDirty = true;
        await persist();
        const resolution = await github.resolveReviewThread(thread.id).catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
        if (resolution.ok) {
          thread.isResolved = true;
          viewerThreads.resolved += 1;
          entry.viewerThreads = viewerThreads;
          entry.autoResolvedThreadIds = [...(entry.autoResolvedThreadIds ?? []), thread.id];
        }
        if (!resolution.ok) thread.resolveError = resolution.err || 'GitHub refused to resolve the thread';
      }
      if (reconcileThreadPlaceholder(entry, candidate, head)) isDirty = true;
      if (!deps.judgeThread || guardrailsRefusal() !== null) continue;
      const pending = threads.filter((thread) => shouldJudgeThread(thread, head, now()))
        .sort((left, right) => (left.judgeAttempt?.retryAt ?? 0) - (right.judgeAttempt?.retryAt ?? 0));
      if (pending.length === 0) continue;
      const base = nodes.find((node) => node.id === pending[0].id)?.comments.nodes[0]?.originalCommit?.oid;
      const comparisonRead = base ? await store.requestTeamReviewCompare(candidate.repo, base, head, 'no-wait') : { isRateLimited: false as const, value: { ok: true as const, comparison: null } };
      if (comparisonRead.isRateLimited) {
        tickRateLimitWaitMs = comparisonRead.waitMs;
        return isDirty;
      }
      const comparisonOutcome = comparisonRead.value;
      for (const thread of pending) {
        if (loop.isStopped()) break;
        const node = nodes.find((node) => node.id === thread.id);
        if (!node || node.comments.nodes[0]?.originalCommit?.oid !== base) continue;
        thread.judgeAttempt = { head, lastReplyAt: thread.lastReplyAt, retryAt: now() + THREAD_JUDGE_BACKOFF_MS };
        isDirty = true;
        await persist();
        if (!comparisonOutcome.ok) continue;
        const evidence = threadJudgePatch(node, comparisonOutcome.comparison);
        if ('unjudgeableReason' in evidence) {
          thread.unjudgeable = { head, lastReplyAt: thread.lastReplyAt, reason: evidence.unjudgeableReason };
          delete thread.judgeAttempt;
          continue;
        }
        emitStatus();
        const raw = await deps.judgeThread(buildThreadJudgePrompt(node, head, evidence.patch)).catch(() => null);
        const judgement = parseThreadJudgeResult(raw);
        if (judgement && state[candidate.key] === entry && entry.liveHead === head && entry.threads?.includes(thread)) {
          thread.judgement = { ...judgement, head, lastReplyAt: thread.lastReplyAt, judgedAt: now() };
          delete thread.judgeAttempt;
        }
        await persist();
        emitStatus();
      }
    }
    return isDirty;
  }

  function reconcileThreadPlaceholder(entry: TeamReviewStateEntry, candidate: TeamReviewCandidate, head: string): boolean {
    const isPresentable = hasPresentableThreads(entry.threads ?? []);
    if (!entry.draft && isPresentable) {
      entry.draft = { ...core.errorDraft({ candidate, tier: 'full', reasons: [], reviewedHead: head, error: THREAD_PLACEHOLDER_ERROR }), summary: '' };
      return true;
    }
    if (!isPresentable && isThreadPlaceholderDraft(entry.draft)) {
      entry.draft = null;
      return true;
    }
    return false;
  }

  function closedEntryKeys(): Set<string> {
    const prs = store.getSnapshot().prs;
    return new Set(Object.keys(state).filter((key) => {
      const pr = prs[key.toLowerCase()];
      return !state[key]?.inFlight && pr !== undefined && pr.state !== 'OPEN';
    }));
  }

  function watchDeparted(candidateKeys: Set<string>): void {
    const departedKeys = Object.keys(state).filter((key) => !candidateKeys.has(key) && !state[key]?.inFlight);
    store.setWatchedKeys('team-review-departed', departedKeys.map((key) => key.toLowerCase()));
  }

  async function pruneDeparted(candidateKeys: Set<string>, isComplete: boolean): Promise<boolean> {
    let isDirty = false;
    watchDeparted(candidateKeys);
    const closedKeys = closedEntryKeys();
    for (const [key, entry] of Object.entries(state)) {
      const isClosed = closedKeys.has(key);
      if (candidateKeys.has(key) || (!isComplete && !isClosed)) continue;
      if (entry.resumable) {
        await discardResumable(entry.resumable);
        entry.resumable = null;
        isDirty = true;
      }
      if (!core.shouldPruneEntry(entry, false, now(), isClosed)) continue;
      delete state[key];
      isDirty = true;
    }
    return isDirty;
  }

  function leaveSlotQueue(key: string): void {
    waitingForSlot = waitingForSlot.filter((queued) => queued.key !== key);
  }

  async function readCandidateDetail(candidate: TeamReviewCandidate): Promise<GithubStoreRead<PrDetail | null>> {
    const snapshotHead = store.getSnapshot().prs[comparablePrKey(candidate)]?.headRefOid;
    const headRead = snapshotHead ? { isRateLimited: false as const, value: snapshotHead } : await store.requestPrHead(candidate.repo, candidate.number, 'no-wait');
    if (headRead.isRateLimited) return headRead;
    if (headRead.value === null) return { isRateLimited: false, value: null };
    return store.requestPrView(candidate.repo, candidate.number, headRead.value, 'no-wait');
  }

  async function startReviews(queue: TeamReviewCandidate[]): Promise<boolean> {
    hasSlotFreedSinceSlotCount = false;
    let freeSlots = maxConcurrentReviews - inFlightKeys().length;
    let isDirty = false;
    waitingForSlot = queue.filter((queued) => state[queued.key]?.draft?.status !== 'discarded');
    for (const candidate of queue) {
      if (loop.isStopped()) {
        waitingForSlot = [];
        break;
      }
      if (freeSlots <= 0) break;
      const detailRead = await readCandidateDetail(candidate);
      if (detailRead.isRateLimited) {
        tickRateLimitWaitMs = detailRead.waitMs;
        break;
      }
      const detail = detailRead.value;
      if (!detail) {
        leaveSlotQueue(candidate.key);
        continue;
      }
      const triage = core.triagePr(detail);
      const entry = entryFor(candidate.key);
      const resumeAction = core.resumeDecision(entry, detail.headRefOid, now());
      const resume = resumeAction === 'resume' ? entry.resumable ?? undefined : undefined;
      if (resumeAction === 'discard' && entry.resumable) await discardResumable(entry.resumable);
      if (resumeAction !== 'none') {
        entry.resumable = null;
        await persist();
      }
      leaveSlotQueue(candidate.key);
      if (entry.draft?.status === 'discarded') {
        if (resume) await discardResumable(resume);
        continue;
      }
      entry.updatedAt = now();
      delete entry.handReview;
      isDirty = true;
      if (triage.tier === 'skip') {
        if (resume) await discardResumable(resume);
        entry.reviewedHead = detail.headRefOid;
        entry.liveHead = detail.headRefOid;
        entry.skipReason = triage.reasons.join(', ') || 'skipped';
        if (triage.reasons.includes('fork')) entry.handReview = { ...candidate };
        delete entry.requeuedHead;
        continue;
      }
      entry.skipReason = null;
      const priorReview = core.priorReviewFor(entry, detail.headRefOid) ?? undefined;
      const earlierReviewKept = core.earlierReviewToKeep(entry, detail.headRefOid);
      delete entry.priorReview;
      if (earlierReviewKept) entry.priorReview = earlierReviewKept;
      entry.inFlight = true;
      freeSlots -= 1;
      const reviewCanceller = new AbortController();
      reviewCancellersByKey.set(candidate.key, reviewCanceller);
      progressByKey.set(candidate.key, core.startReviewProgress({
        candidate, tier: triage.tier, reasons: triage.reasons, head: detail.headRefOid, at: now(), priorReviewedHead: priorReview?.head,
      }));
      const args: SpawnReviewArgs = {
        candidate, detail, tier: triage.tier, reasons: triage.reasons, resume, priorReview, reportProgress: progressReporter(candidate.key), signal: reviewCanceller.signal,
      };
      loop.track(runReview(args).catch((error: unknown) => {
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] review crashed for ${candidate.key}: ${errorMessage(error)}`);
      }));
    }
    return isDirty;
  }

  async function startReviewsUnlessGuardrailsRefused(queue: TeamReviewCandidate[]): Promise<boolean> {
    if (guardrailsRefusal() === null) return startReviews(queue);
    waitingForSlot = [];
    return false;
  }

  async function collectCandidates(): Promise<{ candidates: TeamReviewCandidate[]; isComplete: boolean } | null> {
    const firstTeam = teams[0];
    if (!firstTeam) {
      unregisterWatches();
      return null;
    }
    if (teamProfile === null) {
      const profileRead = await store.requestTeamProfile(firstTeam.org, firstTeam.slug, 'no-wait');
      if (profileRead.isRateLimited) { tickRateLimitWaitMs = profileRead.waitMs; return null; }
      teamProfile = profileRead.value;
    }
    if (self === null) {
      const viewerRead = await store.requestViewer('no-wait');
      if (viewerRead.isRateLimited) { tickRateLimitWaitMs = viewerRead.waitMs; return null; }
      self = viewerRead.value;
    }
    const viewer = self;
    if (viewer === null) return null;
    const memberLists: (string[] | null)[] = [];
    for (const team of teams) {
      const membersRead = await store.requestTeamMembers(team.org, team.slug, 'no-wait');
      if (membersRead.isRateLimited) { tickRateLimitWaitMs = membersRead.waitMs; return null; }
      memberLists.push(membersRead.value);
    }
    const isMembershipComplete = memberLists.every((members) => members !== null);
    const fetchedMemberLists = memberLists.map((members) => members ?? []);
    if (fetchedMemberLists.every((members) => members.length === 0)) {
      if (isMembershipComplete) unregisterWatches();
      return null;
    }
    if (loop.isStopped()) return null;
    const searchPlans = core.orgSearchPlans(org, teams, fetchedMemberLists, viewer);
    registerWatches(searchPlans);
    const collected = candidatesFromSnapshot(viewer);
    teamCandidateKeys = collected.teamCandidateKeys;
    return { candidates: collected.candidates, isComplete: isMembershipComplete && collected.isComplete };
  }

  function registerWatches(searchPlans: ReturnType<typeof core.orgSearchPlans>): void {
    const nextWatches = new Map<string, { qualifiers: string; source: 'direct' | 'team' | 'authored' }>();
    for (const plan of searchPlans) {
      nextWatches.set(`team-review-direct:${plan.org.toLowerCase()}`, { qualifiers: `is:open draft:false org:${plan.org} user-review-requested:@me`, source: 'direct' });
      for (let index = 0; index < plan.authors.length; index += 5) {
        const authors = plan.authors.slice(index, index + 5).map((author) => `author:${author}`).join(' ');
        nextWatches.set(`team-review-authored:${plan.org.toLowerCase()}:${index / 5}`, { qualifiers: `is:open draft:false org:${plan.org} ${authors}`, source: 'authored' });
      }
    }
    for (const team of teams) {
      nextWatches.set(`team-review-team:${team.org.toLowerCase()}/${team.slug.toLowerCase()}`, { qualifiers: `is:open draft:false org:${team.org} team-review-requested:${team.org}/${team.slug}`, source: 'team' });
    }
    for (const name of watches.keys()) {
      if (!nextWatches.has(name)) store.unregisterWatch(name);
    }
    for (const [name, watch] of nextWatches) {
      if (watches.get(name)?.qualifiers !== watch.qualifiers) store.registerWatch({ name, qualifiers: watch.qualifiers, needsDetail: true });
    }
    watches.clear();
    for (const [name, watch] of nextWatches) watches.set(name, watch);
  }

  function askedForKeys(): string[] {
    return Object.keys(state).filter((key) => state[key]?.requestedAt !== undefined);
  }

  function isTeamCandidate(key: string): boolean {
    return teamCandidateKeys.has(key.toLowerCase());
  }

  function askedForSlotsInUse(): number {
    return askedForKeys().filter((key) => state[key]?.draft?.status !== 'posted' && !isTeamCandidate(key)).length;
  }

  function watchAskedFor(): void {
    store.setWatchedKeys(ASKED_FOR_WATCH_OWNER, askedForKeys());
  }

  function candidatesFromSnapshot(viewer: string): { candidates: TeamReviewCandidate[]; teamCandidateKeys: ReadonlySet<string>; isComplete: boolean } {
    const snapshot = store.getSnapshot();
    let isAskedForComplete = true;
    const askedFor = askedForKeys().flatMap((key) => {
      const pr = snapshot.prs[key.toLowerCase()];
      if (pr) return [pr];
      const requestedAt = state[key]?.requestedAt ?? 0;
      if (now() - requestedAt < core.ASKED_FOR_FETCH_GRACE_MS) isAskedForComplete = false;
      return [];
    });
    const prsBySource: Record<'direct' | 'team' | 'authored', (typeof snapshot.prs)[string][]> = { direct: [], team: [], authored: [] };
    let isComplete = true;
    for (const [name, { source }] of watches) {
      const watch = snapshot.watches[name];
      if (!watch?.isLoaded || !watch.isComplete) isComplete = false;
      for (const key of watch?.keys ?? []) {
        const pr = snapshot.prs[key];
        if (!pr) {
          isComplete = false;
          continue;
        }
        prsBySource[source].push(pr);
      }
    }
    const selected = core.selectCandidates(prsBySource.direct, prsBySource.team, prsBySource.authored, { self: viewer, nowMs: now(), skipIdleAfterMs, askedFor });
    return { ...selected, isComplete: isComplete && isAskedForComplete };
  }

  function rebuild(): void {
    if (!hasLoadedState || loop.isStopped() || self === null) return;
    const collected = candidatesFromSnapshot(self);
    teamCandidateKeys = collected.teamCandidateKeys;
    const { candidates } = collected;
    const planned = headsToReview(candidates);
    if (planned.isDirty) loop.track(persist());
    emitStatus();
    if (closedEntryKeys().size > 0) {
      loop.tickSoon();
      return;
    }
    if (planned.queue.length === 0 || !canStartReview()) return;
    const queueSignature = queuedHeadsSignature(planned.queue);
    if (queueSignature === lastRebuildQueueSignature) return;
    lastRebuildQueueSignature = queueSignature;
    loop.tickSoon();
  }

  function canStartReview(): boolean {
    return guardrailsRefusal() === null && inFlightKeys().length < maxConcurrentReviews;
  }

  function queuedHeadsSignature(queue: readonly TeamReviewCandidate[]): string {
    const prs = store.getSnapshot().prs;
    return JSON.stringify(queue.map((candidate) => [candidate.key, prs[comparablePrKey(candidate)]?.headRefOid ?? null]));
  }

  async function rateLimitedOutcome(): Promise<TickOutcome> {
    const rateLimitWaitMs = await store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(pollingError);
    return rateLimitWaitMs === null ? { failed: true, error: pollingError ?? undefined } : { failed: true, retryAfterMs: rateLimitWaitMs, error: pollingError ?? undefined };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    pollingError = null;
    tickRateLimitWaitMs = null;
    const collected = await collectCandidates().catch((error: unknown) => {
      pollingError = errorMessage(error);
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] candidate search failed: ${pollingError}`);
      return null;
    });
    if (tickRateLimitWaitMs !== null) {
      pollingError = 'GitHub rate limit asks to wait.';
      return { failed: true, retryAfterMs: tickRateLimitWaitMs, error: pollingError };
    }
    if (collected === null) {
      pollingError ??= 'Could not look up your GitHub account or team members.';
      return rateLimitedOutcome();
    }
    const storeError = store.getSnapshot().freshness.error;
    if (storeError) {
      pollingError = storeError;
      return rateLimitedOutcome();
    }
    const { candidates, isComplete } = collected;
    const rateLimitWaitMs = isComplete ? null : await store.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES);
    if (rateLimitWaitMs !== null) {
      pollingError = 'GitHub rate limit asks to wait.';
      return { failed: true, retryAfterMs: rateLimitWaitMs, error: pollingError };
    }
    const isPruned = await pruneDeparted(new Set(candidates.map((candidate) => candidate.key)), isComplete);
    if (isPruned) watchAskedFor();
    const planned = headsToReview(candidates);
    const isStarted = await startReviewsUnlessGuardrailsRefused(planned.queue);
    const areThreadsChanged = tickRateLimitWaitMs === null ? await handleAnsweredThreads(candidates) : false;
    if (isPruned || planned.isDirty || areThreadsChanged || isStarted) await persist();
    if (tickRateLimitWaitMs !== null) {
      pollingError = 'GitHub rate limit asks to wait.';
      return { failed: true, retryAfterMs: tickRateLimitWaitMs, error: pollingError };
    }
    if (hasSlotFreedSinceSlotCount && waitingForSlot.length > 0 && !loop.isStopped()) {
      setTimeoutFn(() => { void loop.tick(); }, 0);
    }
    return undefined;
  }

  function getDraft(key: string): ReviewDraftType | null {
    const entry = state[key];
    if (!entry?.draft) return null;
    return { ...entry.draft, threads: entry.threads, viewerThreads: entry.viewerThreads, liveHead: entry.liveHead ?? entry.draft.liveHead };
  }

  async function updateDraft(key: string, expected: DraftExpectation, patch: DraftPatch): Promise<ReviewDraftType | null> {
    const entry = state[key];
    if (!entry?.draft) return null;
    if (entry.draft.reviewedHead !== expected.reviewedHead || entry.draft.status !== expected.status) return null;
    const postedAt = patch.status === 'posted' ? { postedAt: now() } : {};
    const parsed = ReviewDraft.safeParse({ ...entry.draft, ...patch, ...postedAt, key: entry.draft.key, repo: entry.draft.repo, number: entry.draft.number });
    if (!parsed.success) return null;
    entry.draft = parsed.data;
    entry.updatedAt = now();
    await persist();
    emitStatus();
    return parsed.data;
  }

  async function updateThread(key: string, threadId: string, patch: { isResolved?: boolean; resolveError?: string }): Promise<boolean> {
    const entry = state[key];
    const thread = entry?.threads?.find((thread) => thread.id === threadId);
    if (!entry || !thread) return false;
    Object.assign(thread, patch);
    if (patch.isResolved) delete thread.resolveError;
    if (!hasPresentableThreads(entry.threads ?? []) && isThreadPlaceholderDraft(entry.draft)) entry.draft = null;
    await persist();
    emitStatus();
    return true;
  }

  async function requeue(key: string, head: string): Promise<boolean> {
    const entry = state[key];
    if (!entry?.draft || entry.inFlight || entry.draft.reviewedHead !== head) return false;
    if (!REQUEUEABLE_STATUSES.has(entry.draft.status)) return false;
    entry.reviewAttempts = 0;
    entry.reviewedHead = null;
    entry.requeuedHead = entry.liveHead ?? head;
    if (core.isUnreviewedDraft(entry.draft)) entry.draft = null;
    if (entry.draft?.status === 'discarded') {
      entry.discardedReviewHead = entry.draft.reviewedHead;
      entry.draft = { ...entry.draft, status: 'stale' };
    }
    core.markDraftStale(entry, now());
    entry.updatedAt = now();
    await persist();
    emitStatus();
    loop.tickSoon();
    return true;
  }

  function cancelReviewAsNotMine(key: string): NotMineOutcome {
    notMineWhileReviewingKeys.add(key);
    reviewCancellersByKey.get(key)?.abort();
    return { ok: true };
  }

  async function markNotMine(key: string): Promise<NotMineOutcome> {
    const entry = state[key];
    if (entry?.inFlight) return cancelReviewAsNotMine(key);
    if (entry?.draft?.status === 'posted') return { ok: false, error: 'That review was already posted' };
    if (entry?.draft && !isThreadPlaceholderDraft(entry.draft)) {
      entry.draft = { ...entry.draft, status: 'discarded' };
      return settleNotMine(key, entry);
    }
    const candidate = waitingForSlot.find((queued) => queued.key === key) ?? entry?.handReview ?? entry?.draft ?? undefined;
    if (!candidate) return { ok: false, error: 'That pull request is no longer in the review queue' };
    const knownHead = entry?.liveHead ?? store.getSnapshot().prs[comparablePrKey(candidate)]?.headRefOid;
    const headRead = knownHead ? { isRateLimited: false as const, value: knownHead } : await store.requestPrHead(candidate.repo, candidate.number, 'no-wait');
    if (headRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(headRead.waitMs) };
    const head = headRead.value;
    if (!head) return { ok: false, error: 'Could not read the pull request head from GitHub' };
    if (state[key]?.inFlight) return cancelReviewAsNotMine(key);
    const notMineEntry = entryFor(key);
    notMineEntry.draft = core.notMineDraft(candidate, head);
    notMineEntry.reviewedHead = head;
    delete notMineEntry.handReview;
    return settleNotMine(key, notMineEntry);
  }

  async function settleNotMine(key: string, entry: TeamReviewStateEntry): Promise<NotMineOutcome> {
    delete entry.requeuedHead;
    delete entry.requestedAt;
    watchAskedFor();
    entry.updatedAt = now();
    waitingForSlot = waitingForSlot.filter((queued) => queued.key !== key);
    const abandonedResumable = entry.resumable;
    if (abandonedResumable) {
      entry.resumable = null;
      await discardResumable(abandonedResumable);
    }
    await persist();
    emitStatus();
    return { ok: true };
  }

  async function markAskedFor(key: string, entry: TeamReviewStateEntry): Promise<void> {
    if (!isTeamCandidate(key)) entry.requestedAt ??= now();
    entry.updatedAt = now();
    watchAskedFor();
    await persist();
    emitStatus();
    loop.tickSoon();
  }

  async function requestKnownReview(key: string, entry: TeamReviewStateEntry): Promise<ReviewRequestOutcome> {
    if (entry.inFlight) return { ok: true, key, status: 'running' };
    if (entry.skipReason && entry.reviewedHead !== null && entry.reviewedHead === entry.liveHead) {
      return { ok: false, error: `team review skips this pull request: ${entry.skipReason}` };
    }
    if (entry.draft && !isThreadPlaceholderDraft(entry.draft)) {
      if (!await requeue(key, entry.draft.reviewedHead)) return { ok: false, error: REQUEUE_REFUSAL };
      await markAskedFor(key, entry);
      return { ok: true, key, status: 'queued' };
    }
    if (entry.reviewedHead !== null) {
      entry.reviewedHead = null;
      entry.reviewAttempts = 0;
      if (entry.liveHead) entry.requeuedHead = entry.liveHead;
    }
    await markAskedFor(key, entry);
    return { ok: true, key, status: 'queued' };
  }

  async function requestReview(reference: { repo: string; number: number }): Promise<ReviewRequestOutcome> {
    if (loop.isStopped() || !hasLoadedState) return { ok: false, error: 'Team review is not running' };
    const findKnownKey = () => Object.keys(state).find((key) => key.toLowerCase() === comparablePrKey(reference));
    const knownKey = findKnownKey();
    const knownEntry = knownKey === undefined ? undefined : state[knownKey];
    if (knownKey !== undefined && knownEntry) return requestKnownReview(knownKey, knownEntry);
    if (!isTeamCandidate(comparablePrKey(reference)) && askedForSlotsInUse() >= core.MAX_ASKED_FOR_REVIEWS) {
      return { ok: false, error: `at most ${core.MAX_ASKED_FOR_REVIEWS} pull requests outside your teams can wait for a review at once, and one frees when its review is posted or the operator marks it Not mine in the Reviews tab` };
    }
    const label = core.prKey(reference.repo, reference.number);
    const headRead = await store.requestPrHead(reference.repo, reference.number, 'no-wait');
    if (headRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(headRead.waitMs) };
    if (headRead.value === null) return { ok: false, error: `could not read ${label} from GitHub` };
    const detailRead = await store.requestPrView(reference.repo, reference.number, headRead.value, 'no-wait');
    if (detailRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(detailRead.waitMs) };
    const detail = detailRead.value;
    if (!detail) return { ok: false, error: `could not read ${label} from GitHub` };
    const refusal = core.askedForRefusal(detail, self);
    if (refusal) return { ok: false, error: `${label} cannot be reviewed: ${refusal}` };
    const raceKey = findKnownKey();
    const raceEntry = raceKey === undefined ? undefined : state[raceKey];
    if (raceKey !== undefined && raceEntry) return requestKnownReview(raceKey, raceEntry);
    const key = pullRequestKeyFromReference(detail.url) ?? label;
    const entry = entryFor(key);
    entry.liveHead = detail.headRefOid;
    entry.requeuedHead = detail.headRefOid;
    await markAskedFor(key, entry);
    return { ok: true, key, status: 'queued' };
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      state = (await readState()) || {};
      for (const entry of Object.values(state)) entry.inFlight = false;
      progressByKey.clear();
      emitStatus();
      const keepPaths = new Set<string>();
      for (const entry of Object.values(state)) {
        if (!entry.resumable) continue;
        keepPaths.add(entry.resumable.workDir);
        keepPaths.add(entry.resumable.worktreePath);
      }
      await beforeStart(keepPaths);
      hasLoadedState = true;
      watchAskedFor();
    });
  }

  function unregisterWatches(): void {
    for (const name of watches.keys()) store.unregisterWatch(name);
    watches.clear();
    store.setWatchedKeys('team-review-departed', []);
    store.setWatchedKeys(ASKED_FOR_WATCH_OWNER, []);
  }

  async function refresh() {
    if (loop.isStopped()) return { ok: false, error: 'Reviews polling is stopped.' };
    if (watches.size === 0) await collectCandidates();
    return loop.refresh(async () => {
      const refreshed = await store.refreshWatches([...watches.keys()]);
      rebuild();
      return refreshed;
    });
  }

  async function stop(): Promise<void> {
    hasLoadedState = false;
    unregisterWatches();
    cancelPendingProgressEmit();
    await loop.stop();
    cancelPendingProgressEmit();
  }

  return { start, stop, tick: loop.tick, refresh, rebuild, getDraft, updateDraft, updateThread, requeue, requestReview, markNotMine, _state: () => state };
}

type TeamReviewPoller = ReturnType<typeof createTeamReviewPoller>;

export { createTeamReviewPoller };
export type { DraftExpectation, DraftPatch, NotMineOutcome, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller };
