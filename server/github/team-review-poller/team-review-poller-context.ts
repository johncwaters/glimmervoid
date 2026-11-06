import type { GithubLaneStore } from '../github-store-wiring.ts';
import type { ThreadJudgeRequest } from '../core/team-review-threads-core.ts';
import type { ReviewProgressEvent, ReviewTier, TeamReviewCandidate, TeamReviewSettings } from '../core/team-review-core.ts';
import type { SharedClock, createTickLoop } from '../../lanes/lane-runner.ts';
import type { PrGh } from '../pr-gh.ts';
import type { Telemetry } from '../../telemetry.ts';
import type { InFlightReview, PrDetail, PriorReview, ResumableReview, ReviewDraft as ReviewDraftType, TeamReviewState, TeamReviewStatus } from '../../../shared/contracts/team-review.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../../../shared/timer-deps.ts';

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
  judgeThread?: (request: ThreadJudgeRequest) => Promise<unknown>;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewOutcome>;
  discardResumable?: (record: ResumableReview) => Promise<void>;
  readState?: () => Promise<TeamReviewState>;
  writeState?: (state: TeamReviewState) => Promise<void>;
  beforeStart?: (keepPaths: ReadonlySet<string>) => Promise<void>;
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

interface TeamReviewRuntime {
  state: TeamReviewState;
  self: string | null;
  teamProfile: TeamReviewStatus['team'];
  waitingForSlot: TeamReviewCandidate[];
  pollingError: string | null;
  tickRateLimitWaitMs: number | null;
  teamCandidateKeys: ReadonlySet<string>;
  hasLoadedState: boolean;
  hasSlotFreedSinceSlotCount: boolean;
}

interface TeamReviewPollerContext {
  deps: TeamReviewPollerDependencies;
  org: string;
  teams: TeamReviewSettings['teams'];
  github: TeamReviewGithub;
  store: GithubLaneStore;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewOutcome>;
  discardResumable: (record: ResumableReview) => Promise<void>;
  log: Pick<Console, 'warn'>;
  telemetry: Pick<Telemetry, 'capture'> | null;
  onTickComplete: (status: TeamReviewStatus) => void;
  now: () => number;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  maxConcurrentReviews: number;
  reReviewAfterMs: number;
  skipIdleAfterMs: number;
  runtime: TeamReviewRuntime;
  progressByKey: Map<string, InFlightReview>;
  reviewCancellersByKey: Map<string, AbortController>;
  notMineWhileReviewingKeys: Set<string>;
  loop: ReturnType<typeof createTickLoop>;
  persist: () => Promise<void>;
}

export { ASKED_FOR_WATCH_OWNER, REQUEUE_REFUSAL, REQUEUEABLE_STATUSES, TEAM_REVIEW_RATE_LIMIT_RESOURCES };
export type { DraftExpectation, DraftPatch, NotMineOutcome, ReviewOutcome, ReviewRequestOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPollerContext, TeamReviewPollerDependencies, TeamReviewRuntime };
