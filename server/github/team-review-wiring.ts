import type { GithubLaneStore } from './github-store-wiring.ts';
import { githubStoreRateLimitedError } from './github-store-poller.ts';
import { TeamReviewStateEntry, TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { TeamReviewCandidatesPayload } from '../../shared/contracts/team-review-candidates.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HookRouter } from '../../detection/hook-source.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import * as core from './core/team-review-core.ts';
import { drainPending, firstLine } from '../lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from '../lanes/ephemeral-session.ts';
import { createJsonStateStore } from '../json-file.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';
import type { LaneRunnerGate, LaneStatusRecord, SharedClock } from '../lanes/lane-runner.ts';
import { THREAD_JUDGE_TOOLS, createThreadJudge } from './team-review-thread-judge.ts';
import { createLaneSpawn } from '../lanes/lane-spawn.ts';
import type { Telemetry } from '../telemetry.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import { createRepoCache } from '../git/repo-cache.ts';
import { reapTeamReviewProcesses } from './team-review-reaper.ts';
import { createTeamReviewPoller } from './team-review-poller.ts';
import { bootStaggerDelay } from '../boot-stagger.ts';
import { createWatcheeFeed } from '../lanes/watchee-feed.ts';
import type { DraftExpectation, DraftPatch, NotMineOutcome, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller } from './team-review-poller.ts';
import type { PrDetail, ReviewDraft, TeamReviewState as TeamReviewStateType, TeamReviewStateEntry as TeamReviewStateEntryType, TeamReviewStatus as TeamReviewStatusType } from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { isPathInside } from '../../shared/paths.ts';
import { createTeamReviewSpawn } from './team-review-spawn.ts';
import type { TeamReviewSpawn } from './team-review-spawn.ts';
import { isOwnedResumable, pruneCachedClone, deleteDirectory, deleteCheckout, mainCheckoutOf, configuredProjectPathsByRealPath, findLocalCheckout, sweepLeftoverCheckouts } from './team-review-checkouts.ts';
import type { TeamReviewWiringConfig, TeamReviewRepoCache, TeamReviewGitWorkspace, TeamReviewReap } from './team-review-checkouts.ts';
import { createTeamReviewDispatcher } from './team-review-dispatcher.ts';
import { createTeamReviewActions } from './team-review-actions.ts';
import { laneAccessConfigOf, laneAccessEnvBlocker } from '../lanes/core/lane-permissions-core.ts';

const TEAM_REVIEW_READ_TOKEN_REQUIRED = 'Team review needs a GitHub read token: set one in Settings, Lane GitHub access, or GLIMMERVOID_GITHUB_READ_TOKEN';

type PrSessionCheckout =
  | { ok: true; repo: string; detail: PrDetail; draft: ReviewDraft | null; checkoutPath: string; baseBranch: string; isConfiguredProject: boolean }
  | { ok: false; error: string };

interface TeamReviewWiringOptions {
  config: TeamReviewWiringConfig;
  store: GithubLaneStore;
  reviewSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  gitWorkspace: TeamReviewGitWorkspace;
  recordLane?: RecordLane | null;
  broadcast?: (message: LaneStatusRecord) => void;
  log?: Pick<Console, 'warn'>;
  homeDir?: string;
  repoCacheRoot?: string;
  github?: TeamReviewGithub & Partial<Pick<PrGh, 'postReview' | 'dismissReview'>>;
  repoCache?: TeamReviewRepoCache;
  spawnSession?: TeamReviewSpawn;
  createPoller?: typeof createTeamReviewPoller;
  reapProcesses?: TeamReviewReap;
  clock?: SharedClock;
  requestPrRefresh?: (key: string) => void;
  telemetry?: Pick<Telemetry, 'capture'> | null;
}

function teamReviewShouldStart(config: TeamReviewWiringConfig): LaneRunnerGate {
  const settings = core.readTeamReviewSettings(config);
  if (!settings.enabled) return { start: false };
  if (!settings.org) return { start: false, reason: 'Team review needs a GitHub organization or team' };
  if (!laneAccessConfigOf(config).readToken) return { start: false, reason: TEAM_REVIEW_READ_TOKEN_REQUIRED };
  const envBlocker = laneAccessEnvBlocker(process.env);
  if (envBlocker) return { start: false, reason: `Team review cannot read GitHub while ${envBlocker} is set in Glimmervoid's environment` };
  return { start: true };
}

function teamReviewCfgKey(config: TeamReviewWiringConfig): string {
  return JSON.stringify({ ...core.readTeamReviewSettings(config), hasReadToken: Boolean(laneAccessConfigOf(config).readToken) });
}

function emptyTeamReviewStatus(gate: LaneRunnerGate): TeamReviewStatusType {
  return core.teamReviewStatus({ ts: Date.now(), configured: gate.start, reason: gate.reason ?? null });
}

function createTeamReviewStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded: TeamReviewStateType = {};
  const store = createJsonStateStore<TeamReviewStateType>({
    name: 'team-review state',
    filePath: statePath,
    parse: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const validEntries: [string, TeamReviewStateEntryType][] = [];
      for (const [key, value] of Object.entries(raw)) {
        const parsed = TeamReviewStateEntry.safeParse(value);
        if (parsed.success) {
          validEntries.push([key, parsed.data]);
          continue;
        }
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] dropped an invalid saved review ${key}`);
      }
      return Object.fromEntries(validEntries);
    },
    adopt: (value) => { loaded = value ?? {}; },
    warn: (message, fields) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] ${message} ${JSON.stringify(fields)}`),
  });
  return {
    async readState(): Promise<TeamReviewStateType> {
      await store.load();
      return loaded;
    },
    async writeState(state: TeamReviewStateType): Promise<void> {
      await store.write(state, () => `${JSON.stringify(state, null, 2)}\n`);
    },
  };
}

function createTeamReviewWiring({
  config, store, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
  recordLane = null, broadcast = () => {}, log = console,
  homeDir = glimmervoidHomeDir(),
  github = createPrGh(homeDir),
  repoCacheRoot = path.join(homeDir, 'team-review-repos'),
  repoCache = createRepoCache({ rootDir: repoCacheRoot }),
  spawnSession = createTeamReviewSpawn({
    reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
    replayBufferKB: config.replayBufferKB, hookToolConfig: config, getLaneAccessConfig: () => laneAccessConfigOf(config),
  }),
  createPoller = createTeamReviewPoller,
  reapProcesses = reapTeamReviewProcesses,
  clock,
  requestPrRefresh,
  telemetry = null,
}: TeamReviewWiringOptions) {
  const stateIo = createTeamReviewStateIo(path.join(homeDir, core.TEAM_REVIEW_STATE_FILENAME), log);
  const worktreeRoot = path.join(homeDir, 'team-review-worktrees');
  const workRoot = path.join(homeDir, 'team-review-work');
  const shutdownController = new AbortController();
  const inFlightReviews = new Set<Promise<ReviewOutcome>>();
  const reviewPullRequest = createTeamReviewDispatcher({
    store, repoCache, gitWorkspace, spawnSession, worktreeRoot, workRoot, repoCacheRoot, shutdownSignal: shutdownController.signal, reapProcesses, log,
    readReviewSetup: () => core.readTeamReviewSettings(config),
    readLocalCheckoutConfig: () => ({ projects: config.projects, repoRoots: config.repoRoots }),
  });

  function trackReview(args: SpawnReviewArgs): Promise<ReviewOutcome> {
    const review = reviewPullRequest(args).then((outcome) => {
      if ('kind' in outcome) return outcome;
      if (outcome.status === 'error' && shutdownController.signal.aborted) return { kind: 'stopped' as const, resumable: null };
      return outcome;
    });
    inFlightReviews.add(review);
    const forget = () => { inFlightReviews.delete(review); };
    review.then(forget, forget);
    return review;
  }

  const candidatesFeed = createWatcheeFeed<TeamReviewCandidatesPayload>();
  const runner = createLaneRunner<TeamReviewPoller>({
    tag: core.TEAM_REVIEW_LANE_ID,
    gate: () => teamReviewShouldStart(config),
    cfgKey: () => teamReviewCfgKey(config),
    emptyStatus: () => emptyTeamReviewStatus(teamReviewShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const settings = core.readTeamReviewSettings(config);
      const createdPoller = createPoller({
        org: settings.org,
        teams: settings.teams,
        reReviewAfterMs: settings.reReviewAfterHours * 60 * 60 * 1000,
        skipIdleAfterMs: settings.skipIdleAfterDays * 24 * 60 * 60 * 1000,
        github, store,
        spawnReview: trackReview,
        judgeThread: createThreadJudge(createLaneSpawn({ laneName: 'team-review', getSaneYoloUnreadablePaths: () => config.saneYoloUnreadablePaths ?? [], sessions: reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane, replayBufferKB: config.replayBufferKB, allowTools: THREAD_JUDGE_TOOLS, getLaneAccessConfig: () => laneAccessConfigOf(config) }), () => core.readTeamReviewSettings(config).reviewer, shutdownController.signal),
        beforeStart: (keepPaths) => sweepLeftoverCheckouts({ worktreeRoot, workRoot, keepPaths, repoCache, gitWorkspace, reapProcesses, log }),
        discardResumable: async (record) => {
          if (!isOwnedResumable(record, { workRoot, worktreeRoot })) return;
          await reapProcesses({ ownedDirectories: [record.workDir, record.worktreePath], reviewRoots: [workRoot, worktreeRoot], scope: 'run', log })
            .catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
          await deleteCheckout(gitWorkspace, record.worktreePath, log);
          await deleteDirectory(record.workDir, log);
          const cachedClones = await repoCache.listRepos();
          for (const projectPath of cachedClones) await pruneCachedClone(gitWorkspace, projectPath, log);
        },
        readState: stateIo.readState,
        writeState: stateIo.writeState,
        log,
        telemetry,
        onTickComplete,
        clock,
        firstTickDelayMs: bootStaggerDelay,
        feedSilenceMs: candidatesFeed.silenceMs,
      });
      const latestCandidates = candidatesFeed.latest();
      if (latestCandidates !== null) createdPoller.acceptCandidates(latestCandidates);
      return createdPoller;
    },
  });

  const unsubscribe = store.subscribe('snapshot-changed', () => runner.getPoller()?.rebuild());

  function getStatus(): TeamReviewStatusType {
    const parsed = TeamReviewStatus.safeParse(runner.getStatus());
    return parsed.success ? parsed.data : emptyTeamReviewStatus(teamReviewShouldStart(config));
  }

  async function refresh() {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'Reviews polling is not running.' };
    return poller.refresh();
  }

  async function stopPoller(): Promise<void> {
    unsubscribe();
    shutdownController.abort();
    candidatesFeed.stop();
    await Promise.allSettled([drainPending(Promise.allSettled([...inFlightReviews])), runner.stopPoller()]);
  }

  function getDraft(key: string): ReviewDraft | null {
    return runner.getPoller()?.getDraft(key) ?? null;
  }

  async function updateDraft(key: string, expected: DraftExpectation, patch: DraftPatch): Promise<ReviewDraft | null> {
    const poller = runner.getPoller();
    if (!poller) return null;
    return poller.updateDraft(key, expected, patch);
  }

  async function updateThread(key: string, threadId: string, patch: { isResolved?: boolean; resolveError?: string }): Promise<boolean> {
    return (await runner.getPoller()?.updateThread(key, threadId, patch)) ?? false;
  }

  async function requeue(key: string, head: string): Promise<boolean> {
    return (await runner.getPoller()?.requeue(key, head)) ?? false;
  }

  async function restore(key: string, head: string): Promise<boolean> {
    return (await runner.getPoller()?.restore(key, head)) ?? false;
  }

  async function requestReview(reference: { repo: string; number: number }) {
    const poller = runner.getPoller();
    if (!poller) return { ok: false as const, error: 'team review is off, and the operator turns it on in the dashboard settings' };
    return poller.requestReview(reference);
  }

  async function acceptCandidates(job: { payload: TeamReviewCandidatesPayload }): Promise<void> {
    if (shutdownController.signal.aborted) return;
    if (!candidatesFeed.accept(job.payload)) return;
    runner.getPoller()?.acceptCandidates(job.payload);
  }

  async function markNotMineForPoller(key: string): Promise<NotMineOutcome> {
    return (await runner.getPoller()?.markNotMine(key)) ?? { ok: false, error: 'Team review is not running' };
  }

  async function findOperatorCheckout(repo: string): Promise<string | null> {
    const excludedRoots = [repoCacheRoot, worktreeRoot, workRoot];
    const resolvedExcludedRoots = await Promise.all(excludedRoots.map((root) => fs.realpath(root).catch(() => path.resolve(root))));
    const configuredPathByRealPath = await configuredProjectPathsByRealPath(config.projects ?? []);
    return findLocalCheckout({
      repo, config: { projects: config.projects, repoRoots: config.repoRoots }, excludedRoots, gitWorkspace, log, requireInstalledModules: false,
      resolveCheckout: async (checkoutPath) => {
        const mainCheckout = await mainCheckoutOf(checkoutPath);
        if (mainCheckout === null) return null;
        if (resolvedExcludedRoots.some((root) => isPathInside(root, mainCheckout))) return null;
        return configuredPathByRealPath.get(mainCheckout) ?? mainCheckout;
      },
    });
  }

  async function preparePrSession(key: string): Promise<PrSessionCheckout> {
    const separatorIndex = key.lastIndexOf('#');
    const repo = key.slice(0, separatorIndex);
    const number = Number(key.slice(separatorIndex + 1));
    const headRead = await store.requestPrHead(repo, number, 'priority');
    if (headRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(headRead.waitMs) };
    const detailRead = headRead.value ? await store.requestPrView(repo, number, headRead.value, 'priority') : { isRateLimited: false as const, value: null };
    if (detailRead.isRateLimited) return { ok: false, error: githubStoreRateLimitedError(detailRead.waitMs) };
    const detail = detailRead.value;
    if (!detail) return { ok: false, error: `Could not read ${key} from GitHub` };
    if (detail.isCrossRepository || !detail.headRefName) return { ok: false, error: 'This pull request comes from a fork, so its branch is not in the repository' };
    const configuredCheckout = await findOperatorCheckout(repo);
    const checkoutPath = configuredCheckout ?? await repoCache.ensureRepo(repo).catch(() => null);
    if (!checkoutPath) return { ok: false, error: `Could not clone ${repo}` };
    if (!gitWorkspace.seedBranchFromOrigin) return { ok: false, error: 'This build cannot check out a pull request branch' };
    const seeded = await gitWorkspace.seedBranchFromOrigin({ projectPath: checkoutPath, name: detail.headRefName })
      .catch((error: unknown) => ({ ok: false, out: '', err: errorMessage(error) }));
    if (!seeded.ok) return { ok: false, error: `Could not fetch branch ${detail.headRefName}: ${firstLine(seeded.err ?? '')}` };
    if (seeded.out.trim() !== detail.headRefOid) return { ok: false, error: `Branch ${detail.headRefName} is at ${seeded.out.trim()} but the pull request head is ${detail.headRefOid}` };
    return { ok: true, repo, detail, draft: getDraft(key), checkoutPath, baseBranch: detail.headRefName, isConfiguredProject: configuredCheckout !== null };
  }

  function isRunning(): boolean {
    return runner.getPoller() !== null;
  }

  const actions = createTeamReviewActions({
    requestPrRefresh, store,
    drafts: { getDraft, updateDraft, updateThread, requeue, restore, markNotMine: markNotMineForPoller },
    github: {
      resolveReviewThread: github.resolveReviewThread?.bind(github),
      postReview: async (review) => {
        if (!github.postReview) return { ok: false, err: 'this GitHub client cannot post reviews', reviewId: null };
        return github.postReview(review);
      },
      dismissReview: async (dismissal) => {
        if (!github.dismissReview) return { ok: false, err: 'this GitHub client cannot dismiss reviews' };
        return github.dismissReview(dismissal);
      },
    },
    log,
    telemetry,
  });

  return {
    acceptCandidates,
    startPoller: runner.startPoller,
    stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus,
    refresh,
    isRunning,
    requestReview,
    submitAction: actions.submitAction,
    preparePrSession,
  };
}

export { createTeamReviewStateIo, createTeamReviewWiring };
export { readTeamReviewSettings } from './core/team-review-core.ts';
export type { PrSessionCheckout };
