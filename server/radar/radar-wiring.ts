
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { resolveHookTools as resolveSharedHookTools, resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { stableConfigKey } from '../core/config-secrets-core.ts';
import { appendTrailStep, createInvestigationTrail, trailNotesFromTranscriptLines, trailStepFromHook } from '../core/investigation-trail-core.ts';
import { MAX_TRANSCRIPT_READ_BYTES, completeLineBytes, planContiguousRead } from '../core/trace-tail-core.ts';
import { openContainedFile } from '../contained-file.ts';
import { claudeProjectsDir } from '../../session/core/conversation-history.ts';
import type { InvestigationTrail } from '../core/investigation-trail-core.ts';
import * as core from './core/radar-lane-core.ts';
import type { InvestigationRecord, PendingFix, PosthogIssue } from './core/radar-lane-core.ts';
import {
  awaitSessionExit, createJobResultFile, readResultFile, registerEphemeralSession,
} from '../lanes/ephemeral-session.ts';
import type { JobResultFile, RecordLane, ResultFileOutcome, SpawnGate } from '../lanes/ephemeral-session.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';
import type { LaneStatusRecord } from '../lanes/lane-runner.ts';
import { emptyLaneStatus } from '../lanes/lane-status.ts';
import { loadJsonStateFile, loadedJsonValue, writeJsonAtomic } from '../json-file.ts';
import { createPosthogApi, extractRows } from './posthog-api.ts';
import type { PosthogApi } from './posthog-api.ts';
import { createRadarPoller } from './radar-poller.ts';
import { createWatcheeFeed } from '../lanes/watchee-feed.ts';
import { isOlderObservation } from '../lanes/core/watchee-feed-core.ts';
import type { RadarProjectPayload } from '../../shared/contracts/radar-project.ts';
import { bootStaggerDelay } from '../boot-stagger.ts';
import type { PosthogState, SpawnInvestigationArgs } from './radar-poller.ts';
import { DEFAULT_POSTHOG_REPORT_DIR } from './radar-report.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import { prepareLaneMcp } from '../lanes/lane-mcp.ts';
import { buildLanePermissions, CLOSED_LANE_ACCESS_CONFIG, laneAccess, withAllowRules, withLaneAccessRules } from '../lanes/core/lane-permissions-core.ts';
import type { LaneAccessConfig } from '../lanes/core/lane-permissions-core.ts';
import { makeLaneGhConfigDirectory } from '../lanes/lane-spawn.ts';
import { UNTRUSTED_PAYLOAD_FILENAME } from '../../shared/contracts/untrusted-payload.ts';
import { configuredIntegrationBranch } from '../core/integration-branch-core.ts';
import type { RadarErrorReason } from '../../shared/contracts/telemetry.ts';
import type { Telemetry } from '../telemetry.ts';
import { errorMessage } from '../../shared/text.ts';
import { isRecord } from '../../shared/coerce.ts';
import { createCoalescedTimer } from '../../shared/coalesce-timer.ts';
import type { OwnedPathOwner } from '../../shared/contracts/owned-paths.ts';
import { FIX_POSTURE, investigationPosture, radarClaudeArgs, withLaneAccessTools } from './radar-posture.ts';
import type { RadarToolPosture } from './radar-posture.ts';
import { buildFixPrompt, buildInvestigationPrompt, fallbackPrBody, fallbackPrTitle, promptIssueUrl, safeIssueId } from './radar-prompts.ts';
import { checkFixBranch, commitFixWork, handoffFailure, readWorktreeGitPointer, runCli } from './radar-fix-handoff.ts';
import type { CliResult, PosthogWorkspace } from './radar-fix-handoff.ts';

const REPORT_DIR = DEFAULT_POSTHOG_REPORT_DIR;
const REPORT_RETAIN_FILES = 20;
const FORCE_TICK_DEBOUNCE_MS = 3000;

interface RadarLaneConfig {
  enabled?: boolean;
  apiKey?: string;
  host?: string;
  autoFix?: boolean;
  fixTimeoutSeconds?: number;
  intervalMinutes?: number;
  investigationTimeoutSeconds?: number;
  maxConcurrentInvestigations?: number;
  minUsersToInvestigate?: number;
  projectMap?: Record<string, string>;
  projects?: (string | number)[] | 'all';
  recurrenceDedupe?: boolean;
  recurrenceWindowDays?: number;
  repoPath?: string;
  trafficSpikeBaselineDays?: number;
  trafficSpikeCooldownMinutes?: number;
  trafficSpikeEnabled?: boolean;
  trafficSpikeMinUsers?: number;
  trafficSpikeMultiplier?: number;
  transientRecurrenceLimit?: number;
  userEscalationThreshold?: number;
}

interface RadarWiringConfig {
  replayBufferKB?: number;
  worktreeRoot?: string;
  integrationBranch?: string | null;
  saneYolo?: boolean;
  saneYoloUnreadablePaths?: readonly string[];
  posthog?: RadarLaneConfig | null;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface PosthogGitWorkspace {
  create: (options: {
    projectPath: string;
    owner: OwnedPathOwner;
    teamId: string;
    label: string;
    worktreeBase: string;
    baseBranch?: string | null;
    forkFromHead?: boolean;
  }) => Promise<PosthogWorkspace | null> | PosthogWorkspace | null;
  discard: (options: { projectPath: string; workspace: PosthogWorkspace; cause: 'radar' }) => Promise<unknown> | unknown;
}

interface InvestigationSessionRequest {
  id: string;
  name: string;
  path: string;
  initialPrompt: string;
  posture: RadarToolPosture;
  onActivity?: ((trail: InvestigationTrail) => void) | null;
}

interface RadarWiringOptions {
  config: RadarWiringConfig;
  getLaneAccessConfig?: () => LaneAccessConfig;
  investigationSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  gitWorkspace?: PosthogGitWorkspace | null;
  runCommand?: (cmd: string, args: string[], cwd: string) => Promise<CliResult>;
  broadcast?: (message: LaneStatusRecord) => void;
  recordLane?: RecordLane | null;
  makeSession?: (options: SessionOptions) => Session;
  resolveHookTools?: typeof resolveSharedHookTools;
  telemetry?: Pick<Telemetry, 'capture'> | null;
  posthogApiFor?: (connection: { host: string; apiKey: string }) => Pick<PosthogApi, 'runHogQL'>;
  prepareMcp?: typeof prepareLaneMcp;
}

interface TranscriptTail {
  realPath: string | null;
  offset: number;
}

async function readNewTranscriptLines(tail: TranscriptTail, transcriptPath: string): Promise<string[]> {
  const opened = await openContainedFile(path.resolve(transcriptPath), claudeProjectsDir(process.env, os.homedir()));
  if (!opened.ok) return [];
  const { handle, realPath, stat } = opened.file;
  try {
    if (tail.realPath !== realPath) Object.assign(tail, { realPath, offset: 0 });
    const plan = planContiguousRead(tail, stat);
    if (plan.action === 'skip') return [];
    const chunk = Buffer.alloc(plan.end - plan.start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, plan.start);
    const readBytes = chunk.subarray(0, bytesRead);
    const wholeLineBytes = completeLineBytes(readBytes);
    const isOneOversizedLine = wholeLineBytes === 0 && bytesRead >= MAX_TRANSCRIPT_READ_BYTES;
    tail.offset = plan.start + (isOneOversizedLine ? bytesRead : wholeLineBytes);
    return readBytes.subarray(0, wholeLineBytes).toString('utf8').split('\n');
  } finally {
    await handle.close().catch(() => {});
  }
}

function reportPathFor(issueId: unknown): string {
  return path.join(REPORT_DIR, `${safeIssueId(issueId)}.html`);
}

function createResultFileFor(kind: string, projectId: unknown, issueId: unknown): Promise<JobResultFile> {
  return createJobResultFile(`glimmervoid-posthog-${kind}${safeIssueId(projectId)}-${safeIssueId(issueId)}`);
}

function newFixDiscriminator(): string {
  return `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

async function sweepReports(dir: string = REPORT_DIR, retain: number = REPORT_RETAIN_FILES): Promise<void> {
  try {
    const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.html') || n.endsWith('.md'));
    if (names.length <= retain) return;
    const stamped = await Promise.all(names.map(async (name) => {
      const full = path.join(dir, name);
      try { return { full, mtimeMs: (await fs.promises.stat(full)).mtimeMs }; }
      catch { return null; }
    }));
    const ordered = stamped
      .filter((entry): entry is { full: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const victim of ordered.slice(retain)) {
      await fs.promises.rm(victim.full, { force: true }).catch(() => {});
    }
  } catch {  }
}

const INVESTIGATION_VERDICTS = new Set(['ROOT_CAUSE', 'NEEDS_HUMAN', 'TRANSIENT', 'ERROR']);
const FIX_RESULT_VERDICTS = new Set(core.FIX_VERDICTS);

function readInvestigationResult(resultPath: string): ResultFileOutcome {
  return readResultFile(resultPath, INVESTIGATION_VERDICTS);
}

function readFixResult(resultPath: string): ResultFileOutcome {
  return readResultFile(resultPath, FIX_RESULT_VERDICTS, (obj) => ({
    prTitle: core.normalizePrTitle(obj.prTitle),
    prBody: core.normalizePrBody(obj.prBody),
  }));
}

function resultErrorReason(outcome: ResultFileOutcome): RadarErrorReason | undefined {
  if (outcome.verdict !== 'ERROR') return undefined;
  if (outcome.ok !== false) return 'agent-reported';
  return outcome.kind === 'missing' ? 'no-result' : 'invalid-result';
}

function posthogCfgKey(cfg: RadarWiringConfig): string {
  return stableConfigKey({ posthog: cfg.posthog || null, telegram: cfg.telegram || null });
}

function createRadarWiring({
  config, investigationSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate,
  getLaneAccessConfig = () => CLOSED_LANE_ACCESS_CONFIG,
  gitWorkspace = null,
  runCommand = runCli,
  broadcast = () => {},
  recordLane = null,
  makeSession = (options: SessionOptions) => new Session(options),
  resolveHookTools = resolveSharedHookTools,
  telemetry = null,
  posthogApiFor = createPosthogApi,
  prepareMcp = prepareLaneMcp,
}: RadarWiringOptions) {
  function activePosthogConfig(): RadarLaneConfig & { host: string; apiKey: string } {
    const posthogConfig = config.posthog;
    if (!posthogConfig?.apiKey) {
      throw new Error('PostHog lane started without its required configuration');
    }
    return { ...posthogConfig, host: core.resolvePosthogHost(posthogConfig.host), apiKey: posthogConfig.apiKey };
  }

  async function makeInvestigationSession(request: InvestigationSessionRequest): Promise<{ sess: Session; cleanup(): Promise<void> }> {
    const laneGhConfig = await makeLaneGhConfigDirectory();
    try {
      return await makeInvestigationSessionWithAccess(request, laneGhConfig);
    } catch (error) {
      await laneGhConfig.remove();
      throw error;
    }
  }

  async function makeInvestigationSessionWithAccess(
    { id, name, path: cwd, initialPrompt, posture: basePosture, onActivity = null }: InvestigationSessionRequest,
    laneGhConfig: { path: string; remove(): Promise<void> },
  ): Promise<{ sess: Session; cleanup(): Promise<void> }> {
    const { readToken, extraFetchDomains } = getLaneAccessConfig();
    const access = laneAccess({ agent: 'claude-code', readToken, extraFetchDomains, ghConfigDir: laneGhConfig.path, inheritedEnv: process.env });
    const posture = withLaneAccessTools(basePosture, access);
    const lanePermissions = buildLanePermissions({ denyTools: posture.denyTools, allowTools: posture.allowTools });
    const accessPermissions = withLaneAccessRules(lanePermissions.permissions, access);
    const sharedHookTools = hookRouter ? resolveRequiredSaneYoloHookTools(config.saneYoloUnreadablePaths ?? [], { resolve: resolveHookTools }) : [];
    if (sharedHookTools === null) throw new Error('Sane YOLO is unavailable');
    const laneMcp = posture.withPosthogMcp && hookRouter ? await prepareMcp({ laneArgs: lanePermissions.args, agent: 'claude' }) : null;
    const sess = makeSession({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: false,
      hookTools: laneMcp ? [...sharedHookTools, laneMcp.posture.hookTool] : sharedHookTools,
      extraClaudeArgs: [...radarClaudeArgs(posture, lanePermissions.args), ...(laneMcp?.posture.args ?? [])],
      initialPrompt,
      ephemeral: true,
      requiresHooks: true,
      observeToolCalls: true,
      settingsPermissions: laneMcp ? withAllowRules(accessPermissions, laneMcp.posture.allowRules) : accessPermissions,
      spawnEnv: { ...access.env },
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({
      map: investigationSessions, id, sess, closeSessionDataClients, logPrefix: 'posthog', name, recordLane,
    });
    if (onActivity) observeTrail(sess, onActivity);
    return { sess, cleanup: async () => { if (laneMcp) await laneMcp.cleanup(); await laneGhConfig.remove(); } };
  }

  async function fetchExceptionEvents(projectId: string | number, issueId: unknown): Promise<Record<string, unknown>[] | null> {
    const posthogConfig = activePosthogConfig();
    const response = await posthogApiFor({ host: posthogConfig.host, apiKey: posthogConfig.apiKey })
      .runHogQL(projectId, core.RADAR_EXCEPTION_EVENTS_QUERY, { issueId: String(issueId ?? '') })
      .catch(() => null);
    if (!response?.ok) return null;
    return extractRows(response.body);
  }

  async function writeIssuePayload(laneCwd: string, issue: PosthogIssue, projectId: string | number): Promise<boolean> {
    const exceptionEvents = await fetchExceptionEvents(projectId, issue.issueId);
    await writeUntrustedPayload(laneCwd, {
      trust: 'untrusted', source: core.RADAR_UNTRUSTED_SOURCE, fetchedAt: new Date().toISOString(),
      items: core.radarUntrustedItems(issue, exceptionEvents ?? []),
    }, core.RADAR_UNTRUSTED_ITEM_MAX_CHARS);
    return exceptionEvents !== null;
  }

  function observeTrail(sess: Session, onActivity: (trail: InvestigationTrail) => void): void {
    let trail = createInvestigationTrail(Date.now());
    const transcriptTail: TranscriptTail = { realPath: null, offset: 0 };
    let pendingReports: Promise<void> = Promise.resolve();
    onActivity(trail);
    sess.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
      const step = trailStepFromHook(event, payload);
      if (!step) return;
      const at = Date.now();
      const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
      pendingReports = pendingReports.then(async () => {
        const newTranscriptLines = transcriptPath ? await readNewTranscriptLines(transcriptTail, transcriptPath).catch(() => []) : [];
        for (const note of trailNotesFromTranscriptLines(newTranscriptLines, at)) trail = appendTrailStep(trail, { at, note });
        trail = appendTrailStep(trail, { at, ...step });
        onActivity(trail);
      });
    });
  }

  function resolveRepoPath(projectId: string | number): string | null {
    const posthogConfig = activePosthogConfig();
    const mapped = posthogConfig.projectMap?.[String(projectId)];
    for (const candidate of [mapped, posthogConfig.repoPath]) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      if (!path.isAbsolute(candidate)) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {  }
    }
    return null;
  }

  function worktreeBaseFor(repoPath: string): string {
    return config.worktreeRoot || path.join(path.dirname(path.resolve(repoPath)), '.glimmervoid-worktrees');
  }

  const waitForExit = (sess: Session, signal: AbortSignal | null | undefined) => awaitSessionExit(sess, { signal, spawnGate });

  async function radarFixSpawn(
    { issue, projectId, projectName, url, signal, onActivity = null }: {
      issue: PosthogIssue;
      projectId: string | number;
      projectName: string;
      url: string;
      signal?: AbortSignal | null;
      onActivity?: ((trail: InvestigationTrail) => void) | null;
    },
  ) {
    const posthogConfig = activePosthogConfig();
    if (!gitWorkspace) return null;
    const repoPath = resolveRepoPath(projectId);
    if (!repoPath) return null;
    const issueId = safeIssueId(issue.issueId);
    const workspace = await Promise.resolve(gitWorkspace.create({
      projectPath: repoPath,
      owner: 'lane:radar-fix',
      teamId: 'radar-fix',
      label: `${safeIssueId(projectId)}-${issueId}-${newFixDiscriminator()}`,
      worktreeBase: worktreeBaseFor(repoPath),
      baseBranch: configuredIntegrationBranch(config),
    })).catch((e: unknown) => {
      console.warn(`[posthog-poller] fix worktree create failed: ${errorMessage(e)}`);
      return null;
    });
    if (!workspace || !workspace.isGit) return null;

    const promptUrl = promptIssueUrl(posthogConfig.host, projectId, issue.issueId);
    const resultPath = path.join(workspace.cwd, core.RADAR_RESULT_FILENAME);
    const payloadPath = path.join(workspace.cwd, UNTRUSTED_PAYLOAD_FILENAME);
    let hooksScratch: JobResultFile | null = null;
    let cleanupLane: (() => Promise<void>) | null = null;
    let isBranchKept = false;
    try {
      hooksScratch = await createResultFileFor('fix-', projectId, issueId);
      const gitPointerBefore = await readWorktreeGitPointer(workspace.cwd);
      const eventsFetched = await writeIssuePayload(workspace.cwd, issue, projectId);
      const lane = await makeInvestigationSession({
        id: `posthog-fix:${projectId}#${issue.issueId}`,
        name: `PostHog fix ${projectName} #${issue.issueId}`,
        path: workspace.cwd,
        initialPrompt: buildFixPrompt({
          issueId: issue.issueId,
          projectId,
          host: posthogConfig.host,
          resultPath,
          repoPath: workspace.cwd,
          branch: workspace.branch,
          baseBranch: workspace.base,
          eventsFetched,
        }),
        posture: FIX_POSTURE,
        onActivity,
      });
      cleanupLane = lane.cleanup;
      await waitForExit(lane.sess, signal);
      const result = readFixResult(resultPath);
      await Promise.all([resultPath, payloadPath].map((controlFile) => fs.promises.rm(controlFile, { force: true })));
      const abortedResult = { verdict: 'ERROR', summary: 'fix aborted before its branch was kept', reproduced: false, prUrl: null, url, mode: core.JOB_MODES.fix, errorReason: 'aborted' as const };
      if (signal?.aborted) return abortedResult;
      if (result.verdict !== 'FIXED') {
        return { verdict: result.verdict, summary: result.summary, reproduced: false, prUrl: null, url, mode: core.JOB_MODES.fix, errorReason: resultErrorReason(result) };
      }
      const prTitle = String(result.prTitle || fallbackPrTitle(issueId));
      const prBody = String(result.prBody || fallbackPrBody({ issueUrl: promptUrl, summary: result.summary }));
      const pointerIntact = gitPointerBefore !== null && (await readWorktreeGitPointer(workspace.cwd)) === gitPointerBefore;
      const commitFailure = pointerIntact
        ? await commitFixWork({ run: runCommand, workspace, message: fallbackPrTitle(issueId), emptyHooksDir: path.dirname(hooksScratch.path) })
        : handoffFailure('commit-fix', 'the fix changed the worktree git pointers', workspace.branch);
      const handoff = commitFailure ?? await checkFixBranch({ run: runCommand, workspace });
      if (handoff.failedStep) telemetry?.capture('radar_fix_handoff_failed', { step: handoff.failedStep });
      if (signal?.aborted) return abortedResult;
      const pendingFix = handoff.verdict === 'FIXED' && workspace.branch
        ? { repoPath, branch: workspace.branch, base: workspace.base ?? null, agentPrTitle: prTitle, agentPrBody: prBody, expiresAt: Date.now() + core.PENDING_FIX_TTL_MS }
        : null;
      isBranchKept = pendingFix !== null;
      return {
        verdict: handoff.verdict,
        summary: handoff.summary || result.summary,
        reproduced: false,
        prUrl: null,
        pendingFix,
        url,
        mode: core.JOB_MODES.fix,
        errorReason: handoff.errorReason,
      };
    } catch (e) {
      const failure = (e ?? {}) as { message?: unknown };
      return {
        verdict: 'ERROR',
        summary: String(failure.message || e),
        reproduced: false,
        prUrl: null,
        url,
        mode: core.JOB_MODES.fix,
        errorReason: 'crashed' as const,
      };
    } finally {
      if (cleanupLane) await cleanupLane();
      if (hooksScratch) await hooksScratch.cleanup();
      const discarded = isBranchKept ? { ...workspace, branch: null } : workspace;
      await Promise.resolve(gitWorkspace.discard({ projectPath: repoPath, workspace: discarded, cause: 'radar' }))
        .catch((e: unknown) => console.warn(`[posthog-poller] fix worktree discard failed: ${errorMessage(e)}`));
    }
  }

  async function radarInvestigationSpawn(
    { issue, projectId, projectName, url, mode, signal, onActivity }: SpawnInvestigationArgs,
  ) {
    const posthogConfig = activePosthogConfig();
    if (core.normalizeJobMode(mode) === core.JOB_MODES.fix) {
      const fixed = await radarFixSpawn({ issue, projectId, projectName, url, signal, onActivity });
      if (fixed) return fixed;
    }
    const issueId = safeIssueId(issue.issueId);
    try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {  }
    void sweepReports();
    let resultFile: JobResultFile | null = null;
    let cleanupLane: (() => Promise<void>) | null = null;
    try {
      resultFile = await createResultFileFor('', projectId, issueId);
      const laneCwd = path.dirname(resultFile.path);
      const laneReportPath = path.join(laneCwd, core.RADAR_REPORT_FILENAME);
      const repoPath = resolveRepoPath(projectId);
      const eventsFetched = await writeIssuePayload(laneCwd, issue, projectId);
      const prompt = buildInvestigationPrompt({
        issueId: issue.issueId,
        projectId,
        host: posthogConfig.host,
        resultPath: resultFile.path,
        reportPath: laneReportPath,
        repoPath,
        eventsFetched,
      });
      const lane = await makeInvestigationSession({
        id: `posthog:${projectId}#${issue.issueId}`,
        name: `PostHog ${projectName} #${issue.issueId}`,
        path: laneCwd,
        initialPrompt: prompt,
        posture: investigationPosture(repoPath),
        onActivity,
      });
      cleanupLane = lane.cleanup;
      await waitForExit(lane.sess, signal);
      await fs.promises.copyFile(laneReportPath, reportPathFor(issue.issueId)).catch(() => {});
      const result = readInvestigationResult(resultFile.path);
      return { ...result, url, mode: core.JOB_MODES.investigate, errorReason: resultErrorReason(result) };
    } catch (e) {
      const failure = (e ?? {}) as { message?: unknown };
      return { verdict: 'ERROR', summary: String(failure.message || e), mode: core.JOB_MODES.investigate, errorReason: 'crashed' as const };
    } finally {
      if (cleanupLane) await cleanupLane();
      if (resultFile) await resultFile.cleanup();
    }
  }

  const posthogStatePath = path.join(glimmervoidHomeDir(), 'posthog-state.json');
  async function readPosthogState(): Promise<PosthogState> {
    const outcome = await loadJsonStateFile({
      filePath: posthogStatePath, parse: (raw: unknown) => (isRecord(raw) ? raw as PosthogState : null), quarantine: false,
    });
    return loadedJsonValue(outcome) ?? {};
  }
  async function writePosthogState(state: PosthogState): Promise<void> {
    await writeJsonAtomic(posthogStatePath, state, { mkdir: true });
  }

  const forcedTick = createCoalescedTimer({
    mode: 'trailing',
    delayMs: FORCE_TICK_DEBOUNCE_MS,
    run: () => {
      if (runner.isStopped()) return;
      const poller = runner.getPoller();
      if (!poller || !('tick' in poller) || typeof poller.tick !== 'function') return;
      void poller.tick();
    },
  });
  function clearForcedTickTimer(): void {
    forcedTick.cancel();
  }
  function queueForcedTick(): void {
    forcedTick.schedule();
  }

  const projectFeed = createWatcheeFeed<RadarProjectPayload>();
  const latestPayloadByProjectId = new Map<string, RadarProjectPayload>();

  async function acceptProject(job: { payload: RadarProjectPayload }): Promise<void> {
    projectFeed.accept(job.payload);
    const projectKey = `${job.payload.host} ${job.payload.projectId}`;
    if (isOlderObservation(job.payload, latestPayloadByProjectId.get(projectKey) ?? null)) return;
    latestPayloadByProjectId.set(projectKey, job.payload);
  }

  const runner = createLaneRunner({
    tag: 'posthog-poller',
    gate: () => {
      const verdict = core.radarShouldStart(config);
      if (verdict.reason) return verdict;
      return { start: verdict.start };
    },
    cfgKey: () => posthogCfgKey(config),
    emptyStatus: () => ({
      ...emptyLaneStatus('radar-status', core.radarShouldStart(config)),
      intervalMinutes: config.posthog?.intervalMinutes || core.DEFAULT_INTERVAL_MINUTES,
      investigations: [],
    }),
    broadcast,
    beforeStop: clearForcedTickTimer,
    createPoller: ({ onTickComplete }) => {
      const posthogConfig = activePosthogConfig();
      const telegramConfig = config.telegram;
      if (!telegramConfig?.botToken || !telegramConfig.chatId) {
        throw new Error('PostHog poller started without its required Telegram configuration');
      }
      const botToken = telegramConfig.botToken;
      const chatId = telegramConfig.chatId;
      return createRadarPoller({
        firstTickDelayMs: bootStaggerDelay,
        host: posthogConfig.host,
        latestProjects: () => [...latestPayloadByProjectId.values()],
        feedSilenceMs: projectFeed.silenceMs,
        spawnInvestigation: radarInvestigationSpawn,
        releasePendingFix: deletePendingFixBranch,
        telemetry,
        telegram: (text: string) => { void sendTelegramMessage({ botToken, chatId, text, tag: 'posthog' }); },
        readState: readPosthogState,
        writeState: writePosthogState,
        intervalMinutes: posthogConfig.intervalMinutes || core.DEFAULT_INTERVAL_MINUTES,
        maxConcurrentInvestigations: posthogConfig.maxConcurrentInvestigations || 2,
        investigationTimeoutSeconds: posthogConfig.investigationTimeoutSeconds || 900,
        autoFix: posthogConfig.autoFix === true,
        fixTimeoutSeconds: posthogConfig.fixTimeoutSeconds || 1800,
        minUsersToInvestigate: posthogConfig.minUsersToInvestigate,
        userEscalationThreshold: posthogConfig.userEscalationThreshold,
        recurrenceDedupe: posthogConfig.recurrenceDedupe,
        recurrenceWindowDays: posthogConfig.recurrenceWindowDays,
        transientRecurrenceLimit: posthogConfig.transientRecurrenceLimit,
        trafficSpikeEnabled: posthogConfig.trafficSpikeEnabled,
        trafficSpikeMultiplier: posthogConfig.trafficSpikeMultiplier,
        trafficSpikeMinUsers: posthogConfig.trafficSpikeMinUsers,
        trafficSpikeCooldownMinutes: posthogConfig.trafficSpikeCooldownMinutes,
        onTickComplete,
        onInvestigationActivity: (activity) => broadcast({ ...activity }),
      });
    },
  });

  async function setIssueStatus(
    { projectId, issueId, action }: { projectId: string; issueId: string; action: unknown },
  ) {
    const decision = core.decideIssueAction(action);
    if (!decision.ok) return decision;
    if (!runner.getPoller()) return { ok: false, error: 'PostHog monitoring is not running' };
    const posthogConfig = activePosthogConfig();
    const api = createPosthogApi({ host: posthogConfig.host, apiKey: posthogConfig.apiKey });
    const res = await api.updateIssueStatus(projectId, issueId, decision.status);
    if (!res.ok) return { ok: false, error: `PostHog refused the change (${res.error || 'unknown error'})` };
    queueForcedTick();
    return { ok: true, status: decision.status };
  }

  async function deletePendingFixBranch(fix: PendingFix): Promise<void> {
    if (!gitWorkspace) return;
    await gitWorkspace.discard({ projectPath: fix.repoPath, workspace: { isGit: true, cwd: '', branch: fix.branch }, cause: 'radar' });
  }

  function pendingFixFor(id: string): { record: InvestigationRecord; fix: PendingFix } | null {
    return runner.getPoller()?.pendingFixFor(id) ?? null;
  }

  async function settlePendingFix(id: string, options: { releaseBranch: boolean }) {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: 'PostHog monitoring is not running' };
    const res = await poller.settlePendingFix(id, options);
    if (!res.ok) return { ok: false, error: res.error };
    runner.patchStatus({ investigations: res.investigations });
    return { ok: true };
  }

  async function archiveInvestigation({ id }: { id?: string } = {}) {
    const poller = runner.getPoller();
    if (!poller || !('archiveInvestigation' in poller) || typeof poller.archiveInvestigation !== 'function') {
      return { ok: false, error: 'PostHog monitoring is not running' };
    }
    const res = await poller.archiveInvestigation(id);
    if (!res.ok) return { ok: false, error: res.error };
    runner.patchStatus({ investigations: res.investigations });
    return { ok: true };
  }

  return {
    startPoller: runner.startPoller,
    acceptProject,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    stopPoller: async () => {
      projectFeed.stop();
      await runner.stopPoller();
    },
    getStatus: runner.getStatus,
    setIssueStatus,
    archiveInvestigation,
    pendingFixFor,
    settlePendingFix,
    _makeInvestigationSession: makeInvestigationSession,
    _investigationSpawn: radarInvestigationSpawn,
  };
}

export { checkFixBranch, commitFixWork, createRadarWiring, readWorktreeGitPointer };
export type { PosthogWorkspace };
