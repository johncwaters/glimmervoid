import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import * as core from './core/team-review-core.ts';
import type { ReviewTier, TeamReviewCandidate } from './core/team-review-core.ts';
import {
  JOB_RESULT_FILENAME, awaitSessionExit, createJobResultFile, drainPending, firstLine, raceWithAbort,
  registerEphemeralSession,
} from './ephemeral-session.ts';
import type { JobResultFile, RecordLane, SpawnGate } from './ephemeral-session.ts';
import { createJsonStateStore } from './json-file.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { LaneRunnerGate, LaneStatusRecord } from './lane-runner.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import { createRepoCache } from './repo-cache.ts';
import { createTeamReviewPoller } from './team-review-poller.ts';
import type { DraftExpectation, DraftPatch, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller } from './team-review-poller.ts';
import { ReviewResult, TeamReviewState, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type {
  PrDetail, ReviewComment, ReviewDraft, TeamReviewActionRequest, TeamReviewActionResult,
  TeamReviewState as TeamReviewStateType, TeamReviewStatus as TeamReviewStatusType,
} from '../shared/contracts/team-review.ts';

const TEAM_REVIEW_DENY_TOOLS = Object.freeze(['Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task']);
const TEAM_REVIEW_ALLOW_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Write']);
const RESULT_MAX_BYTES = 1024 * 1024;
const REPLACED_DRAFT_ERROR = 'The draft was replaced after it was shown. Read the new draft before acting on it';
const STALE_APPROVAL_DISMISSAL = 'The pull request moved while this approval was posting, so it no longer covers the current head.';
const UNMARKED_POST_WARNING = 'The review was posted on GitHub, but its draft could not be marked posted. Do not post it again';

interface TeamReviewWiringConfig {
  teamReview?: Record<string, unknown> | null;
  replayBufferKB?: number;
}

interface TeamReviewSettings {
  enabled: boolean;
  org: string;
  team: string;
}

interface TeamReviewRepoCache {
  listRepos(): Promise<string[]>;
  ensureRepo(repo: string): Promise<string | null>;
  fetchPr(repo: string, number: number, baseRef: string): Promise<{ ok: boolean; headSha: string | null }>;
}

interface TeamReviewGitWorkspace {
  stageDetachedWorktree(args: { projectPath: string; worktreePath?: string; sha?: string }): Promise<{ ok: boolean; err?: string }>;
  removeWorktreeByPath(args: { projectPath: string; cwd?: string | null }): Promise<{ ok: boolean; err?: string }>;
  pruneWorktrees(args: { projectPath: string }): Promise<{ ok: boolean; err?: string }>;
}

type TeamReviewSpawn = (options: {
  id: string;
  name: string;
  cwd: string;
  extraClaudeArgs: string[];
  settingsPermissions: { deny: string[]; defaultMode: string };
  signal: AbortSignal;
}) => Promise<void>;

interface TeamReviewDispatchOptions {
  github: { prDiff(repo: string, number: number): Promise<string | null> };
  repoCache: TeamReviewRepoCache;
  gitWorkspace: TeamReviewGitWorkspace;
  spawnSession: TeamReviewSpawn;
  worktreeRoot: string;
  timeoutSeconds?: number;
  makeResultFile?: (prefix: string) => Promise<JobResultFile>;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  randomSuffix?: () => string;
  shutdownSignal?: AbortSignal | null;
  log?: Pick<Console, 'warn'>;
}

interface TeamReviewWiringOptions {
  config: TeamReviewWiringConfig;
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
  github?: TeamReviewGithub & Pick<PrGh, 'prDiff'> & Partial<Pick<PrGh, 'postReview' | 'dismissReview'>>;
  repoCache?: TeamReviewRepoCache;
  spawnSession?: TeamReviewSpawn;
  createPoller?: typeof createTeamReviewPoller;
}

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

interface TeamReviewDraftStore {
  getDraft(key: string): ReviewDraft | null;
  updateDraft(key: string, expected: DraftExpectation, patch: DraftPatch): Promise<ReviewDraft | null>;
}

type TeamReviewActionGithub = Pick<PrGh, 'prHead' | 'prDiff' | 'postReview' | 'dismissReview'>;

interface TeamReviewActionOptions {
  drafts: TeamReviewDraftStore;
  github: TeamReviewActionGithub;
  log?: Pick<Console, 'warn'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTeamReviewSettings(config: TeamReviewWiringConfig): TeamReviewSettings {
  const block = config.teamReview;
  return {
    enabled: block?.enabled === true,
    org: typeof block?.org === 'string' ? block.org.trim() : '',
    team: typeof block?.team === 'string' ? block.team.trim() : '',
  };
}

function teamReviewShouldStart(config: TeamReviewWiringConfig): LaneRunnerGate {
  const settings = readTeamReviewSettings(config);
  if (!settings.enabled) return { start: false };
  if (!settings.org || !settings.team) return { start: false, reason: 'teamReview needs both org and team' };
  return { start: true };
}

function teamReviewCfgKey(config: TeamReviewWiringConfig): string {
  return JSON.stringify(readTeamReviewSettings(config));
}

function emptyTeamReviewStatus(gate: LaneRunnerGate): TeamReviewStatusType {
  return core.teamReviewStatus({ ts: Date.now(), configured: gate.start, reason: gate.reason ?? null });
}

function teamReviewPermissions() {
  return buildLanePermissions({ denyTools: TEAM_REVIEW_DENY_TOOLS, allowTools: TEAM_REVIEW_ALLOW_TOOLS });
}

function teamReviewClaudeArgs(tier: ReviewTier, worktreePath: string | null): string[] {
  const posture = teamReviewPermissions();
  const model = tier === 'full' ? core.FULL_MODEL : core.STAMP_MODEL;
  const addDir = worktreePath ? ['--add-dir', worktreePath] : [];
  return ['-p', ...posture.args, ...addDir, '--model', model];
}

function makeTeamReviewResultFile(prefix: string): Promise<JobResultFile> {
  return createJobResultFile(`glimmervoid-wt-${core.TEAM_REVIEW_LANE_ID}-${prefix}`);
}

async function readReviewResult(resultPath: string, expectedHead: string): Promise<{ ok: true; result: ReviewResult } | { ok: false; reason: string }> {
  let raw: string;
  try {
    const stat = await fs.stat(resultPath);
    if (stat.size > RESULT_MAX_BYTES) return { ok: false, reason: 'result file is too large' };
    raw = await fs.readFile(resultPath, 'utf8');
  } catch {
    return { ok: false, reason: 'no result file' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'result file is not JSON' };
  }
  const parsed = ReviewResult.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: `result file is invalid: ${firstLine(parsed.error.issues[0]?.message ?? 'schema mismatch')}` };
  if (parsed.data.head !== expectedHead) return { ok: false, reason: `result head ${parsed.data.head} is not the reviewed head ${expectedHead}` };
  return { ok: true, result: parsed.data };
}

function worktreeDirName(repo: string, number: number, suffix: string): string {
  return `${repo.replace(/[^\w.-]+/g, '-')}-${number}-${suffix}`;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return fs.lstat(candidatePath).then(() => true, () => false);
}

async function pruneCachedClone(
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees'>, projectPath: string, log: Pick<Console, 'warn'>,
): Promise<void> {
  const pruned = await gitWorkspace.pruneWorktrees({ projectPath })
    .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
  if (!pruned.ok) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] worktree prune failed in ${projectPath}: ${firstLine(pruned.err ?? '')}`);
}

async function deleteDirectory(directory: string, log: Pick<Console, 'warn'>): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true })
    .catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not delete ${directory}: ${errorMessage(error)}`));
}

async function sweepLeftoverCheckouts({ worktreeRoot, repoCache, gitWorkspace, log }: {
  worktreeRoot: string;
  repoCache: Pick<TeamReviewRepoCache, 'listRepos'>;
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees'>;
  log: Pick<Console, 'warn'>;
}): Promise<void> {
  const leftoverNames = await fs.readdir(worktreeRoot).catch(() => []);
  for (const leftoverName of leftoverNames) await deleteDirectory(path.join(worktreeRoot, leftoverName), log);
  const cachedClones = await repoCache.listRepos()
    .catch((error: unknown) => { log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not list cached clones: ${errorMessage(error)}`); return []; });
  for (const projectPath of cachedClones) await pruneCachedClone(gitWorkspace, projectPath, log);
}

function createTeamReviewDispatcher({
  github, repoCache, gitWorkspace, spawnSession, worktreeRoot,
  timeoutSeconds = core.REVIEW_TIMEOUT_SECONDS,
  makeResultFile = makeTeamReviewResultFile,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  randomSuffix = () => randomBytes(4).toString('hex'),
  shutdownSignal = null,
  log = console,
}: TeamReviewDispatchOptions) {
  async function removeCheckout({ projectPath, worktreePath }: { projectPath: string; worktreePath: string }): Promise<void> {
    const removal = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: worktreePath })
      .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
    if (removal.ok && !(await pathExists(worktreePath))) return;
    log.warn(`[${core.TEAM_REVIEW_LANE_ID}] worktree removal failed for ${worktreePath}, deleting it directly: ${firstLine(removal.err ?? '') || 'the directory is still present'}`);
    await deleteDirectory(worktreePath, log);
    await pruneCachedClone(gitWorkspace, projectPath, log);
  }

  async function stageCheckout(candidate: TeamReviewCandidate, detail: PrDetail): Promise<{ projectPath: string } | { error: string }> {
    const projectPath = await repoCache.ensureRepo(candidate.repo);
    if (!projectPath) return { error: `could not clone ${candidate.repo}` };
    const fetched = await repoCache.fetchPr(candidate.repo, detail.number, detail.baseRefName);
    if (!fetched.ok || !fetched.headSha) return { error: `could not fetch ${candidate.key}` };
    if (fetched.headSha !== detail.headRefOid) {
      return { error: `fetched head ${fetched.headSha} is not the triaged head ${detail.headRefOid}` };
    }
    return { projectPath };
  }

  function spawnWithTimeout(
    { candidate, detail, tier, reasons, workDir, resultPath, worktreePath, onPending }: SpawnReviewArgs & {
      workDir: string; resultPath: string; worktreePath: string | null; onPending: (pending: Promise<unknown>) => void;
    },
  ): Promise<ReviewDraft> {
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    const posture = teamReviewPermissions();
    return raceWithAbort<ReviewDraft>({
      timeoutMs: timeoutSeconds * 1000,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => failed(`review timed out after ${timeoutSeconds}s`),
      onEmpty: () => failed('review ended without a result'),
      start: (signal) => spawnSession({
        id: `${core.TEAM_REVIEW_LANE_ID}:${candidate.key}`,
        name: `Team review ${candidate.key}`,
        cwd: workDir,
        extraClaudeArgs: teamReviewClaudeArgs(tier, worktreePath),
        settingsPermissions: posture.permissions,
        signal: shutdownSignal ? AbortSignal.any([signal, shutdownSignal]) : signal,
      })
        .then(async () => {
          if (signal.aborted) return undefined;
          if (shutdownSignal?.aborted) return failed('review stopped by shutdown');
          const outcome = await readReviewResult(resultPath, detail.headRefOid);
          if (!outcome.ok) return failed(outcome.reason);
          return core.readyDraft({ candidate, tier, reasons, result: outcome.result });
        })
        .catch((error: unknown) => failed(firstLine(errorMessage(error)) || 'review session failed')),
    });
  }

  return async function reviewPullRequest(args: SpawnReviewArgs): Promise<ReviewDraft> {
    const { candidate, detail, tier, reasons } = args;
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    let resultFile: JobResultFile | null = null;
    let checkout: { projectPath: string; worktreePath: string } | null = null;
    let pendingSession: Promise<unknown> | null = null;
    try {
      if (shutdownSignal?.aborted) return failed('review stopped by shutdown');
      resultFile = await makeResultFile(`${candidate.repo}-${detail.number}`);
      const workDir = path.dirname(resultFile.path);
      const diff = await github.prDiff(candidate.repo, detail.number);
      if (diff === null && tier === 'stamp') return failed('diff unavailable, and a stamp review has no checkout to read');
      await fs.writeFile(path.join(workDir, core.PR_JSON_FILENAME), `${JSON.stringify(detail, null, 2)}\n`, 'utf8');
      await fs.writeFile(path.join(workDir, core.PR_DIFF_FILENAME), diff ?? core.DIFF_UNAVAILABLE_NOTE, 'utf8');
      let worktreePath: string | null = null;
      if (tier === 'full') {
        const staged = await stageCheckout(candidate, detail);
        if ('error' in staged) return failed(staged.error);
        worktreePath = path.join(worktreeRoot, worktreeDirName(candidate.repo, detail.number, randomSuffix()));
        checkout = { projectPath: staged.projectPath, worktreePath };
        await fs.mkdir(worktreeRoot, { recursive: true });
        const created = await gitWorkspace.stageDetachedWorktree({ projectPath: staged.projectPath, worktreePath, sha: detail.headRefOid });
        if (!created.ok) return failed(`could not stage a checkout: ${firstLine(created.err ?? '') || 'git worktree add failed'}`);
      }
      const prompt = core.buildReviewPrompt({ candidate, detail, tier, hasDiff: diff !== null, worktreePath, resultFileName: JOB_RESULT_FILENAME });
      await fs.writeFile(path.join(workDir, core.REVIEW_PROMPT_FILENAME), prompt, 'utf8');
      return await spawnWithTimeout({
        ...args, workDir, resultPath: resultFile.path, worktreePath,
        onPending: (pending) => { pendingSession = pending; },
      });
    } catch (error) {
      return failed(firstLine(errorMessage(error)) || 'review failed');
    } finally {
      await drainPending(pendingSession);
      if (checkout) await removeCheckout(checkout);
      if (resultFile) await resultFile.cleanup();
    }
  };
}

function createTeamReviewSpawn({
  reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane = null, replayBufferKB,
  makeSession = (options: SessionOptions) => new Session(options),
}: {
  reviewSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  replayBufferKB?: number;
  makeSession?: (options: SessionOptions) => Session;
}): TeamReviewSpawn {
  return async function spawnTeamReviewSession({ id, name, cwd, extraClaudeArgs, settingsPermissions, signal }) {
    const sess = makeSession({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt: core.REVIEW_BOOTSTRAP_PROMPT,
      ephemeral: true,
      settingsPermissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({
      map: reviewSessions, id, sess, closeSessionDataClients, logPrefix: core.TEAM_REVIEW_LANE_ID, name, recordLane,
    });
    await awaitSessionExit(sess, { signal, spawnGate });
  };
}

function describeInvalidComments(comments: readonly ReviewComment[]): string {
  const locations = comments.map((comment) => `${comment.path}:${comment.line} (${comment.side})`).join(', ');
  return `These inline comments are not on lines in the diff, remove them and retry: ${locations}`;
}

function createTeamReviewActions({ drafts, github, log = console }: TeamReviewActionOptions) {
  const actionsInFlight = new Set<string>();

  async function markDraft(key: string, draft: ReviewDraft, patch: DraftPatch): Promise<ReviewDraft | null> {
    const updated = await drafts.updateDraft(key, { reviewedHead: draft.reviewedHead, status: draft.status }, patch);
    if (!updated) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not mark ${key} ${patch.status ?? 'updated'}, the draft changed underneath the action`);
    return updated;
  }

  async function discard(key: string, draft: ReviewDraft): Promise<TeamReviewActionOutcome> {
    if (draft.status === 'posted') return { ok: false, error: 'That review was already posted' };
    const discarded = await markDraft(key, draft, { status: 'discarded' });
    return discarded ? { ok: true } : { ok: false, error: 'The draft could not be discarded' };
  }

  async function misplacedCommentsError(draft: ReviewDraft, comments: readonly ReviewComment[]): Promise<string | null> {
    if (comments.length === 0) return null;
    const diff = await github.prDiff(draft.repo, draft.number);
    if (diff === null) return 'Could not fetch the diff to check the inline comments. Remove them to post without them';
    const misplaced = core.invalidComments(comments, core.commentableLines(diff));
    return misplaced.length > 0 ? describeInvalidComments(misplaced) : null;
  }

  async function retractApproval(key: string, draft: ReviewDraft, movedHead: string, reviewId: number | null): Promise<TeamReviewActionOutcome> {
    await markDraft(key, draft, { status: 'stale' });
    const moved = `The pull request moved to ${movedHead.slice(0, 7)} while the approval was posting`;
    if (reviewId === null) return { ok: false, error: `${moved}, and GitHub did not return the review id, so the approval still stands. Dismiss it on GitHub` };
    const dismissal = await github.dismissReview({ repo: draft.repo, number: draft.number, reviewId, message: STALE_APPROVAL_DISMISSAL });
    if (!dismissal.ok) return { ok: false, error: `${moved}, and dismissing the approval failed (${firstLine(dismissal.err)}), so it still stands. Dismiss it on GitHub` };
    return { ok: false, error: `${moved}, so the approval was dismissed. It will be reviewed again` };
  }

  async function post(key: string, draft: ReviewDraft, request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    if (draft.status !== 'ready') return { ok: false, error: `The draft is ${draft.status}, so it cannot be posted` };
    const event = core.eventForAction(request.action);
    if (!event) return { ok: false, error: 'Unknown review action' };
    if (event === 'COMMENT' && !request.body.trim() && request.comments.length === 0) {
      return { ok: false, error: 'A comment review needs a body or an inline comment' };
    }
    const liveHead = await github.prHead(draft.repo, draft.number);
    if (!liveHead) return { ok: false, error: 'Could not read the pull request head from GitHub' };
    if (!core.canPost(draft, request.head, liveHead)) {
      await markDraft(key, draft, { status: 'stale' });
      return { ok: false, error: `The pull request moved to ${liveHead.slice(0, 7)} after this review, so nothing was posted. It will be reviewed again` };
    }
    const commentsError = await misplacedCommentsError(draft, request.comments);
    if (commentsError) return { ok: false, error: commentsError };
    const posted = await github.postReview({
      repo: draft.repo, number: draft.number, commitId: draft.reviewedHead, event, body: request.body, comments: request.comments,
    });
    if (!posted.ok) return { ok: false, error: posted.err || 'GitHub refused the review' };
    const headAfterPost = event === 'APPROVE' ? await github.prHead(draft.repo, draft.number) : draft.reviewedHead;
    if (headAfterPost !== null && headAfterPost !== draft.reviewedHead) return retractApproval(key, draft, headAfterPost, posted.reviewId);
    const marked = await markDraft(key, draft, { status: 'posted', body: request.body, comments: request.comments });
    const warnings = [
      headAfterPost === null ? 'Could not confirm the pull request head after approving. Check the approval on GitHub' : '',
      marked ? '' : UNMARKED_POST_WARNING,
    ].filter(Boolean);
    return warnings.length > 0 ? { ok: true, warning: warnings.join('. ') } : { ok: true };
  }

  async function runAction(request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    const draft = drafts.getDraft(request.key);
    if (!draft) return { ok: false, error: 'That review draft no longer exists' };
    if (draft.reviewedHead !== request.head) return { ok: false, error: REPLACED_DRAFT_ERROR };
    if (request.action === 'discard') return discard(request.key, draft);
    return post(request.key, draft, request);
  }

  async function submitAction(request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome> {
    if (actionsInFlight.has(request.key)) return { ok: false, error: 'An action for this pull request is already running' };
    actionsInFlight.add(request.key);
    try {
      return await runAction(request);
    } catch (error) {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] action failed for ${request.key}: ${errorMessage(error)}`);
      return { ok: false, error: errorMessage(error) };
    } finally {
      actionsInFlight.delete(request.key);
    }
  }

  return { submitAction };
}

function createTeamReviewStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded: TeamReviewStateType = {};
  const store = createJsonStateStore<TeamReviewStateType>({
    name: 'team-review state',
    filePath: statePath,
    parse: (raw) => {
      const parsed = TeamReviewState.safeParse(raw);
      return parsed.success ? parsed.data : null;
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
  config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
  recordLane = null, broadcast = () => {}, log = console,
  homeDir = glimmervoidHomeDir(),
  github = createPrGh(homeDir),
  repoCache = createRepoCache({ rootDir: path.join(homeDir, 'team-review-repos') }),
  spawnSession = createTeamReviewSpawn({
    reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane,
    replayBufferKB: config.replayBufferKB,
  }),
  createPoller = createTeamReviewPoller,
}: TeamReviewWiringOptions) {
  const stateIo = createTeamReviewStateIo(path.join(homeDir, core.TEAM_REVIEW_STATE_FILENAME), log);
  const worktreeRoot = path.join(homeDir, 'team-review-worktrees');
  const shutdownController = new AbortController();
  const inFlightReviews = new Set<Promise<ReviewDraft | null>>();
  const reviewPullRequest = createTeamReviewDispatcher({
    github, repoCache, gitWorkspace, spawnSession, worktreeRoot, shutdownSignal: shutdownController.signal, log,
  });

  function trackReview(args: SpawnReviewArgs): Promise<ReviewDraft | null> {
    const review = reviewPullRequest(args).then((draft) => {
      if (draft.status === 'error' && shutdownController.signal.aborted) return null;
      return draft;
    });
    inFlightReviews.add(review);
    const forget = () => { inFlightReviews.delete(review); };
    review.then(forget, forget);
    return review;
  }

  const runner = createLaneRunner<TeamReviewPoller>({
    tag: core.TEAM_REVIEW_LANE_ID,
    gate: () => teamReviewShouldStart(config),
    cfgKey: () => teamReviewCfgKey(config),
    emptyStatus: () => emptyTeamReviewStatus(teamReviewShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const settings = readTeamReviewSettings(config);
      return createPoller({
        org: settings.org,
        team: settings.team,
        github,
        spawnReview: trackReview,
        beforeStart: () => sweepLeftoverCheckouts({ worktreeRoot, repoCache, gitWorkspace, log }),
        readState: stateIo.readState,
        writeState: stateIo.writeState,
        log,
        onTickComplete,
      });
    },
  });

  function getStatus(): TeamReviewStatusType {
    const parsed = TeamReviewStatus.safeParse(runner.getStatus());
    return parsed.success ? parsed.data : emptyTeamReviewStatus(teamReviewShouldStart(config));
  }

  async function stopPoller(): Promise<void> {
    shutdownController.abort();
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

  function isRunning(): boolean {
    return runner.getPoller() !== null;
  }

  const actions = createTeamReviewActions({
    drafts: { getDraft, updateDraft },
    github: {
      prHead: (repo, number) => github.prHead(repo, number),
      prDiff: (repo, number) => github.prDiff(repo, number),
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
  });

  return {
    startPoller: runner.startPoller,
    stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus,
    isRunning,
    submitAction: actions.submitAction,
  };
}

type TeamReviewWiring = ReturnType<typeof createTeamReviewWiring>;

export {
  TEAM_REVIEW_ALLOW_TOOLS, TEAM_REVIEW_DENY_TOOLS,
  createTeamReviewActions, createTeamReviewDispatcher, createTeamReviewSpawn, createTeamReviewWiring, makeTeamReviewResultFile,
  emptyTeamReviewStatus, readReviewResult, sweepLeftoverCheckouts, teamReviewCfgKey, teamReviewClaudeArgs, teamReviewPermissions, teamReviewShouldStart,
};
export type {
  TeamReviewActionGithub, TeamReviewActionOptions, TeamReviewActionOutcome, TeamReviewDispatchOptions, TeamReviewDraftStore, TeamReviewGitWorkspace, TeamReviewRepoCache, TeamReviewSpawn, TeamReviewWiring,
  TeamReviewWiringConfig, TeamReviewWiringOptions,
};
