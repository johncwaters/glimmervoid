import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { trailStepFromHook } from './core/investigation-trail-core.ts';
import * as core from './core/team-review-core.ts';
import type { CommentableLines, ReviewTier, TeamReviewCandidate } from './core/team-review-core.ts';
import {
  awaitSessionExit, drainPending, firstLine, raceWithAbort,
  registerEphemeralSession,
} from './ephemeral-session.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';
import { createJsonStateStore } from './json-file.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { LaneRunnerGate, LaneStatusRecord } from './lane-runner.ts';
import { createPrGh } from './pr-gh.ts';
import type { PrGh } from './pr-gh.ts';
import { createRepoCache } from './repo-cache.ts';
import { createTeamReviewPoller } from './team-review-poller.ts';
import type { DraftExpectation, DraftPatch, ReviewOutcome, SpawnReviewArgs, TeamReviewGithub, TeamReviewPoller } from './team-review-poller.ts';
import { TeamReviewStateEntry, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type {
  PostingPlan, PrDetail, ResumableReview, ReviewComment, ReviewResult, ReviewDraft, TeamReviewActionRequest, TeamReviewActionResult,
  TeamReviewState as TeamReviewStateType, TeamReviewStateEntry as TeamReviewStateEntryType, TeamReviewStatus as TeamReviewStatusType,
} from '../shared/contracts/team-review.ts';

const TEAM_REVIEW_DENY_RULES = Object.freeze([
  'Bash(gh:*)',
  'Bash(git push:*)',
  'Bash(curl:*api.github.com*)',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
]);
const TEAM_REVIEW_ALLOWED_DOMAINS = Object.freeze([
  'api.github.com',
  'chatgpt.com',
  '*.chatgpt.com',
  'auth.openai.com',
  'api.openai.com',
  '*.openai.com',
]);
const TEAM_REVIEW_DENY_READ_PATHS = Object.freeze(['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.git-credentials']);
const CODEX_HOME_PATH = '~/.codex';
const RESULT_MAX_BYTES = 1024 * 1024;
const EMPTY_GH_CONFIG_DIRNAME = 'gh-config';
const PUSH_DISABLED_URL = 'https://push-disabled.invalid/';
const REPLACED_DRAFT_ERROR = 'The draft was replaced after it was shown. Read the new draft before acting on it';
const STALE_APPROVAL_DISMISSAL = 'The pull request moved while this approval was posting, so it no longer covers the current head.';
const UNMARKED_POST_WARNING = 'The review was posted on GitHub, but its draft could not be marked posted. Do not post it again';

interface TeamReviewWiringConfig {
  teamReview?: Record<string, unknown> | null;
  replayBufferKB?: number;
}

type TeamReviewSandbox = {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  enableWeakerNetworkIsolation: true;
  network: { strictAllowlist: true; allowLocalBinding: true; allowAllUnixSockets: true; allowedDomains: string[] };
  filesystem: { allowWrite: string[]; denyRead: string[] };
};

interface TeamReviewSettings {
  enabled: boolean;
  org: string;
  team: string;
}

interface TeamReviewRepoCache {
  listRepos(): Promise<string[]>;
  ensureRepo(repo: string): Promise<string | null>;
  fetchPr(repo: string, number: number, baseRef: string): Promise<{ ok: boolean; headSha: string | null; err: string }>;
  hydrateRange(repo: string, number: number, headSha: string): Promise<{ ok: boolean; err: string }>;
}

interface TeamReviewWorkDir {
  dir: string;
  cleanup(): Promise<void>;
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
  spawnEnv: Record<string, string>;
  extraClaudeArgs: string[];
  settingsPermissions: { deny: string[]; defaultMode: string };
  settingsSandbox: TeamReviewSandbox;
  signal: AbortSignal;
  onSessionId?: (id: string) => void;
  resumeSessionId?: string | null;
  initialPrompt?: string;
  onToolStep?: (step: { tool: string; detail: string }) => void;
}) => Promise<void>;

interface TeamReviewDispatchOptions {
  github: { prDiff(repo: string, number: number): Promise<string | null> };
  repoCache: TeamReviewRepoCache;
  gitWorkspace: TeamReviewGitWorkspace;
  spawnSession: TeamReviewSpawn;
  worktreeRoot: string;
  workRoot: string;
  timeoutSeconds?: number;
  makeWorkDir?: (root: string, prefix: string) => Promise<TeamReviewWorkDir>;
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
  randomSuffix?: () => string;
  now?: () => number;
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
  requeue(key: string, head: string): Promise<boolean>;
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

function teamReviewPermissions(): { deny: string[]; defaultMode: string } {
  return { deny: [...TEAM_REVIEW_DENY_RULES], defaultMode: 'bypassPermissions' };
}

function teamReviewSandbox(workDir: string): TeamReviewSandbox {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    enableWeakerNetworkIsolation: true,
    network: {
      strictAllowlist: true,
      allowLocalBinding: true,
      allowAllUnixSockets: true,
      allowedDomains: [...TEAM_REVIEW_ALLOWED_DOMAINS],
    },
    filesystem: {
      allowWrite: [CODEX_HOME_PATH, workDir],
      denyRead: [...TEAM_REVIEW_DENY_READ_PATHS],
    },
  };
}

function teamReviewClaudeArgs(tier: ReviewTier): string[] {
  const model = tier === 'full' ? core.FULL_MODEL : core.STAMP_MODEL;
  return ['-p', '--strict-mcp-config', '--disallowedTools', ...TEAM_REVIEW_DENY_RULES, '--model', model];
}

function emptyGhConfigDir(workDir: string): string {
  return path.join(workDir, EMPTY_GH_CONFIG_DIRNAME);
}

function teamReviewSpawnEnv(workDir: string): Record<string, string> {
  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    GH_CONFIG_DIR: emptyGhConfigDir(workDir),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: PUSH_DISABLED_URL,
    GLIMMERVOID_POSTHOG_API_KEY: '',
    GLIMMERVOID_TELEGRAM_BOT_TOKEN: '',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
}

async function makeTeamReviewWorkDir(root: string, prefix: string): Promise<TeamReviewWorkDir> {
  const safePrefix = `glimmervoid-wt-${core.TEAM_REVIEW_LANE_ID}-${prefix}`.replace(/[^\w.-]+/g, '-');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, `${safePrefix}-`));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

async function readReviewReport(reportPath: string, expectedHead: string): Promise<{ ok: true; result: ReviewResult } | { ok: false; reason: string }> {
  let report: string;
  try {
    const stat = await fs.stat(reportPath);
    if (stat.size > RESULT_MAX_BYTES) return { ok: false, reason: 'the pr-review report is too large' };
    report = await fs.readFile(reportPath, 'utf8');
  } catch {
    return { ok: false, reason: 'no pr-review report' };
  }
  const parsed = core.parseReviewReport(report);
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

function worktreeDirName(repo: string, number: number, suffix: string): string {
  return `glimmervoid-wt-${core.TEAM_REVIEW_LANE_ID}-${repo.replace(/[^\w.-]+/g, '-')}-${number}-${suffix}`;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return fs.lstat(candidatePath).then(() => true, () => false);
}

function isDirectChildOf(root: string, candidatePath: string): boolean {
  return path.dirname(path.resolve(candidatePath)) === path.resolve(root);
}

function isOwnedResumable(record: ResumableReview, roots: { workRoot: string; worktreeRoot: string }): boolean {
  return isDirectChildOf(roots.workRoot, record.workDir) && isDirectChildOf(roots.worktreeRoot, record.worktreePath);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function isRealChildDirectoryOrMissing(root: string, candidatePath: string): Promise<boolean> {
  if (!isDirectChildOf(root, candidatePath)) return false;
  const candidateStat = await fs.lstat(candidatePath).catch((error: unknown) => (isMissingPathError(error) ? 'missing' : null));
  if (candidateStat === 'missing') return true;
  if (!candidateStat?.isDirectory()) return false;
  const realPaths = await Promise.all([fs.realpath(candidatePath), fs.realpath(root)]).catch(() => null);
  if (!realPaths) return false;
  const [realCandidatePath, realRootPath] = realPaths;
  return path.dirname(realCandidatePath) === realRootPath;
}

async function isResumableInsideRoots(record: ResumableReview, roots: { workRoot: string; worktreeRoot: string }): Promise<boolean> {
  const [isWorkDirInside, isWorktreeInside] = await Promise.all([
    isRealChildDirectoryOrMissing(roots.workRoot, record.workDir),
    isRealChildDirectoryOrMissing(roots.worktreeRoot, record.worktreePath),
  ]);
  return isWorkDirInside && isWorktreeInside;
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

async function sweepLeftoverCheckouts({ worktreeRoot, workRoot, keepPaths, repoCache, gitWorkspace, log }: {
  worktreeRoot: string;
  workRoot: string;
  keepPaths: ReadonlySet<string>;
  repoCache: Pick<TeamReviewRepoCache, 'listRepos'>;
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees'>;
  log: Pick<Console, 'warn'>;
}): Promise<void> {
  for (const root of [worktreeRoot, workRoot]) {
    const leftoverNames = await fs.readdir(root).catch(() => []);
    for (const leftoverName of leftoverNames) {
      const directory = path.join(root, leftoverName);
      if (keepPaths.has(directory)) continue;
      await deleteDirectory(directory, log);
    }
  }
  const cachedClones = await repoCache.listRepos()
    .catch((error: unknown) => { log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not list cached clones: ${errorMessage(error)}`); return []; });
  for (const projectPath of cachedClones) await pruneCachedClone(gitWorkspace, projectPath, log);
}

function createTeamReviewDispatcher({
  github, repoCache, gitWorkspace, spawnSession, worktreeRoot, workRoot,
  timeoutSeconds = core.REVIEW_TIMEOUT_SECONDS,
  makeWorkDir = makeTeamReviewWorkDir,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = clearTimeout,
  randomSuffix = () => randomBytes(4).toString('hex'),
  now = () => Date.now(),
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

  async function hydrateBlobs(candidate: TeamReviewCandidate, detail: PrDetail): Promise<{ ok: boolean; err: string }> {
    return repoCache.hydrateRange(candidate.repo, detail.number, detail.headRefOid)
      .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
  }

  async function stageCheckout(candidate: TeamReviewCandidate, detail: PrDetail): Promise<{ projectPath: string } | { error: string }> {
    const projectPath = await repoCache.ensureRepo(candidate.repo);
    if (!projectPath) return { error: `could not clone ${candidate.repo}` };
    const fetched = await repoCache.fetchPr(candidate.repo, detail.number, detail.baseRefName);
    if (!fetched.ok || !fetched.headSha) return { error: `could not fetch ${candidate.key}${fetched.err ? `: ${firstLine(fetched.err)}` : ''}` };
    if (fetched.headSha !== detail.headRefOid) {
      return { error: `fetched head ${fetched.headSha} is not the triaged head ${detail.headRefOid}` };
    }
    return { projectPath };
  }

  function spawnWithTimeout(
    { candidate, detail, tier, reasons, reportProgress, resume, workDir, reportPath, postingPath, commentable, onPending, onSessionId }: SpawnReviewArgs & {
      workDir: string; reportPath: string; postingPath: string; commentable: CommentableLines | null;
      onPending: (pending: Promise<unknown>) => void;
      onSessionId: (id: string) => void;
    },
  ): Promise<ReviewDraft> {
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    const remainingTimeoutMs = resume ? Math.max(0, resume.deadlineAt - now()) : timeoutSeconds * 1000;
    return raceWithAbort<ReviewDraft>({
      timeoutMs: remainingTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
      onPending,
      onTimeout: () => failed(`review timed out after ${timeoutSeconds}s`),
      onEmpty: () => failed('review ended without a result'),
      start: (signal) => spawnSession({
        id: `${core.TEAM_REVIEW_LANE_ID}:${candidate.key}`,
        name: `Team review ${candidate.key}`,
        cwd: workDir,
        spawnEnv: teamReviewSpawnEnv(workDir),
        extraClaudeArgs: teamReviewClaudeArgs(tier),
        settingsPermissions: teamReviewPermissions(),
        settingsSandbox: teamReviewSandbox(workDir),
        signal: shutdownSignal ? AbortSignal.any([signal, shutdownSignal]) : signal,
        onSessionId,
        resumeSessionId: resume?.sessionId,
        initialPrompt: resume ? core.REVIEW_RESUME_PROMPT : core.REVIEW_BOOTSTRAP_PROMPT,
        onToolStep: (step) => reportProgress?.({ kind: 'step', ...step }),
      })
        .then(async () => {
          if (signal.aborted) return undefined;
          if (shutdownSignal?.aborted) return failed('review stopped by shutdown');
          const outcome = await readReviewReport(reportPath, detail.headRefOid);
          if (!outcome.ok) return failed(outcome.reason);
          const posting = await readPostingPlan(postingPath, detail.headRefOid, log);
          return core.readyDraft({ candidate, tier, reasons, result: outcome.result, commentable, posting });
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
      const hasWorkDir = await pathExists(args.resume.workDir);
      const hasWorktree = await pathExists(args.resume.worktreePath);
      if (hasWorkDir && hasWorktree) return { kind: 'stopped', resumable: { ...args.resume, savedAt: now() } };
      if (hasWorkDir) await deleteDirectory(args.resume.workDir, log);
      if (hasWorktree) await deleteDirectory(args.resume.worktreePath, log);
      return { kind: 'stopped', resumable: null };
    }
    const failed = (error: string) => core.errorDraft({ candidate, tier, reasons, reviewedHead: detail.headRefOid, error });
    const startedAt = now();
    let sessionId = args.resume?.sessionId ?? null;
    let deadlineAt = startedAt + timeoutSeconds * 1000;
    const resources: { workDirHandle: TeamReviewWorkDir | null; checkout: { projectPath: string; worktreePath: string } | null } = { workDirHandle: null, checkout: null };
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
            deadlineAt = args.resume.deadlineAt;
            const resumedWorkDir = args.resume.workDir;
            resources.workDirHandle = { dir: resumedWorkDir, cleanup: () => deleteDirectory(resumedWorkDir, log) };
            resources.checkout = { projectPath, worktreePath: args.resume.worktreePath };
            const diff = await github.prDiff(candidate.repo, detail.number);
            const remainingTimeoutSeconds = Math.max(0, (args.resume.deadlineAt - now()) / 1000);
            reportProgress({ kind: 'phase', phase: 'reviewing', tier, reasons, timeoutSeconds: remainingTimeoutSeconds });
            return spawnWithTimeout({
              ...args, workDir: args.resume.workDir,
              reportPath: path.join(args.resume.workDir, core.REVIEW_REPORT_FILENAME),
              postingPath: path.join(args.resume.workDir, core.REVIEW_POSTING_FILENAME),
              commentable: diff === null ? null : core.commentableLines(diff),
              onPending: (pending) => { pendingSession = pending; },
              onSessionId: (id) => { sessionId = id; },
            });
          }
        }
        if (hasWorktree) {
          const projectPath = await repoCache.ensureRepo(candidate.repo);
          if (projectPath) await removeCheckout({ projectPath, worktreePath: args.resume.worktreePath });
          if (!projectPath) await deleteDirectory(args.resume.worktreePath, log);
        }
        if (hasWorkDir) await deleteDirectory(args.resume.workDir, log);
        sessionId = null;
      }
      resources.workDirHandle = await makeWorkDir(workRoot, `${candidate.repo}-${detail.number}`);
      const workDir = resources.workDirHandle.dir;
      const reportPath = path.join(workDir, core.REVIEW_REPORT_FILENAME);
      const postingPath = path.join(workDir, core.REVIEW_POSTING_FILENAME);
      const diff = await github.prDiff(candidate.repo, detail.number);
      reportProgress({ kind: 'phase', phase: 'checkout', tier, reasons });
      const staged = await stageCheckout(candidate, detail);
      if ('error' in staged) return failed(staged.error);
      const worktreePath = path.join(worktreeRoot, worktreeDirName(candidate.repo, detail.number, randomSuffix()));
      resources.checkout = { projectPath: staged.projectPath, worktreePath };
      await fs.mkdir(worktreeRoot, { recursive: true });
      const created = await gitWorkspace.stageDetachedWorktree({ projectPath: staged.projectPath, worktreePath, sha: detail.headRefOid });
      if (!created.ok) return failed(`could not stage a checkout: ${firstLine(created.err ?? '') || 'git worktree add failed'}`);
      const hydrated = await hydrateBlobs(candidate, detail);
      if (!hydrated.ok) return failed(`could not fetch the file contents of ${candidate.key}${hydrated.err ? `: ${firstLine(hydrated.err)}` : ''}`);
      const prompt = core.buildReviewPrompt({ candidate, detail, tier, reasons, checkoutPath: worktreePath, reportPath, postingPath });
      await fs.writeFile(path.join(workDir, core.REVIEW_PROMPT_FILENAME), prompt, 'utf8');
      await fs.mkdir(emptyGhConfigDir(workDir), { recursive: true });
      reportProgress({ kind: 'phase', phase: 'reviewing', tier, reasons, timeoutSeconds });
      return await spawnWithTimeout({
        ...args, resume: undefined, workDir, reportPath, postingPath, commentable: diff === null ? null : core.commentableLines(diff),
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
            savedAt: now(),
          } };
        }
        return { kind: 'stopped', resumable: null };
      }
      return draft;
    } finally {
      if (!shouldPreserve) {
        if (resources.checkout) await removeCheckout(resources.checkout);
        if (resources.workDirHandle) await resources.workDirHandle.cleanup();
      }
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
  return async function spawnTeamReviewSession({ id, name, cwd, spawnEnv, extraClaudeArgs, settingsPermissions, settingsSandbox, signal, onToolStep, onSessionId, resumeSessionId, initialPrompt }) {
    const sess = makeSession({
      id,
      name,
      path: cwd,
      spawnEnv,
      dangerouslySkipPermissions: true,
      extraClaudeArgs,
      initialPrompt: initialPrompt ?? core.REVIEW_BOOTSTRAP_PROMPT,
      resumeSessionId,
      ephemeral: true,
      observeToolCalls: onToolStep !== undefined,
      settingsPermissions,
      settingsSandbox,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({
      map: reviewSessions, id, sess, closeSessionDataClients, logPrefix: core.TEAM_REVIEW_LANE_ID, name, recordLane,
    });
    if (onSessionId) sess.on('claude-session-id', ({ id: capturedId }: { id: string }) => onSessionId(capturedId));
    if (onToolStep) {
      sess.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
        const step = trailStepFromHook(event, payload);
        if (step) onToolStep(step);
      });
    }
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
    if (request.action === 'requeue') {
      const isQueued = await drafts.requeue(request.key, request.head);
      return isQueued ? { ok: true } : { ok: false, error: 'only a failed or ready review can be queued again' };
    }
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
  const workRoot = path.join(homeDir, 'team-review-work');
  const shutdownController = new AbortController();
  const inFlightReviews = new Set<Promise<ReviewOutcome>>();
  const reviewPullRequest = createTeamReviewDispatcher({
    github, repoCache, gitWorkspace, spawnSession, worktreeRoot, workRoot, shutdownSignal: shutdownController.signal, log,
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
        beforeStart: (keepPaths) => sweepLeftoverCheckouts({ worktreeRoot, workRoot, keepPaths, repoCache, gitWorkspace, log }),
        discardResumable: async (record) => {
          if (!isOwnedResumable(record, { workRoot, worktreeRoot })) return;
          await deleteDirectory(record.worktreePath, log);
          await deleteDirectory(record.workDir, log);
          const cachedClones = await repoCache.listRepos();
          for (const projectPath of cachedClones) await pruneCachedClone(gitWorkspace, projectPath, log);
        },
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

  async function requeue(key: string, head: string): Promise<boolean> {
    return (await runner.getPoller()?.requeue(key, head)) ?? false;
  }

  function isRunning(): boolean {
    return runner.getPoller() !== null;
  }

  const actions = createTeamReviewActions({
    drafts: { getDraft, updateDraft, requeue },
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
  TEAM_REVIEW_DENY_RULES,
  createTeamReviewActions, createTeamReviewDispatcher, createTeamReviewSpawn, createTeamReviewStateIo, createTeamReviewWiring, makeTeamReviewWorkDir,
  emptyTeamReviewStatus, readReviewReport, sweepLeftoverCheckouts, teamReviewCfgKey, teamReviewClaudeArgs, teamReviewPermissions, teamReviewSandbox, teamReviewShouldStart, teamReviewSpawnEnv,
};
export type {
  TeamReviewActionGithub, TeamReviewActionOptions, TeamReviewActionOutcome, TeamReviewDispatchOptions, TeamReviewDraftStore, TeamReviewGitWorkspace, TeamReviewRepoCache, TeamReviewSandbox, TeamReviewSpawn, TeamReviewWiring,
  TeamReviewWiringConfig, TeamReviewWiringOptions, TeamReviewWorkDir,
};
