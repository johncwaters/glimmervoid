import { viewerThreadTally, hasPresentableThreads, isThreadPlaceholderDraft, answeredViewerThreads, shouldAutoResolveThread, shouldJudgeThread, buildThreadJudgePrompt, parseThreadJudgeResult, threadJudgePatch, THREAD_JUDGE_BACKOFF_MS, THREAD_PLACEHOLDER_ERROR } from './core/team-review-threads-core.ts';
import * as core from './core/team-review-core.ts';
import { GITHUB_RATE_LIMIT_WINDOW_MS } from './core/github-rate-limit-core.ts';
import { secondaryRateLimitWaitMs } from './core/lane-backoff.ts';
import type { ReviewProgressEvent, ReviewTier, TeamReviewCandidate } from './core/team-review-core.ts';
import { firstLine } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { SharedClock, TickOutcome } from './lane-runner.ts';
import type { PrReference, PrReviewSnapshot, PrSearchResult, PrGh } from './pr-gh.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { hasStandingViewerApproval, ReviewDraft } from '../shared/contracts/team-review.ts';
import type {
  InFlightReview, PrDetail, PriorReview, ResumableReview, ReviewDraft as ReviewDraftType, TeamReviewState, TeamReviewStateEntry, TeamReviewStatus,
} from '../shared/contracts/team-review.ts';

const TEAM_REVIEW_RATE_LIMIT_RESOURCES = ['search', 'graphql', 'core'] as const;

interface TeamReviewGithub extends Partial<Pick<PrGh, 'teamReviewThreads' | 'resolveReviewThread' | 'teamReviewCompare'>> {
  viewer(): Promise<string | null>;
  teamMembers(org: string, team: string): Promise<string[]>;
  teamProfile(org: string, team: string): Promise<NonNullable<TeamReviewStatus['team']> | null>;
  searchTeamRequested(org: string, team: string): Promise<PrSearchResult>;
  searchDirectRequested(org: string): Promise<PrSearchResult>;
  searchAuthoredBy(org: string, logins: string[]): Promise<PrSearchResult>;
  viewPr(repo: string, number: number): Promise<PrDetail | null>;
  prHead(repo: string, number: number): Promise<string | null>;
  prReviewSnapshots(prs: readonly PrReference[]): Promise<Map<string, PrReviewSnapshot>>;
  rateLimitWaitMs(nowMs: number, resourceNames: readonly string[]): Promise<number | null>;
}

interface SpawnReviewArgs {
  candidate: TeamReviewCandidate;
  detail: PrDetail;
  tier: ReviewTier;
  reasons: string[];
  resume?: ResumableReview;
  priorReview?: PriorReview;
  reportProgress?: (event: ReviewProgressEvent) => void;
}

type ReviewOutcome = ReviewDraftType | { kind: 'stopped'; resumable: ResumableReview | null };

type DraftPatch = Partial<Omit<ReviewDraftType, 'key' | 'repo' | 'number'>>;

interface DraftExpectation {
  reviewedHead: ReviewDraftType['reviewedHead'];
  status: ReviewDraftType['status'];
}

interface TeamReviewPollerDependencies {
  org: string;
  team: string;
  github: TeamReviewGithub;
  judgeThread?: (prompt: string) => Promise<unknown>;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewOutcome>;
  discardResumable?: (record: ResumableReview) => Promise<void>;
  readState?: () => Promise<TeamReviewState>;
  writeState?: (state: TeamReviewState) => Promise<void>;
  beforeStart?: (keepPaths: ReadonlySet<string>) => Promise<void>;
  sandboxRefusal?: SandboxSpawnRefusal;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  clock?: SharedClock;
  firstTickDelayMs?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
  onTickComplete?: (status: TeamReviewStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  maxConcurrentReviews?: number;
  reReviewAfterMs?: number;
  skipIdleAfterMs?: number;
}

const REQUEUEABLE_STATUSES: ReadonlySet<ReviewDraftType['status']> = new Set(['error', 'ready', 'stale', 'discarded', 'posted']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTeamReviewPoller(deps: TeamReviewPollerDependencies) {
  const {
    org, team, github, spawnReview, discardResumable = async () => {},
    readState = async () => ({}), writeState = async () => {}, beforeStart = async () => {}, sandboxRefusal = allowSandboxedSpawn,
    setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = clearInterval,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = clearTimeout,
    log = console, onTickComplete = () => {}, now = () => Date.now(),
  } = deps;
  const maxConcurrentReviews = deps.maxConcurrentReviews ?? core.MAX_CONCURRENT_REVIEWS;
  const reReviewAfterMs = deps.reReviewAfterMs ?? core.DEFAULT_RE_REVIEW_AFTER_HOURS * 60 * 60 * 1000;
  const skipIdleAfterMs = deps.skipIdleAfterMs ?? core.DEFAULT_SKIP_IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  let state: TeamReviewState = {};
  let self: string | null = null;
  let teamProfile: TeamReviewStatus['team'] = null;
  const progressByKey = new Map<string, InFlightReview>();
  let waitingForSlot: TeamReviewCandidate[] = [];
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pendingProgressEmit: NodeJS.Timeout | null = null;
  let hasSlotFreedSinceSlotCount = false;
  let pollingError: string | null = null;

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
    rateLimitWaitMs: () => github.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES),
    writeState: () => writeState(state), setIntervalFn, clearIntervalFn, clock: deps.clock, firstTickDelayMs: deps.firstTickDelayMs, backoffMaxMs: GITHUB_RATE_LIMIT_WINDOW_MS, log,
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
      ts: now(), configured: true, reason: sandboxRefusal(), team: teamProfile, drafts: core.draftsNewestFirst(state), inFlight: inFlightReviews(),
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
    if (waitingForSlot.length > 0 && !loop.isStopped()) void loop.tick();
  }

  async function reviewSnapshotsFor(candidates: TeamReviewCandidate[]): Promise<Map<string, PrReviewSnapshot>> {
    const prs = candidates.filter((candidate) => !state[candidate.key]?.inFlight).map(({ repo, number }) => ({ repo, number }));
    if (prs.length === 0) return new Map();
    return github.prReviewSnapshots(prs);
  }

  async function headsToReview(candidates: TeamReviewCandidate[]): Promise<{ queue: TeamReviewCandidate[]; isDirty: boolean }> {
    const queue: TeamReviewCandidate[] = [];
    let isDirty = false;
    const snapshots = await reviewSnapshotsFor(candidates);
    for (const candidate of candidates) {
      let entry = state[candidate.key];
      if (entry?.inFlight) continue;
      const snapshot = snapshots.get(core.prKey(candidate.repo, candidate.number));
      if (!snapshot) continue;
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
      if (entry.skipReason === 'fork' && entry.reviewedHead === head && !core.isSameQueuedReview(entry.handReview, candidate)) {
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
    if (!github.teamReviewThreads || !github.resolveReviewThread) return false;
    const eligible = candidates.filter(({ key }) => {
      const entry = state[key];
      return entry?.githubReviews?.some((review) => review.isViewer) || entry?.draft?.status === 'posted';
    });
    if (eligible.length === 0) return false;
    const fetched = await github.teamReviewThreads(eligible);
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
      if (!deps.judgeThread || !github.teamReviewCompare || sandboxRefusal() !== null) continue;
      const pending = threads.filter((thread) => shouldJudgeThread(thread, head, now()))
        .sort((left, right) => (left.judgeAttempt?.retryAt ?? 0) - (right.judgeAttempt?.retryAt ?? 0));
      if (pending.length === 0) continue;
      const base = nodes.find((node) => node.id === pending[0].id)?.comments.nodes[0]?.originalCommit?.oid;
      const comparisonOutcome = base ? await github.teamReviewCompare(candidate.repo, base, head).catch((error: unknown) => ({ ok: false as const, err: errorMessage(error) })) : { ok: true as const, comparison: null };
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

  async function closedPostedKeys(candidateKeys: Set<string>): Promise<Set<string>> {
    const departedPosted = Object.entries(state).filter(([key, entry]) => !candidateKeys.has(key) && !entry.inFlight && entry.draft?.status === 'posted');
    if (departedPosted.length === 0) return new Set();
    const snapshots = await github.prReviewSnapshots(departedPosted.flatMap(([, entry]) => (entry.draft ? [{ repo: entry.draft.repo, number: entry.draft.number }] : [])));
    return new Set(departedPosted.filter(([key]) => snapshots.get(key)?.isOpen === false).map(([key]) => key));
  }

  async function pruneDeparted(candidateKeys: Set<string>): Promise<boolean> {
    let isDirty = false;
    const closedKeys = await closedPostedKeys(candidateKeys);
    for (const [key, entry] of Object.entries(state)) {
      if (!candidateKeys.has(key) && entry.resumable) {
        await discardResumable(entry.resumable);
        entry.resumable = null;
        isDirty = true;
      }
      if (!core.shouldPruneEntry(entry, candidateKeys.has(key), now(), closedKeys.has(key))) continue;
      delete state[key];
      isDirty = true;
    }
    return isDirty;
  }

  async function startReviews(queue: TeamReviewCandidate[]): Promise<boolean> {
    hasSlotFreedSinceSlotCount = false;
    let freeSlots = maxConcurrentReviews - inFlightKeys().length;
    let isDirty = false;
    waitingForSlot = [];
    for (const [index, candidate] of queue.entries()) {
      if (loop.isStopped()) break;
      if (freeSlots <= 0) {
        waitingForSlot = queue.slice(index);
        break;
      }
      const detail = await github.viewPr(candidate.repo, candidate.number);
      if (!detail) continue;
      const triage = core.triagePr(detail);
      const entry = entryFor(candidate.key);
      const resumeAction = core.resumeDecision(entry, detail.headRefOid, now());
      const resume = resumeAction === 'resume' ? entry.resumable ?? undefined : undefined;
      if (resumeAction === 'discard' && entry.resumable) await discardResumable(entry.resumable);
      if (resumeAction !== 'none') {
        entry.resumable = null;
        await persist();
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
      progressByKey.set(candidate.key, core.startReviewProgress({
        candidate, tier: triage.tier, reasons: triage.reasons, head: detail.headRefOid, at: now(), priorReviewedHead: priorReview?.head,
      }));
      const args: SpawnReviewArgs = {
        candidate, detail, tier: triage.tier, reasons: triage.reasons, resume, priorReview, reportProgress: progressReporter(candidate.key),
      };
      loop.track(runReview(args).catch((error: unknown) => {
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] review crashed for ${candidate.key}: ${errorMessage(error)}`);
      }));
    }
    return isDirty;
  }

  async function startReviewsUnlessSandboxRefused(queue: TeamReviewCandidate[]): Promise<boolean> {
    if (sandboxRefusal() === null) return startReviews(queue);
    waitingForSlot = [];
    return false;
  }

  async function collectCandidates(): Promise<{ candidates: TeamReviewCandidate[]; isComplete: boolean } | null> {
    if (teamProfile === null) teamProfile = await github.teamProfile(org, team);
    if (self === null) self = await github.viewer();
    const viewer = self;
    if (viewer === null) return null;
    const members = await github.teamMembers(org, team);
    if (members.length === 0) return null;
    const teammates = members.filter((login) => login.toLowerCase() !== viewer.toLowerCase());
    const directRequested = await github.searchDirectRequested(org);
    const requested = await github.searchTeamRequested(org, team);
    const authored = teammates.length > 0 ? await github.searchAuthoredBy(org, teammates) : { items: [], complete: true };
    const candidates = core.selectCandidates(directRequested.items, requested.items, authored.items, { self: viewer, nowMs: now(), skipIdleAfterMs });
    return { candidates, isComplete: directRequested.complete && requested.complete && authored.complete };
  }

  async function rateLimitedOutcome(): Promise<TickOutcome> {
    const rateLimitWaitMs = await github.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES) ?? secondaryRateLimitWaitMs(pollingError);
    return rateLimitWaitMs === null ? { failed: true } : { failed: true, retryAfterMs: rateLimitWaitMs };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    pollingError = null;
    const collected = await collectCandidates().catch((error: unknown) => {
      pollingError = errorMessage(error);
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] candidate search failed: ${pollingError}`);
      return null;
    });
    if (collected === null) {
      pollingError ??= 'Could not look up your GitHub account or team members.';
      return rateLimitedOutcome();
    }
    const { candidates, isComplete } = collected;
    const rateLimitWaitMs = isComplete ? null : await github.rateLimitWaitMs(now(), TEAM_REVIEW_RATE_LIMIT_RESOURCES);
    if (rateLimitWaitMs !== null) {
      pollingError = 'GitHub rate limit asks to wait.';
      return { failed: true, retryAfterMs: rateLimitWaitMs };
    }
    const isPruned = isComplete ? await pruneDeparted(new Set(candidates.map((candidate) => candidate.key))) : false;
    const planned = await headsToReview(candidates);
    const isStarted = await startReviewsUnlessSandboxRefused(planned.queue);
    const areThreadsChanged = await handleAnsweredThreads(candidates);
    if (isPruned || planned.isDirty || areThreadsChanged || isStarted) await persist();
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
    if (entry.draft.status === 'discarded') {
      entry.discardedReviewHead = entry.draft.reviewedHead;
      entry.draft = { ...entry.draft, status: 'stale' };
    }
    core.markDraftStale(entry, now());
    entry.updatedAt = now();
    await persist();
    emitStatus();
    return true;
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
    });
  }

  async function stop(): Promise<void> {
    cancelPendingProgressEmit();
    await loop.stop();
    cancelPendingProgressEmit();
  }

  return { start, stop, tick: loop.tick, refresh: loop.refresh, getDraft, updateDraft, updateThread, requeue, _state: () => state };
}

type TeamReviewPoller = ReturnType<typeof createTeamReviewPoller>;

export { createTeamReviewPoller };
export type { DraftExpectation, DraftPatch, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller, TeamReviewPollerDependencies };
