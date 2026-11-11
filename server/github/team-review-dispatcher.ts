import type { GithubLaneStore } from './github-store-wiring.ts';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type AwakeStopwatch, createAwakeTimeoutFn, startAwakeStopwatch } from '../awake-timer.ts';
import { readOnlyGitAllowRules } from '../lanes/core/lane-permissions-core.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import * as core from './core/team-review-core.ts';
import type { CommentableLines, NewWorkPointer, ReviewerChoice, TeamReviewCandidate, TeamReviewSettings } from './core/team-review-core.ts';
import { drainPending, firstLine, raceWithAbort } from '../lanes/ephemeral-session.ts';
import { headlessPromptLaunch } from '../lanes/lane-spawn.ts';
import { reapTeamReviewProcesses } from './team-review-reaper.ts';
import type { ReviewOutcome, SpawnReviewArgs } from './team-review-poller.ts';
import type { PostingPlan, PrDetail, PriorReview, ReviewResult, ReviewDraft } from '../../shared/contracts/team-review.ts';
import { errorMessage } from '../../shared/text.ts';
import { DEFAULT_TIMER_FNS } from '../../shared/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn } from '../../shared/timer-deps.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES, teamReviewAcceptEditsPermissions, hooksPathPinnedSpawnEnv, makeTeamReviewWorkDir } from './team-review-spawn.ts';
import type { TeamReviewWorkDir, TeamReviewSpawn } from './team-review-spawn.ts';
import { worktreeDirName, pathExists, isResumableInsideRoots, pruneCachedClone, deleteDirectory, deleteCheckout, findLocalCheckout, isLinkedToCheckout } from './team-review-checkouts.ts';
import type { TeamReviewWiringConfig, TeamReviewRepoCache, TeamReviewGitWorkspace, TeamReviewReap } from './team-review-checkouts.ts';
import { clock } from '../../shared/clock.ts';

const RESULT_MAX_BYTES = 1024 * 1024;

interface TeamReviewDispatchOptions {
  store: Pick<GithubLaneStore, 'requestPrDiff'>;
  repoCache: TeamReviewRepoCache;
  gitWorkspace: TeamReviewGitWorkspace;
  spawnSession: TeamReviewSpawn;
  worktreeRoot: string;
  workRoot: string;
  repoCacheRoot?: string | null;
  timeoutSeconds?: number;
  makeWorkDir?: (root: string, prefix: string) => Promise<TeamReviewWorkDir>;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  randomSuffix?: () => string;
  now?: () => number;
  shutdownSignal?: AbortSignal | null;
  readReviewSetup?: () => TeamReviewSetup;
  readLocalCheckoutConfig?: () => Pick<TeamReviewWiringConfig, 'projects' | 'repoRoots'>;
  reapProcesses?: TeamReviewReap;
  log?: Pick<Console, 'warn'>;
}

function teamReviewReadAllowRules({ checkoutPath, linkedCheckout }: { checkoutPath: string; linkedCheckout: string | null }): string[] {
  const readableDirectories = linkedCheckout === null ? [checkoutPath] : [checkoutPath, path.join(linkedCheckout, 'node_modules')];
  return readableDirectories.map(core.absolutePathReadRule);
}

type TeamReviewSetup = Pick<TeamReviewSettings, 'skill' | 'reviewer' | 'stampReviewer' | 'loadMcpServers'>;

const DEFAULT_TEAM_REVIEW_SETUP: TeamReviewSetup = Object.freeze({
  skill: '', reviewer: core.DEFAULT_REVIEWER, stampReviewer: null, loadMcpServers: false,
});

function teamReviewClaudeArgs(reviewer: ReviewerChoice, loadMcpServers: boolean, readable: { checkoutPath: string; linkedCheckout: string | null }, gitEnvPrefixes: readonly string[]): string[] {
  return [
    '-p', '--allowedTools', ...readOnlyGitAllowRules(readable.checkoutPath, gitEnvPrefixes), ...teamReviewReadAllowRules(readable), ...(loadMcpServers ? [] : ['--strict-mcp-config']),
    '--disallowedTools', ...TEAM_REVIEW_SESSION_DENY_RULES, ...core.reviewerAgentArgs(reviewer),
  ];
}

async function readReviewReport(reportPath: string, expectedHead: string, isReReview: boolean): Promise<{ ok: true; result: ReviewResult } | { ok: false; reason: string }> {
  let report: string;
  try {
    const stat = await fs.stat(reportPath);
    if (stat.size > RESULT_MAX_BYTES) return { ok: false, reason: 'the review report is too large' };
    report = await fs.readFile(reportPath, 'utf8');
  } catch {
    return { ok: false, reason: 'no review report' };
  }
  const parsed = core.parseReviewReport(report, { isReReview });
  if (!parsed.ok) return { ok: false, reason: firstLine(parsed.reason) };
  if (parsed.result.head !== expectedHead) return { ok: false, reason: `report head ${parsed.result.head} is not the reviewed head ${expectedHead}` };
  return parsed;
}

async function readPostingPlan(postingPath: string, expectedHead: string, log: Pick<Console, 'warn'>): Promise<PostingPlan | null> {
  let json: string;
  try {
    const stat = await fs.stat(postingPath);
    if (stat.size > RESULT_MAX_BYTES) {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] the posting plan is too large, rendering from the findings instead`);
      return null;
    }
    json = await fs.readFile(postingPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = core.parsePostingPlan(json, expectedHead);
  if (parsed.ok) return parsed.plan;
  log.warn(`[${core.TEAM_REVIEW_LANE_ID}] ${parsed.reason}, rendering from the findings instead`);
  return null;
}

function createTeamReviewDispatcher({
  store, repoCache, gitWorkspace, spawnSession, worktreeRoot, workRoot, repoCacheRoot = null,
  timeoutSeconds = core.REVIEW_TIMEOUT_SECONDS,
  makeWorkDir = makeTeamReviewWorkDir,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  randomSuffix = () => randomBytes(4).toString('hex'),
  now = () => clock.nowMs(),
  setTimeoutFn = createAwakeTimeoutFn({ now }),
  shutdownSignal = null,
  readReviewSetup = () => DEFAULT_TEAM_REVIEW_SETUP,
  readLocalCheckoutConfig = () => ({}),
  reapProcesses = reapTeamReviewProcesses,
  log = console,
}: TeamReviewDispatchOptions) {
  async function removeCheckout({ projectPath, worktreePath }: { projectPath: string; worktreePath: string }): Promise<void> {
    const removal = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: worktreePath, cause: 'team-review' })
      .catch((error: unknown) => ({ ok: false, err: errorMessage(error), removalKept: undefined }));
    if (removal.removalKept) return;
    if (removal.ok && !(await pathExists(worktreePath))) return;
    log.warn(`[${core.TEAM_REVIEW_LANE_ID}] worktree removal failed for ${worktreePath}, deleting it directly: ${firstLine(removal.err ?? '') || 'the directory is still present'}`);
    await deleteCheckout(gitWorkspace, worktreePath, log);
    await pruneCachedClone(gitWorkspace, projectPath, log);
  }

  async function discoverLocalCheckout(repo: string): Promise<string | null> {
    return findLocalCheckout({
      repo, config: readLocalCheckoutConfig(), excludedRoots: [repoCacheRoot, worktreeRoot, workRoot].filter((root): root is string => root !== null),
      gitWorkspace, log,
    });
  }

  async function resumedLinkedCheckout(repo: string, worktreePath: string): Promise<string | null> {
    const localCheckout = await discoverLocalCheckout(repo).catch((error: unknown) => {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] local checkout discovery failed for ${repo}: ${errorMessage(error)}`);
      return null;
    });
    if (!localCheckout) return null;
    return (await isLinkedToCheckout(worktreePath, localCheckout)) ? localCheckout : null;
  }

  async function hydrateBlobs(candidate: TeamReviewCandidate, detail: PrDetail): Promise<{ ok: boolean; err: string }> {
    return repoCache.hydrateRange(candidate.repo, detail.number, detail.headRefOid)
      .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
  }

  async function resumedRemergeGitEnvPrefixes(workDir: string, projectPath: string): Promise<string[]> {
    const scratchObjectsDir = path.join(workDir, core.REMERGE_OBJECTS_DIRNAME);
    if (!await pathExists(scratchObjectsDir)) return [];
    return [core.remergeGitEnvPrefix({ scratchObjectsDir, cloneObjectsDir: path.join(projectPath, '.git', 'objects') })];
  }

  async function pointAtNewWork(candidate: TeamReviewCandidate, detail: PrDetail, priorReview: PriorReview, workDir: string): Promise<NewWorkPointer | null> {
    if (!priorReview.base) return null;
    const isolation = await repoCache.isolateNewWork(candidate.repo, { number: detail.number, priorHead: priorReview.head, priorBase: priorReview.base, head: detail.headRefOid }).catch((error: unknown) => {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not isolate the new work since the earlier review of ${candidate.key}: ${errorMessage(error)}`);
      return null;
    });
    if (!isolation) return null;
    if (!isolation.ok) {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not isolate the new work since the earlier review of ${candidate.key}, reviewing the whole range: ${isolation.reason}`);
      return null;
    }
    const scratchObjectsDir = path.join(workDir, core.REMERGE_OBJECTS_DIRNAME);
    await fs.mkdir(scratchObjectsDir, { recursive: true });
    return { ...isolation.range, scratchObjectsDir };
  }

  async function stageCheckout(candidate: TeamReviewCandidate, detail: PrDetail): Promise<{ projectPath: string } | { error: string }> {
    const projectPath = await repoCache.ensureRepo(candidate.repo);
    if (!projectPath) return { error: `could not clone ${candidate.repo}` };
    const fetched = await repoCache.fetchPr(candidate.repo, detail.number, detail.baseRefName);
    if (!fetched.ok || !fetched.headSha) return { error: `could not fetch ${candidate.key}${fetched.err ? `: ${firstLine(fetched.err)}` : ''}` };
    if (fetched.headSha !== detail.headRefOid) {
      return { error: `fetched head ${fetched.headSha} is not the triaged head ${detail.headRefOid}` };
    }
    const hydrated = await repoCache.hydrateTree(candidate.repo, detail.headRefOid)
      .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
    if (!hydrated.ok) return { error: `could not fetch the file contents of ${candidate.key}${hydrated.err ? `: ${firstLine(hydrated.err)}` : ''}` };
    return { projectPath };
  }

  function spawnWithTimeout(
    { candidate, detail, tier, reasons, reportProgress, resume, priorReview, signal: cancelSignal, timeoutMs, workDir, checkoutPath, linkedCheckout, reportPath, postingPath, commentable, gitEnvPrefixes, onPending, onSessionId }: SpawnReviewArgs & {
      timeoutMs: number; workDir: string; checkoutPath: string; linkedCheckout: string | null; reportPath: string; postingPath: string; commentable: CommentableLines | null; gitEnvPrefixes: readonly string[];
      onPending: (pending: Promise<unknown>) => void;
      onSessionId: (id: string) => void;
    },
  ): Promise<ReviewDraft> {
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    const setup = readReviewSetup();
    const reviewer = core.reviewerFor(setup, tier);
    const resumeSessionId = resume?.sessionId;
    const promptLaunch = headlessPromptLaunch(core.REVIEW_AGENT_ADAPTER_ID, resumeSessionId ? core.REVIEW_RESUME_PROMPT : core.REVIEW_BOOTSTRAP_PROMPT);
    return raceWithAbort<ReviewDraft>({
      timeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => failed(`review timed out after ${timeoutSeconds}s`),
      onEmpty: () => failed('review ended without a result'),
      start: async (signal) => spawnSession({
        id: `${core.TEAM_REVIEW_LANE_ID}:${candidate.key}`,
        name: `Team review ${candidate.key}`,
        cwd: workDir,
        spawnEnv: hooksPathPinnedSpawnEnv(),
        agent: core.REVIEW_AGENT_ADAPTER_ID,
        extraClaudeArgs: [...teamReviewClaudeArgs(reviewer, setup.loadMcpServers, { checkoutPath, linkedCheckout }, gitEnvPrefixes), ...promptLaunch.args],
        settingsPermissions: teamReviewAcceptEditsPermissions(),
        signal: AbortSignal.any([signal, shutdownSignal, cancelSignal].filter((candidate): candidate is AbortSignal => candidate instanceof AbortSignal)),
        onSessionId,
        resumeSessionId,
        initialPrompt: promptLaunch.initialPrompt,
        onToolStep: (step) => reportProgress?.({ kind: 'step', ...step }),
      })
        .then(async () => {
          if (signal.aborted) return undefined;
          if (shutdownSignal?.aborted) return failed('review stopped by shutdown');
          const isReReview = priorReview != null;
          const outcome = await readReviewReport(reportPath, detail.headRefOid, isReReview);
          if (!outcome.ok) return failed(outcome.reason);
          const posting = await readPostingPlan(postingPath, detail.headRefOid, log);
          const filteredReview = core.reReviewResult(outcome.result, { priorReview: priorReview ?? null, posting });
          return core.readyDraft({ candidate, tier, reasons, ...filteredReview, reviewedBase: detail.baseRefOid, commentable, uiFiles: core.uiFilesOf(detail.files) });
        })
        .catch((error: unknown) => failed(firstLine(errorMessage(error)) || 'review session failed')),
    });
  }

  return async function reviewPullRequest(requestedArgs: SpawnReviewArgs): Promise<ReviewOutcome> {
    const isResumeOwned = requestedArgs.resume !== undefined && await isResumableInsideRoots(requestedArgs.resume, { workRoot, worktreeRoot });
    if (requestedArgs.resume && !isResumeOwned) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] ignored a saved review outside the review roots for ${requestedArgs.candidate.key}`);
    const args: SpawnReviewArgs = isResumeOwned ? requestedArgs : { ...requestedArgs, resume: undefined };
    const { candidate, detail, tier, reasons, reportProgress = () => {} } = args;
    if (shutdownSignal?.aborted && args.resume) {
      await reapProcesses({ ownedDirectories: [args.resume.workDir, args.resume.worktreePath], reviewRoots: [workRoot, worktreeRoot], scope: 'run', log }).catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
      const hasWorkDir = await pathExists(args.resume.workDir);
      const hasWorktree = await pathExists(args.resume.worktreePath);
      if (hasWorkDir && hasWorktree) return { kind: 'stopped', resumable: { ...args.resume, savedAt: now() } };
      if (hasWorkDir) await deleteDirectory(args.resume.workDir, log);
      if (hasWorktree) await deleteCheckout(gitWorkspace, args.resume.worktreePath, log);
      return { kind: 'stopped', resumable: null };
    }
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    const startedAt = now();
    let sessionId = args.resume?.sessionId ?? null;
    let deadlineAt = startedAt + timeoutSeconds * 1000;
    let timeoutBudgetMs = timeoutSeconds * 1000;
    const resources: {
      workDirHandle: TeamReviewWorkDir | null; checkout: { projectPath: string; worktreePath: string } | null; awakeStopwatch: AwakeStopwatch | null;
    } = { workDirHandle: null, checkout: null, awakeStopwatch: null };
    let pendingSession: Promise<unknown> | null = null;
    let shouldPreserve = false;
    let draft: ReviewDraft;
    async function runReview(): Promise<ReviewDraft> {
      if (shutdownSignal?.aborted) return failed('review stopped by shutdown');
      if (args.resume) {
        const hasWorkDir = await pathExists(args.resume.workDir);
        const hasWorktree = await pathExists(args.resume.worktreePath);
        if (hasWorkDir && hasWorktree) {
          const projectPath = await repoCache.ensureRepo(candidate.repo);
          if (projectPath) {
            timeoutBudgetMs = core.resumeTimeoutMs(args.resume, now());
            deadlineAt = now() + timeoutBudgetMs;
            const resumedWorkDir = args.resume.workDir;
            resources.workDirHandle = { dir: resumedWorkDir, cleanup: () => deleteDirectory(resumedWorkDir, log) };
            resources.checkout = { projectPath, worktreePath: args.resume.worktreePath };
            await reapProcesses({ ownedDirectories: [resumedWorkDir, args.resume.worktreePath], reviewRoots: [workRoot, worktreeRoot], scope: 'run', log }).catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
            const diffRead = await store.requestPrDiff(candidate.repo, detail.number, detail.headRefOid);
            const diff = diffRead.isRateLimited ? null : diffRead.value;
            reportProgress({ kind: 'phase', phase: 'reviewing', tier, reasons, timeoutSeconds: timeoutBudgetMs / 1000 });
            resources.awakeStopwatch = startAwakeStopwatch({ now });
            return spawnWithTimeout({
              ...args, timeoutMs: timeoutBudgetMs, workDir: args.resume.workDir, checkoutPath: args.resume.worktreePath, linkedCheckout: await resumedLinkedCheckout(candidate.repo, args.resume.worktreePath),
              reportPath: path.join(args.resume.workDir, core.REVIEW_REPORT_FILENAME),
              postingPath: path.join(args.resume.workDir, core.REVIEW_POSTING_FILENAME),
              commentable: diff === null ? null : core.commentableLines(diff),
              gitEnvPrefixes: await resumedRemergeGitEnvPrefixes(args.resume.workDir, projectPath),
              onPending: (pending) => { pendingSession = pending; },
              onSessionId: (id) => { sessionId = id; },
            });
          }
        }
        await reapProcesses({ ownedDirectories: [args.resume.workDir, args.resume.worktreePath], reviewRoots: [workRoot, worktreeRoot], scope: 'run', log })
          .catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
        if (hasWorktree) {
          const projectPath = await repoCache.ensureRepo(candidate.repo);
          if (projectPath) await removeCheckout({ projectPath, worktreePath: args.resume.worktreePath });
          if (!projectPath) await deleteCheckout(gitWorkspace, args.resume.worktreePath, log);
        }
        if (hasWorkDir) await deleteDirectory(args.resume.workDir, log);
        sessionId = null;
      }
      resources.workDirHandle = await makeWorkDir(workRoot, `${candidate.repo}-${detail.number}`);
      const workDir = resources.workDirHandle.dir;
      const reportPath = path.join(workDir, core.REVIEW_REPORT_FILENAME);
      const postingPath = path.join(workDir, core.REVIEW_POSTING_FILENAME);
      const diffRead = await store.requestPrDiff(candidate.repo, detail.number, detail.headRefOid);
      const diff = diffRead.isRateLimited ? null : diffRead.value;
      reportProgress({ kind: 'phase', phase: 'checkout', tier, reasons });
      const staged = await stageCheckout(candidate, detail);
      if ('error' in staged) return failed(staged.error);
      const worktreePath = path.join(worktreeRoot, worktreeDirName(candidate.repo, detail.number, randomSuffix()));
      resources.checkout = { projectPath: staged.projectPath, worktreePath };
      await fs.mkdir(worktreeRoot, { recursive: true });
      const created = await gitWorkspace.stageDetachedWorktree({ projectPath: staged.projectPath, owner: 'lane:team-review', worktreePath, sha: detail.headRefOid });
      if (!created.ok) return failed(`could not stage a checkout: ${firstLine(created.err ?? '') || 'git worktree add failed'}`);
      const hydrated = await hydrateBlobs(candidate, detail);
      if (!hydrated.ok) return failed(`could not fetch the file contents of ${candidate.key}${hydrated.err ? `: ${firstLine(hydrated.err)}` : ''}`);
      const priorReview = args.priorReview ?? null;
      const newWork = priorReview ? await pointAtNewWork(candidate, detail, priorReview, workDir) : null;
      let linkedCheckout: string | null = null;
      try {
        const localCheckout = await discoverLocalCheckout(candidate.repo);
        if (localCheckout) {
          await gitWorkspace.populate({ projectPath: localCheckout, wtDir: worktreePath, shareList: ['node_modules'], keepTrackableLinks: true });
          const isModulesLinked = await isLinkedToCheckout(worktreePath, localCheckout);
          linkedCheckout = isModulesLinked ? localCheckout : null;
          if (!isModulesLinked) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] node_modules could not be linked from ${localCheckout}`);
        }
      } catch (error) {
        log.warn(`[${core.TEAM_REVIEW_LANE_ID}] node_modules sharing failed for ${candidate.key}: ${errorMessage(error)}`);
      }
      const reviewSetup = readReviewSetup();
      const prompt = core.buildReviewPrompt({
        candidate, detail, tier, reasons, checkoutPath: worktreePath, reportPath, postingPath, reviewSkill: reviewSetup.skill,
        priorReview, newWork, sameHeadReview: args.sameHeadReview ?? null,
      });
      await fs.writeFile(path.join(workDir, core.REVIEW_PROMPT_FILENAME), prompt, 'utf8');
      await writeUntrustedPayload(workDir, {
        trust: 'untrusted', source: core.TEAM_REVIEW_LANE_ID, fetchedAt: new Date(now()).toISOString(), items: core.reviewUntrustedItems(detail, priorReview, args.sameHeadReview ?? null),
      }, core.REVIEW_UNTRUSTED_ITEM_MAX_CHARS);
      reportProgress({ kind: 'phase', phase: 'reviewing', tier, reasons, timeoutSeconds });
      resources.awakeStopwatch = startAwakeStopwatch({ now });
      return await spawnWithTimeout({
        ...args, resume: undefined, timeoutMs: timeoutBudgetMs, workDir, checkoutPath: worktreePath, linkedCheckout, reportPath, postingPath, commentable: diff === null ? null : core.commentableLines(diff),
        gitEnvPrefixes: newWork ? [core.remergeGitEnvPrefix(newWork)] : [],
        onPending: (pending) => { pendingSession = pending; },
        onSessionId: (id) => { sessionId = id; },
      });
    }
    try {
      draft = await runReview();
    } catch (error) {
      draft = failed(firstLine(errorMessage(error)) || 'review failed');
    }
    try {
      await drainPending(pendingSession);
      if (shutdownSignal?.aborted && draft.status === 'error') {
        const workDir = resources.workDirHandle?.dir;
        const worktreePath = resources.checkout?.worktreePath;
        if (sessionId && workDir && worktreePath && await pathExists(workDir) && await pathExists(worktreePath)) {
          shouldPreserve = true;
          return { kind: 'stopped', resumable: {
            sessionId, workDir, worktreePath, head: detail.headRefOid,
            deadlineAt,
            remainingAwakeMs: Math.max(0, timeoutBudgetMs - (resources.awakeStopwatch?.awakeElapsedMs() ?? 0)),
            savedAt: now(),
          } };
        }
        return { kind: 'stopped', resumable: null };
      }
      return draft;
    } finally {
      resources.awakeStopwatch?.stop();
      const reviewWorkDir = resources.workDirHandle?.dir;
      if (reviewWorkDir !== undefined) {
        await reapProcesses({ ownedDirectories: [reviewWorkDir, resources.checkout?.worktreePath].filter((directory): directory is string => directory !== undefined), reviewRoots: [workRoot, worktreeRoot], scope: 'run', log })
          .catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
      }
      if (!shouldPreserve) {
        if (resources.checkout) await removeCheckout(resources.checkout);
        if (resources.workDirHandle) await resources.workDirHandle.cleanup();
      }
    }
  };
}

export { createTeamReviewDispatcher };
export type { TeamReviewDispatchOptions };
