import * as core from './core/team-review-core.ts';
import type { ReviewTier, TeamReviewCandidate } from './core/team-review-core.ts';
import { firstLine } from './ephemeral-session.ts';
import { createTickLoop } from './lane-runner.ts';
import type { TickOutcome } from './lane-runner.ts';
import type { PrSearchResult } from './pr-gh.ts';
import { ReviewDraft } from '../shared/contracts/team-review.ts';
import type {
  PrDetail, ReviewDraft as ReviewDraftType, TeamReviewState, TeamReviewStateEntry, TeamReviewStatus,
} from '../shared/contracts/team-review.ts';

interface TeamReviewGithub {
  viewer(): Promise<string | null>;
  teamMembers(org: string, team: string): Promise<string[]>;
  searchTeamRequested(org: string, team: string): Promise<PrSearchResult>;
  searchAuthoredBy(org: string, logins: string[]): Promise<PrSearchResult>;
  viewPr(repo: string, number: number): Promise<PrDetail | null>;
  prHead(repo: string, number: number): Promise<string | null>;
}

interface SpawnReviewArgs {
  candidate: TeamReviewCandidate;
  detail: PrDetail;
  tier: ReviewTier;
  reasons: string[];
}

type DraftPatch = Partial<Omit<ReviewDraftType, 'key' | 'repo' | 'number'>>;

interface TeamReviewPollerDependencies {
  org: string;
  team: string;
  github: TeamReviewGithub;
  spawnReview: (args: SpawnReviewArgs) => Promise<ReviewDraftType | null>;
  readState?: () => Promise<TeamReviewState>;
  writeState?: (state: TeamReviewState) => Promise<void>;
  beforeStart?: () => Promise<void>;
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  log?: Pick<Console, 'warn'>;
  onTickComplete?: (status: TeamReviewStatus) => void;
  now?: () => number;
  intervalMinutes?: number;
  maxConcurrentReviews?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTeamReviewPoller(deps: TeamReviewPollerDependencies) {
  const {
    org, team, github, spawnReview,
    readState = async () => ({}), writeState = async () => {}, beforeStart = async () => {},
    setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = clearInterval,
    log = console, onTickComplete = () => {}, now = () => Date.now(),
  } = deps;
  const maxConcurrentReviews = deps.maxConcurrentReviews ?? core.MAX_CONCURRENT_REVIEWS;
  let state: TeamReviewState = {};
  let self: string | null = null;

  const loop = createTickLoop({
    tag: core.TEAM_REVIEW_LANE_ID, intervalMs: (deps.intervalMinutes ?? core.POLL_INTERVAL_MINUTES) * 60000,
    tick: () => runTick(), writeState: () => writeState(state), setIntervalFn, clearIntervalFn, log,
  });
  const persist = () => loop.persist();

  function inFlightKeys(): string[] {
    return Object.keys(state).filter((key) => state[key]?.inFlight);
  }

  function emitStatus(): void {
    onTickComplete(core.teamReviewStatus({
      ts: now(), configured: true, drafts: core.draftsNewestFirst(state), inFlight: inFlightKeys(),
    }));
  }

  function entryFor(key: string): TeamReviewStateEntry {
    const existing = state[key];
    if (existing) return existing;
    const created: TeamReviewStateEntry = { draft: null, reviewedHead: null, inFlight: false, skipReason: null, reviewAttempts: 0, updatedAt: now() };
    state[key] = created;
    return created;
  }

  async function runReview(args: SpawnReviewArgs): Promise<void> {
    const draft = await spawnReview(args).catch((error: unknown) => core.errorDraft({
      candidate: args.candidate, tier: args.tier, reasons: args.reasons,
      reviewedHead: args.detail.headRefOid, error: firstLine(errorMessage(error)) || 'review crashed',
    }));
    const entry = entryFor(args.candidate.key);
    entry.inFlight = false;
    if (draft === null) {
      await persist();
      emitStatus();
      return;
    }
    entry.reviewAttempts = core.reviewAttemptsAfter(entry, draft.reviewedHead);
    entry.draft = draft;
    entry.reviewedHead = draft.reviewedHead;
    entry.skipReason = null;
    entry.updatedAt = now();
    await persist();
    emitStatus();
  }

  async function headsToReview(candidates: TeamReviewCandidate[]): Promise<{ queue: TeamReviewCandidate[]; isDirty: boolean }> {
    const queue: TeamReviewCandidate[] = [];
    let isDirty = false;
    for (const candidate of candidates) {
      const entry = state[candidate.key];
      if (entry?.inFlight) continue;
      if (!entry) {
        queue.push(candidate);
        continue;
      }
      const head = await github.prHead(candidate.repo, candidate.number);
      if (head === null || core.isSettledAtHead(entry, head)) continue;
      if (core.markDraftStale(entry, now())) isDirty = true;
      queue.push(candidate);
    }
    return { queue, isDirty };
  }

  function pruneDeparted(candidateKeys: Set<string>): boolean {
    let isDirty = false;
    for (const [key, entry] of Object.entries(state)) {
      if (!core.shouldPruneEntry(entry, candidateKeys.has(key), now())) continue;
      delete state[key];
      isDirty = true;
    }
    return isDirty;
  }

  async function startReviews(queue: TeamReviewCandidate[]): Promise<boolean> {
    let freeSlots = maxConcurrentReviews - inFlightKeys().length;
    let isDirty = false;
    for (const candidate of queue) {
      if (freeSlots <= 0 || loop.isStopped()) break;
      const detail = await github.viewPr(candidate.repo, candidate.number);
      if (!detail) continue;
      const triage = core.triagePr(detail);
      const entry = entryFor(candidate.key);
      entry.updatedAt = now();
      isDirty = true;
      if (triage.tier === 'skip') {
        entry.reviewedHead = detail.headRefOid;
        entry.skipReason = triage.reasons.join(', ') || 'skipped';
        continue;
      }
      entry.inFlight = true;
      freeSlots -= 1;
      const args: SpawnReviewArgs = { candidate, detail, tier: triage.tier, reasons: triage.reasons };
      loop.track(runReview(args).catch((error: unknown) => {
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] review crashed for ${candidate.key}: ${errorMessage(error)}`);
      }));
    }
    return isDirty;
  }

  async function collectCandidates(): Promise<{ candidates: TeamReviewCandidate[]; isComplete: boolean } | null> {
    if (self === null) self = await github.viewer();
    const viewer = self;
    if (viewer === null) return null;
    const members = await github.teamMembers(org, team);
    if (members.length === 0) return null;
    const teammates = members.filter((login) => login.toLowerCase() !== viewer.toLowerCase());
    const requested = await github.searchTeamRequested(org, team);
    const authored = teammates.length > 0 ? await github.searchAuthoredBy(org, teammates) : { items: [], complete: true };
    const candidates = core.selectCandidates(requested.items, authored.items, { self: viewer });
    return { candidates, isComplete: requested.complete && authored.complete };
  }

  async function runTick(): Promise<TickOutcome | undefined> {
    const collected = await collectCandidates().catch((error: unknown) => {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] candidate search failed: ${errorMessage(error)}`);
      return null;
    });
    if (collected === null) {
      emitStatus();
      return { failed: true };
    }
    const { candidates, isComplete } = collected;
    const isPruned = isComplete ? pruneDeparted(new Set(candidates.map((candidate) => candidate.key))) : false;
    const planned = await headsToReview(candidates);
    const isStarted = await startReviews(planned.queue);
    if (isPruned || planned.isDirty || isStarted) await persist();
    emitStatus();
    return undefined;
  }

  function getDraft(key: string): ReviewDraftType | null {
    return state[key]?.draft ?? null;
  }

  async function updateDraft(key: string, patch: DraftPatch): Promise<ReviewDraftType | null> {
    const entry = state[key];
    if (!entry?.draft) return null;
    const parsed = ReviewDraft.safeParse({ ...entry.draft, ...patch, key: entry.draft.key, repo: entry.draft.repo, number: entry.draft.number });
    if (!parsed.success) return null;
    entry.draft = parsed.data;
    entry.updatedAt = now();
    await persist();
    emitStatus();
    return parsed.data;
  }

  async function start(): Promise<void> {
    await loop.start(async () => {
      await beforeStart();
      state = (await readState()) || {};
      for (const entry of Object.values(state)) entry.inFlight = false;
    });
  }

  return { start, stop: loop.stop, tick: loop.tick, getDraft, updateDraft, _state: () => state };
}

type TeamReviewPoller = ReturnType<typeof createTeamReviewPoller>;

export { createTeamReviewPoller };
export type { DraftPatch, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller, TeamReviewPollerDependencies };
