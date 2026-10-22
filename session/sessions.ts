import type { GitIsolationOptions } from '../server/git/core/git-invocation-core.ts';
import { awaitBounded } from "../server/core/shutdown-core.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { randomUUID } from "node:crypto";
import { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent, isIdleCompactionActivity } from "./core/compaction-core.ts";
import { isCompactionRestoreEvent } from "../shared/compaction-restore-events.ts";
import type { CompactionTracking } from "./core/compaction-core.ts";
import { HOOK_TOOLS } from './core/hook-tools.ts';
import type { ResolvedHookTool } from './core/hook-tools.ts';
import fs from "node:fs";
import { buildPersistedTaskTitle, cleanTaskPrompt, extractOscTaskTitle, extractPromptTaskTitle, isSelfWakePrompt, isSubstantivePrompt, resolveRefocusTaskTitle, resolveTaskTitle, seedTaskTitleSources } from "./core/task-title-core.ts";
import type { PersistedTaskTitle } from "../shared/contracts/config.ts";
import type { LinkedPr, SessionPrLinks } from "../shared/contracts/my-prs.ts";
import { mergeSessionPrLink, seedSessionPrLinks, withManualPrLink, withoutPrLink } from "./core/session-pr-links-core.ts";
import type { TaskTitleRefinementResult, TaskTitleSources } from "./core/task-title-core.ts";
import { readTranscriptTaskTitle } from "./session-task-title.ts";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { execFile } from "../server/child-process-safe.ts";
import { projectDirCandidates } from "../server/usage/core/usage-scan-core.ts";
import { requireExecutableSpawnHelper } from "../server/node-pty-preflight.ts";
import { STATES, KILLABLE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { unrefTimer } from "../shared/timer-deps.ts";
import { AGENT_ATTENTION_NOTE_SEPARATOR, AGENT_URL_ENV } from "../shared/contracts/session.ts";
import { commitSigningEnv } from "./core/commit-signing-env.ts";
import { permitsHelpCommand } from "./core/session-routes.ts";
import { ASK_USER_QUESTION_TOOL_NAME, type AgentAttentionReply } from "../shared/contracts/session.ts";
import { buildHookSettings, generateToken } from "../detection/settings-injector.ts";
import { createOscTitleSource } from "../detection/osc-title-source.ts";
import { createStatusSource } from "../detection/status-source.ts";
import type { MetaStatusSignal, ResolvedStatusSignal } from "../detection/status-source.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import type { SpawnEnv } from "./core/spawn-env.ts";
import { DEFAULT_AGENT_ID, resolveAdapter, commandFor } from "./adapters/index.ts";
import { startCodexAppServerBridge, startCoderPortForward } from "./codex-app-server-bridge.ts";
import { remoteCodexAppServerScript } from "./core/codex-app-server-core.ts";
import type { CodexAppServerBridge } from "./codex-app-server-bridge.ts";
import { CODEX_REMOTE_TOKEN_ENV, needsAppServerRefusedFlag, remoteTuiArgs, splitCodexRemoteLaunch } from "./core/codex-remote-launch-core.ts";
import type { CoherenceAttachment, ConfineCommand, ConfinedCommand } from '../server/coherence/coherence-runtime.ts';
import type { CoherenceHooksState, ConversationAnswers, ConversationApproval, ConversationApprovalDecision, UnseenOutcome } from "../shared/contracts/session.ts";
import { claudeApprovalFor, claudeDecisionReply, isHoldReleasedByHookEvent, parseClaudePermissionRequest } from "./core/claude-approval-core.ts";
import type { ClaudeHookReply, ClaudePermissionRequest } from "./core/claude-approval-core.ts";
import type { AgentAdapter, AgentCapabilities } from "./adapters/index.ts";

import {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
  UNSEEN_OUTCOME_ON_ENTRY,
} from "./core/state-machine.ts";
import { acceptsAttentionSignal, mapSignalToEvent, shouldDeferAttention } from "./core/status-mapper.ts";
import { decideWaitingInput, isOperatorKeystroke } from "./core/waiting-input-core.ts";
import { decideExitTransition } from "./core/exit-transition.ts";
import type { ExitSignal } from "./core/exit-transition.ts";
import * as agentTracker from "./core/agent-tracker.ts";
import { DEFAULT_GATE_RELEASE_SETTLE_MS } from "./core/gate-release.ts";
import { resolveResumeTarget, shouldAdoptReportedResumeId, AUTO_CONTINUE_PROMPT, RESUME_ID_RE } from "./core/auto-resume.ts";
import { CLAUDE_TOKEN_ALIAS_ENV, CLAUDE_TOKEN_ALIASES, CODER_SSH_ENV, coderSshArgs, coderSshExecArgs, encodeCoderSshEnv, remoteLaunchScript } from "./core/remote-launch-core.ts";
import { safePathSegment } from "../shared/paths.ts";
import { projectSessionSnapshots } from "./core/snapshot-projection.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { createSessionObservability } from "./session-observability.ts";
import { createSessionOutput } from "./session-output.ts";
import type { ScreenSnapshot } from "./session-output.ts";
import type { ScreenKeeperFactory } from "./screen-keeper.ts";
import { createSessionHookLifecycle } from "./session-hook-lifecycle.ts";
import type { HookRouterPort } from "./session-hook-lifecycle.ts";
import type { GuardrailsLaunch, GuardrailsLaunchResult } from "../server/guardrails/guardrails-launch.ts";
import { createSessionWorktreeLifecycle } from "./session-worktree-lifecycle.ts";
import { signalWindowChangeBelow } from "./window-change-signal.ts";
import type { GitWorkspace } from "./session-worktree-lifecycle.ts";
import { createSessionBackgroundTracking } from "./session-background-tracking.ts";
import type { HookPayload } from "../shared/contracts/index.ts";

const KILL_POLL_INTERVAL_MS = 200;
const KILL_MAX_WAIT_MS = 3000;

const KILL_REAP_MAX_WAIT_MS = 2400;
const MAX_PENDING_ATTENTION_NOTES = 5;
const GUARDRAILS_UNAPPLIED_ERROR = "guardrail settings could not be applied, session not started";
const GUARDRAILS_REFUSED_PREFIX = "session not started, the guardrails refused: ";
const SPAWN_FAILURE_TEXT_BY_REASON: Record<string, string> = {
  spawn_cwd_missing: "The session folder no longer exists. Re-add the session on a folder that exists.",
};
const SPAWN_FAILURE_FALLBACK_TEXT = "The agent could not be started. The server log has the cause.";

function describeSpawnFailure(detail: unknown): string {
  if (typeof detail !== "object" || detail === null) return SPAWN_FAILURE_FALLBACK_TEXT;
  if ("error" in detail && typeof detail.error === "string" && detail.error) return detail.error;
  const reason = "reason" in detail && typeof detail.reason === "string" ? detail.reason : "";
  return SPAWN_FAILURE_TEXT_BY_REASON[reason] ?? SPAWN_FAILURE_FALLBACK_TEXT;
}
const INNER_GUARDRAILS_OFF = Object.freeze({ enabled: false });

function settingsGuardrailsForHooks(
  adapter: AgentAdapter,
  hasOuterGuardrails: boolean,
  requestedSettingsGuardrails: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!hasOuterGuardrails) return requestedSettingsGuardrails;
  if (typeof adapter.settingsArgs !== "function") return null;
  return INNER_GUARDRAILS_OFF;
}

function signalablePid(pid: unknown): number | null {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 2) return null;
  return parsed;
}

function nextPendingPromptToolName(
  currentKind: string | null,
  currentToolName: string | null,
  nextKind: string | null,
  incomingToolName: string | null,
  mayInheritCurrentToolName: boolean,
): string | null {
  if (nextKind !== "permission") return null;
  if (incomingToolName) return incomingToolName;
  if (mayInheritCurrentToolName && currentKind === "permission") return currentToolName;
  return null;
}

const DISMISSIBLE_STATES: Set<SessionState> = new Set([STATES.WAITING, STATES.COMPLETE]);


interface ClaudeApprovalHold {
  request: ClaudePermissionRequest;
  approval: ConversationApproval;
  resolve: (reply: ClaudeHookReply | null) => void;
}

interface SessionPlanReviewPort {
  hasPlan: (sessionId: string) => boolean;
}

type TimerField = "_killPollTimer" | "_killReapTimer" | "_titleQuietFallbackTimer";

interface SessionRecorderPort {
  writeHeader(config: { agent?: string | null; cols?: number; rows?: number } & Record<string, unknown>): void;
  writeData(data: string): void;
  writeHook(event: string, payload: HookPayload | null | undefined): void;
  writeState(from: SessionState, to: SessionState, event: string, detail: unknown): void;
  writeDecision(entry: DecisionEntry): void;
  writeInput(data: string): void;
  writeResize(cols: number, rows: number): void;
  writeFooter(reason: string, exitCode: number | null | undefined): void;
  finishRecordingFile(): void;
  close(): void;
}

interface SessionPty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  _agent?: { inSocket?: { on: (event: string, listener: (error: Error) => void) => unknown } };
  on?: (event: string, listener: (error: Error) => void) => unknown;
}

type PtySpawn = (
  file: string,
  args: string[],
  options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
) => SessionPty;

type KillProc = (
  args: string[],
  options: Record<string, unknown>,
  callback: (error: unknown, stdout?: string, stderr?: string) => void,
) => unknown;

type SignalProc = (pid: number, signal: NodeJS.Signals | 0) => void;

interface SessionGuardrailsFacts {
  launchId: string;
  cwd: string;
  hookPort: number | null;
  readablePaths: string[];
  writablePaths: string[];
  agentSessionId: string | null;
}

type PrepareSessionGuardrails = (facts: SessionGuardrailsFacts) => Promise<GuardrailsLaunchResult>;

type RemoteLaunchStep = { ok: true } | { ok: false; reason: string };

interface RemoteLaunch {
  workspace: string;
  remotePort: number;
  checkoutDirectory: string;
  nodePath: string;
  ensureRunning: () => Promise<RemoteLaunchStep>;
  describeExit: () => Promise<string | null>;
  uploadFile: (file: { remotePath: string; contents: string; mode: number }) => Promise<void>;
  claudeToken: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
  codexVersion: () => Promise<string | null>;
  codexLoginParams: () => Promise<unknown>;
  codexRefreshResult: () => Promise<unknown>;
}

const REMOTE_CODEX_STARTUP_TIMEOUT_MS = 300_000;

interface SpawnCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

interface SessionOptions {
  customTitle?: string;
  taskTitleState?: PersistedTaskTitle;
  prLinks?: SessionPrLinks;
  id: string;
  name: string;
  path: string;
  dangerouslySkipPermissions?: boolean;
  replayBufferKB?: number;
  hookRouter?: HookRouterPort | null;
  getHookPort?: (() => number | null) | null;
  hooksBaseDir?: string;
  titleStabilizationMs?: number;
  statusConflictMs?: number;
  statusDedupMs?: number;
  detectBackgroundAgents?: boolean;
  agentTtlMs?: number;
  shellTaskTtlMs?: number;
  teammateTaskTtlMs?: number;
  gateReleaseSettleMs?: number;
  detectScheduledWakeups?: boolean;
  observeToolCalls?: boolean;
  agent?: string;
  adapter?: AgentAdapter | null;
  bypassHookTrust?: boolean;
  isMarkedUnguarded?: boolean;
  isGuardrailsReleased?: boolean;
  isConversationViewEnabled?: (() => boolean) | null;
  isConversationViewSettingOn?: (() => boolean) | null;
  startCodexBridge?: typeof startCodexAppServerBridge;
  titleQuietFallbackMs?: number;
  spawnCommand?: ResolvedCommand | null;
  initialPrompt?: string | null;
  extraClaudeArgs?: string[];
  ephemeral?: boolean;
  resumeSessionId?: string | null;
  settingsPermissions?: Record<string, unknown> | null;
  settingsGuardrails?: Record<string, unknown> | null;
  prepareGuardrails?: PrepareSessionGuardrails | null;
  getRemoteLaunch?: (() => RemoteLaunch | null) | null;
  spawnEnv?: Record<string, string> | null;
  prependPathDirs?: string[];
  enableProjectMcp?: boolean;
  hookTools?: ResolvedHookTool[];
  getHookTools?: (() => ResolvedHookTool[]) | null;
  planReviewPort?: SessionPlanReviewPort | null;
  planLimits?: boolean;
  getUserHooks?: (() => UserHook[]) | null;
  extraUserHooks?: UserHook[];
  prepareCoherence?: ((cwd: string, confine: ConfineCommand | null) => Promise<CoherenceAttachment | null>) | null;
  ptySpawn?: PtySpawn | null;
  screenKeeperFactory?: ScreenKeeperFactory | null;
  killProc?: KillProc | null;
  signalProc?: SignalProc | null;
  platform?: NodeJS.Platform;
  gitWorkspace?: GitWorkspace | null;
  requireWorktree?: boolean;
  integrationBranch?: string | null;
  autoRebase?: boolean;
  syncOnStart?: boolean;
  liveWorktreeReview?: boolean;
  worktreeRoot?: string | null;
  worktreeShare?: string[] | null;
  workspaceRepos?: string[];
  agentDepth?: number;
  ownerId?: string | null;
  commitSigningProgram?: string | null;
}

interface ClaudeSessionIdEvent {
  id: string;
  source: string | null;
  vendor: string;
  sessionId: string;
  transcriptPath: string | null;
  isResumeTarget: boolean;
}

class Session extends EventEmitter {
  customTitle: string | null;
  taskTitle: string | null;
  taskTitleIsCustom: boolean;
  _taskTitleSources: TaskTitleSources;
  _taskTitleStateSignature: string | undefined;
  _taskTitleReadSequence: number;
  _recentTaskPrompts: string[];
  taskTitlePromptRevision: number;
  _prLinks: SessionPrLinks;
  id: string;
  name: string;
  path: string;
  dangerouslySkipPermissions: boolean;
  ptyProcess: SessionPty | null;
  state: SessionState;
  stateSince: number;
  failureReason: string | null;
  unseenOutcome: UnseenOutcome | null;
  ephemeral: boolean;
  agentId: string;
  usageVendor: string;
  bypassHookTrust: boolean;
  isMarkedUnguarded: boolean;
  isGuardrailsReleased: boolean;
  _isConversationViewEnabled: () => boolean;
  _startCodexBridge: typeof startCodexAppServerBridge;
  _codexBridge: CodexAppServerBridge | null;
  _conversationApproval: ConversationApproval | null;
  _claudeApprovalHolds: ClaudeApprovalHold[];
  _nextClaudeApprovalNumber: number;
  backgroundTracking: ReturnType<typeof createSessionBackgroundTracking>;
  worktreeLifecycle: ReturnType<typeof createSessionWorktreeLifecycle>;

  _receivedFirstOutput: boolean;
  _killPollTimer: NodeJS.Timeout | null;
  _killReapTimer: NodeJS.Timeout | null;
  _titleQuietFallbackTimer: NodeJS.Timeout | null;
  _resolveKillReap: (() => void) | null;
  _killReap: Promise<void> | null;
  _exitReap: Promise<void> | null;
  _destroyed: boolean;
  _pendingRestart: boolean;
  _finishing: boolean;
  _ptyAlive: boolean;
  _recorder: SessionRecorderPort | null;
  _output: ReturnType<typeof createSessionOutput>;
  _adapter: AgentAdapter;
  _observability: ReturnType<typeof createSessionObservability>;
  _titleQuietFallbackMs: number;
  _hookSeen: boolean;
  _lastSignal: Record<string, unknown> | null;
  _compaction: CompactionTracking;
  _pendingPromptKind: string | null;
  _isWaitingForMemory: boolean;
  _pendingPromptToolName: string | null;
  _pendingAttentionNotes: string[];
  _titleQuiet: boolean;
  _spawnCommand: ResolvedCommand | null;
  _initialPrompt: string | null;
  _extraClaudeArgs: string[];
  _resumeSessionId: string | null;
  readonly workspaceRepos: string[] | null;
  _transcriptPath: string | null;
  _lastClaudeSessionReport: { id: string; transcriptPath: string | null; isResumeTarget: boolean } | null;
  _suppressResumeCapture: boolean;
  _spawnEnv: Record<string, string> | null;
  _prependPathDirs: string[];
  _hookTools: ResolvedHookTool[];
  _getHookTools: (() => ResolvedHookTool[]) | null;
  _isSaneYoloActive: boolean;
  _planLimits: boolean;
  _planReviewPort: SessionPlanReviewPort | null;
  _prepareCoherence: ((cwd: string, confine: ConfineCommand | null) => Promise<CoherenceAttachment | null>) | null;
  coherenceHooks: CoherenceHooksState | null;
  coherenceAttachment: CoherenceAttachment | null;
  _coherenceHooksRefresh: Promise<void> | null;
  _coherenceHooksGeneration: number;
  _hooks: ReturnType<typeof createSessionHookLifecycle>;
  _agentDepth: number;
  readonly ownerId: string | null;
  _agentToken: string | null;
  _commitSigningProgram: string | null;
  _commitSigningToken: string | null;
  _canRunHelpCommand: boolean;
  _agentLiveChildren: number;
  _agentLifetimeSpawns: number;
  _agentSpawnsInFlight: number;
  _ptySpawn: PtySpawn;
  _prepareGuardrails: PrepareSessionGuardrails | null;
  _getRemoteLaunch: () => RemoteLaunch | null;
  _hasRespawnedForAuth: boolean;
  _guardrailsLaunch: GuardrailsLaunch | null;
  _requiresWorktree: boolean;
  _killProc: KillProc;
  _signalProc: SignalProc;
  _platform: NodeJS.Platform;
  _startPending: Promise<void> | null;
  _resizeSeq: number;
  _titleSource: ReturnType<typeof createOscTitleSource>;
  _statusSource: ReturnType<typeof createStatusSource>;

  constructor({
    customTitle,
    id,
    name,
    path: projectPath,
    dangerouslySkipPermissions = false,
    replayBufferKB = 512,

    hookRouter = null,
    getHookPort = null,
    hooksBaseDir = undefined,
    titleStabilizationMs = 1500,
    statusConflictMs = undefined,
    statusDedupMs = undefined,

    detectBackgroundAgents = true,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,

    shellTaskTtlMs = agentTracker.DEFAULT_SHELL_TASK_TTL_MS,

    teammateTaskTtlMs = agentTracker.DEFAULT_TEAMMATE_TASK_TTL_MS,

    gateReleaseSettleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,

    detectScheduledWakeups = true,

    observeToolCalls = false,

    agent = DEFAULT_AGENT_ID,

    adapter = null,

    bypassHookTrust = false,
    isMarkedUnguarded = false,
    isGuardrailsReleased = false,
    isConversationViewEnabled = null,
    isConversationViewSettingOn = null,
    startCodexBridge = startCodexAppServerBridge,

    titleQuietFallbackMs = 30000,

    spawnCommand = null,

    initialPrompt = null,
    extraClaudeArgs = [],
    ephemeral = false,

    resumeSessionId = null,
    taskTitleState = undefined,
    prLinks = undefined,

    settingsPermissions = null,
    settingsGuardrails = null,
    prepareGuardrails = null,
    getRemoteLaunch = null,

    spawnEnv = null,
    prependPathDirs = [],

    enableProjectMcp = false,
    hookTools = [],
    getHookTools = null,

    planReviewPort = null,

    planLimits = false,

    getUserHooks = null,
    extraUserHooks = [],
    prepareCoherence = null,

    ptySpawn = null,
    requireWorktree = false,

    screenKeeperFactory = null,

    killProc = null,

    signalProc = null,

    platform = process.platform,

    gitWorkspace = null,
    integrationBranch = null,

    autoRebase = true,
    syncOnStart = true,

    liveWorktreeReview = true,

    worktreeRoot = null,
    worktreeShare = null,
    workspaceRepos = undefined,

    agentDepth = 0,
    ownerId = null,
    commitSigningProgram = null,
  }: SessionOptions) {
    super();
    this.id = id;
    this.ownerId = ownerId;
    this.name = name;
    this.customTitle = customTitle || null;
    this._taskTitleSources = seedTaskTitleSources({ persistedTitle: taskTitleState, resumeSessionId, customTitle: this.customTitle, initialPrompt });
    this._taskTitleStateSignature = JSON.stringify(buildPersistedTaskTitle(this._taskTitleSources));
    const effectiveTitle = resolveTaskTitle(this._taskTitleSources);
    this.taskTitle = effectiveTitle.taskTitle;
    this.taskTitleIsCustom = effectiveTitle.isCustom;
    this._taskTitleReadSequence = 0;
    this._recentTaskPrompts = [];
    this.taskTitlePromptRevision = 0;
    this._prLinks = seedSessionPrLinks(prLinks);
    this.path = projectPath;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.ptyProcess = null;
    this.state = STATES.DORMANT;
    this.stateSince = Date.now();
    this.failureReason = null;
    this.unseenOutcome = null;
    this._receivedFirstOutput = false;
    this._killPollTimer = null;
    this._killReapTimer = null;

    this._resolveKillReap = null;

    this._killReap = null;

    this._exitReap = null;
    this._destroyed = false;
    this._pendingRestart = false;

    this._finishing = false;

    this._ptyAlive = false;
    this._recorder = null;
    this._output = createSessionOutput({
      maxBytes: replayBufferKB * 1024,
      getState: () => this.state,
      isDestroyed: () => this._destroyed,
      hasLivePty: () => this.hasLivePty,
      write: (text) => this.write(text),
      start: () => { this.start(); },
      restart: () => { this.restart(); },
      on: (event, listener) => { this.on(event, listener); },
      once: (event, listener) => { this.once(event, listener); },
      off: (event, listener) => { this.off(event, listener); },
      screenKeeperFactory,
    });

    const resolvedAdapter = adapter || resolveAdapter(agent, { label: `session:${name}` });
    if (!resolvedAdapter) throw new TypeError("default agent adapter is unavailable");
    this._adapter = resolvedAdapter;
    this.agentId = this._adapter.id;
    this._observability = createSessionObservability({
      agentId: this.agentId,
      getRecorder: () => this._recorder,
    });

    this.usageVendor = this._adapter.usageVendor || "claude";
    this.bypassHookTrust = bypassHookTrust === true;
    this.isMarkedUnguarded = isMarkedUnguarded === true;
    this.isGuardrailsReleased = isGuardrailsReleased === true;
    const isConversationViewConfigured = isConversationViewEnabled ?? (() => false);
    this._isConversationViewEnabled = () => isConversationViewConfigured() && !this.isConversationBridgeRefused();
    this._startCodexBridge = startCodexBridge;
    this._codexBridge = null;
    this._conversationApproval = null;
    this._claudeApprovalHolds = [];
    this._nextClaudeApprovalNumber = 1;
    this._titleQuietFallbackMs = titleQuietFallbackMs;
    this._titleQuietFallbackTimer = null;

    this._hookSeen = false;
    this._lastSignal = null;

    this._compaction = createCompactionTracking();
    this._pendingPromptKind = null;
    this._isWaitingForMemory = false;
    this._pendingPromptToolName = null;
    this._pendingAttentionNotes = [];

    this._titleQuiet = false;
    this.backgroundTracking = createSessionBackgroundTracking({
      detectBackgroundAgents: detectBackgroundAgents && this._can("backgroundAgents"),
      agentTtlMs,
      shellTaskTtlMs,
      teammateTaskTtlMs,
      gateReleaseSettleMs,
      detectScheduledWakeups,
      port: {
        state: () => this.state,
        isDestroyed: () => this._destroyed,
        emit: (event, detail) => this.emit(event, detail),
        recordDecision: (entry) => this._recordDecision(entry),
        transition: (event, detail) => this.transition(event, detail),
        resyncWorkingLatch: () => this._titleSource.resyncWorkingLatch(),
      },
    });
    this._spawnCommand = spawnCommand;
    this._requiresWorktree = requireWorktree;
    this._initialPrompt = initialPrompt;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._resumeSessionId = resumeSessionId || null;
    this.workspaceRepos = workspaceRepos ? [...workspaceRepos] : null;
    this._transcriptPath = null;
    this._lastClaudeSessionReport = null;
    this._suppressResumeCapture = false;
    this.ephemeral = !!ephemeral;
    this._spawnEnv = spawnEnv;
    this._prependPathDirs = prependPathDirs;
    this._hookTools = hookTools.filter((tool) => this._can(HOOK_TOOLS[tool.id].capability));
    this._getHookTools = getHookTools;
    this._isSaneYoloActive = false;
    this._planLimits = planLimits === true && this._can("statusLine");
    this._planReviewPort = planReviewPort;
    this._prepareCoherence = prepareCoherence;
    this.coherenceHooks = null;
    this.coherenceAttachment = null;
    this._coherenceHooksRefresh = null;
    this._coherenceHooksGeneration = 0;
    this._hooks = createSessionHookLifecycle({
      id: this.id,
      name: this.name,
      agentId: this.agentId,
      adapter: this._adapter,
      hookRouter,
      getHookPort,
      hooksBaseDir,
      settingsPermissions,
      settingsGuardrails: settingsGuardrailsForHooks(this._adapter, prepareGuardrails !== null, settingsGuardrails),
      detectScheduledWakeups,
      observeToolCalls: observeToolCalls === true,
      enableProjectMcp: !!enableProjectMcp,
      hookTools: this._hookTools,
      planLimits: this._planLimits,
      planReview: planReviewPort !== null,
      conversationApprovals: () => this.agentId === "claude-code" && (isConversationViewSettingOn ?? isConversationViewConfigured)(),
      getUserHooks,
      extraUserHooks,
      bypassHookTrust: this.bypassHookTrust,
      effectiveCwd: () => this.effectiveCwd(),
      agentEnv: () => this._buildSpawnEnv(),
      ingestSignal: (raw) => this.ingestHookSignal(raw),
      observeHook: (event, payload) => {
        this._releaseClaudeHoldsAfterHookEvent(event, payload);
        this.emit("hook-event", { event, payload });
      },
      recordDecision: (entry) => this._recordDecision(entry),
    });
    this._agentDepth = agentDepth;
    this._agentToken = generateToken();
    this._commitSigningProgram = commitSigningProgram;
    this._commitSigningToken = commitSigningProgram === null ? null : generateToken();
    this._canRunHelpCommand = permitsHelpCommand(settingsPermissions);
    this._agentLiveChildren = 0;
    this._agentLifetimeSpawns = 0;
    this._agentSpawnsInFlight = 0;
    this._ptySpawn = ptySpawn || ((file, args, opts) => {
      requireExecutableSpawnHelper();
      return pty.spawn(file, args, opts);
    });
    this._prepareGuardrails = prepareGuardrails;
    this._getRemoteLaunch = getRemoteLaunch ?? (() => null);
    this._hasRespawnedForAuth = false;
    this._guardrailsLaunch = null;

    this._killProc = killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb));
    this._signalProc = signalProc || ((pid, signal) => process.kill(pid, signal));
    this._platform = platform;

    this._startPending = null;
    this._resizeSeq = 0;
    this.worktreeLifecycle = createSessionWorktreeLifecycle({
      id: this.id,
      projectPath: this.path,
      integrationBranch,
      gitWorkspace,
      autoRebase,
      syncOnStart,
      liveWorktreeReview,
      worktreeRoot,
      worktreeShare,
      workspaceRepos,
      sessionName: name,
      port: {
        projectPath: () => this.path,
        state: () => ({
          state: this.state,
          isDestroyed: this._destroyed,
          isTeardownPending: this._teardownPending(),
          hasLivePty: this.hasLivePty,
        }),
        emit: (event, detail) => this.emit(event, detail),
        recordDecision: (entry) => this._recordDecision(entry),
        pasteText: (text) => this.pasteText(text),
      },
    });

    this._titleSource = createOscTitleSource({
      stabilizationMs: titleStabilizationMs,
      titleProfile: this._adapter.titleProfile,
    });
    this._statusSource = createStatusSource({
      sessionId: id,
      ...(statusConflictMs != null ? { conflictWindowMs: statusConflictMs } : {}),
      ...(statusDedupMs != null ? { dedupWindowMs: statusDedupMs } : {}),
    });
    this._titleSource.on("title", (title: string) => {
      const taskTitleVocabulary = this._adapter.titleProfile.taskTitle;
      if (taskTitleVocabulary.readsTranscriptTitle) return;
      const oscTitle = extractOscTaskTitle(title, path.basename(this.effectiveCwd()), taskTitleVocabulary);
      if (!oscTitle) return;
      this._taskTitleSources.oscTitle = oscTitle;
      this._updateTaskTitle();
    });
    this._titleSource.on("signal", (s) => {
      if (this._titleQuiet) return;
      this._statusSource.ingest(s);
    });
    this._statusSource.on("status", (s: ResolvedStatusSignal) => this._onStatus(s));
    this._statusSource.on("meta", (m: MetaStatusSignal) => this._onMeta(m));
  }

  setCustomTitle(title: string | null): void {
    this.customTitle = title?.trim() || null;
    this._taskTitleSources.customTitle = this.customTitle;
    this._updateTaskTitle();
  }

  get refinedTaskTitle(): string | null {
    return this._taskTitleSources.refinedTitle ?? null;
  }

  get transcriptPath(): string | null {
    return this._transcriptPath;
  }

  get persistedTaskTitle(): PersistedTaskTitle | undefined {
    return buildPersistedTaskTitle(this._taskTitleSources);
  }

  get refocusTaskTitle(): string | null {
    return resolveRefocusTaskTitle(this._taskTitleSources);
  }

  get linkedPrs(): LinkedPr[] {
    return this._prLinks.links;
  }

  linkPr(link: LinkedPr): void {
    this._replacePrLinks(mergeSessionPrLink(this._prLinks, link));
  }

  linkPrManually(link: LinkedPr): void {
    this._replacePrLinks(withManualPrLink(this._prLinks, link));
  }

  unlinkPr(pullRequestKey: string): void {
    this._replacePrLinks(withoutPrLink(this._prLinks, pullRequestKey));
  }

  _replacePrLinks(next: SessionPrLinks): void {
    if (next === this._prLinks) return;
    this._prLinks = next;
    this.emit("pr-links-change", next);
  }

  get recentTaskPrompts(): readonly string[] {
    return [...this._recentTaskPrompts];
  }

  applyTaskTitleRefinement(refinement: TaskTitleRefinementResult): void {
    if (refinement.action === "replace") this._taskTitleSources.refinedTitle = refinement.title;
    this._updateTaskTitle();
  }

  _updateTaskTitle(): void {
    const effectiveTitle = resolveTaskTitle(this._taskTitleSources);
    if (this.taskTitle !== effectiveTitle.taskTitle || this.taskTitleIsCustom !== effectiveTitle.isCustom) {
      this.taskTitle = effectiveTitle.taskTitle;
      this.taskTitleIsCustom = effectiveTitle.isCustom;
      this.emit("task-title-change", effectiveTitle);
    }
    const titleState = buildPersistedTaskTitle(this._taskTitleSources);
    const signature = JSON.stringify(titleState);
    if (signature === this._taskTitleStateSignature) return;
    this._taskTitleStateSignature = signature;
    this.emit("task-title-state-change", titleState);
  }

  _resetAutomaticTaskTitle(): void {
    this._taskTitleReadSequence++;
    this._taskTitleSources = { customTitle: this.customTitle };
    this._recentTaskPrompts = [];
    this.taskTitlePromptRevision++;
    this.emit("task-title-reset");
    this._updateTaskTitle();
  }

  async _refreshTranscriptTaskTitle(): Promise<void> {
    if (!this._adapter.titleProfile.taskTitle.readsTranscriptTitle || !this._transcriptPath) return;
    const transcriptPath = this._transcriptPath;
    const readSequence = ++this._taskTitleReadSequence;
    const aiTitle = await readTranscriptTaskTitle(transcriptPath);
    if (this._destroyed || readSequence !== this._taskTitleReadSequence || transcriptPath !== this._transcriptPath || !aiTitle) return;
    this._taskTitleSources.aiTitle = aiTitle;
    this._updateTaskTitle();
  }

  setRecorder(recorder: SessionRecorderPort | null): void {
    this._recorder = recorder;
  }

  get auditLog(): Record<string, unknown>[] {
    return this._observability.auditLog;
  }

  _can(capability: keyof AgentCapabilities): boolean {
    return this._adapter.capabilities?.[capability] === true;
  }

  _armTimer(field: TimerField, ms: number, fn: () => void, { unref = false }: { unref?: boolean } = {}): void {
    this._clearTimer(field);
    const timer = setTimeout(() => {
      this[field] = null;
      fn();
    }, ms);
    this[field] = timer;
    if (unref) unrefTimer(timer);
  }

  _clearTimer(field: TimerField): void {
    const timer = this[field];
    if (!timer) return;
    clearTimeout(timer);
    this[field] = null;
  }

  ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    if (raw?.signal === "auth-failed") {
      if (this._respawnAfterAuthFailure()) return;
      this.ingestHookSignal({ ...raw, signal: "awaiting-input" });
      return;
    }
    if (raw?.signal === "ready" && String(raw.event || "").toLowerCase() === "stop") this._hasRespawnedForAuth = false;
    this._hookSeen = true;
    if (this._recorder && raw?.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }

    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this.backgroundTracking.trackSubagent(raw);
      return;
    }

    if (raw && (raw.signal === "task-created" || raw.signal === "task-completed" || raw.signal === "teammate-idle")) {
      this.backgroundTracking.trackTaskLifecycle(raw);
      return;
    }

    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this.backgroundTracking.trackWakeup(raw);
      return;
    }

    if (raw?.payload) {
      const sessionIdOf = typeof this._adapter.sessionIdOf === "function"
        ? this._adapter.sessionIdOf
        : (payload: HookPayload) => payload?.session_id;
      this._captureClaudeSessionId(
        sessionIdOf(raw.payload), raw.payload.source, raw.payload.transcript_path, raw.signal, raw.confidence);
    }

    const hookEvent = String(raw.event || "").toLowerCase();
    if (hookEvent === "stop") this._observeCompaction("stop");
    if (raw.signal === "compaction-start") {
      this._observeCompaction(raw.signal);
      this._statusSource.reset();
      this.backgroundTracking.clearGateHeldReady();
      return;
    }
    if (raw.signal === "compaction-end") {
      this._finishCompaction();
      return;
    }

    if (hookEvent === "userpromptsubmit") {
      const prompt = raw.payload?.prompt;
      if (!this._taskTitleSources.promptTitle) {
        this._taskTitleSources.promptTitle = extractPromptTaskTitle(prompt);
        this._updateTaskTitle();
      }
      if (typeof prompt === "string" && isSubstantivePrompt(prompt)) {
        const cleanedPrompt = cleanTaskPrompt(prompt);
        this._recentTaskPrompts = [...this._recentTaskPrompts, cleanedPrompt].slice(-5);
        this.taskTitlePromptRevision++;
        this.emit("task-prompt", { prompt: cleanedPrompt });
      }
    }
    if (hookEvent === "stop" && (this.state === STATES.IDLE || this.state === STATES.COMPLETE)) {
      void this._refreshTranscriptTaskTitle();
    }

    if (raw && raw.signal === "awaiting-input") {
      const isNotificationInSameWaitingEpisode = String(raw.event || "").toLowerCase() === "notification" && this.state === STATES.WAITING;
      this._setPendingPromptKind(raw.promptKind || null, raw.promptToolName ?? null, isNotificationInSameWaitingEpisode);
    }
    if (raw && raw.signal === "session-start") this._onSessionStartHook(raw);
    if (raw && raw.signal === "resume") {
      this._observeCompaction("resume");
      this._titleQuiet = false;
      this._setPendingPromptKind(null);

      this.backgroundTracking.clearGateHeldReady();
      this.backgroundTracking.resetTurnEvidence();
      this.backgroundTracking.clearBgDeclared();

      this.emit("user-prompt", { state: this.state, stateSince: this.stateSince, ts: Date.now(), isSelfWake: isSelfWakePrompt(raw.payload?.prompt) });
    }

    if (raw && raw.signal === "ready" && raw.source === "hook") {
      this.backgroundTracking.applyBackgroundTasks(raw.payload);
    }
    this._statusSource.ingest(raw);
  }

  _onSessionStartHook(raw: HookSignal): void {
    const payload = raw.payload || {};
    const src = String(payload.source || "").toLowerCase();
    if (src !== "clear" && src !== "compact") return;
    if (src === "compact") {
      this._finishCompaction();
      return;
    }
    this._compaction = createCompactionTracking();
    this._emitSessionDetail();
    this._resetAutomaticTaskTitle();
    this._resetDetectionSources({ quiet: true });
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.resetTurnEvidence();
    this._setPendingPromptKind(null);
  }

  _captureClaudeSessionId(
    id: unknown,
    source: unknown,
    transcriptPath: unknown,
    signal: string | null,
    confidence?: string | null,
  ): void {
    if (this._suppressResumeCapture) return;
    if (typeof id !== "string" || !RESUME_ID_RE.test(id)) return;
    const reportedTranscriptPath = typeof transcriptPath === "string" && transcriptPath ? transcriptPath : null;
    const reportedSource = typeof source === "string" ? source : null;
    const shouldAdopt = shouldAdoptReportedResumeId({
      currentResumeSessionId: this._resumeSessionId,
      reportedId: id,
      signal,
      sessionStartSource: reportedSource,
      confidence,
    });
    if (shouldAdopt) this.setResumeConversation(id);

    const isResumeTarget = id === this._resumeSessionId;
    if (reportedTranscriptPath && isResumeTarget) this._transcriptPath = reportedTranscriptPath;
    const liveTranscriptPath = reportedTranscriptPath || this._transcriptPath;
    const lastReport = this._lastClaudeSessionReport;
    const isRepeatReport = !!lastReport
      && lastReport.id === id
      && lastReport.transcriptPath === liveTranscriptPath
      && lastReport.isResumeTarget === isResumeTarget;
    if (isRepeatReport) return;
    this._lastClaudeSessionReport = { id, transcriptPath: liveTranscriptPath, isResumeTarget };

    const event: ClaudeSessionIdEvent = {
      id,
      source: reportedSource,
      vendor: this.usageVendor,
      sessionId: id,
      transcriptPath: liveTranscriptPath,
      isResumeTarget,
    };
    this.emit("claude-session-id", event);
  }

  _setPendingPromptKind(kind: string | null, toolName: string | null = null, mayInheritCurrentToolName = false): void {
    const next = kind || null;
    this._pendingPromptToolName = nextPendingPromptToolName(this._pendingPromptKind, this._pendingPromptToolName, next, toolName, mayInheritCurrentToolName);
    if (next === this._pendingPromptKind) return;
    this._pendingPromptKind = next;
    this._emitSessionDetail();
  }

  _observeCompaction(signal: string, source?: string | null): void {
    if (!this._can("compactQuiet")) return;
    const wasCompacting = this._compaction.isCompacting;
    this._compaction = observeCompaction(this._compaction, {
      signal, source, state: this.state,
      pendingPromptKind: this._pendingPromptKind,
      pendingPromptToolName: this._pendingPromptToolName,
    });
    if (this._compaction.isCompacting !== wasCompacting) this._emitSessionDetail();
  }

  setWaitingForMemory(isWaiting: boolean): void {
    if (isWaiting === this._isWaitingForMemory) return;
    this._isWaitingForMemory = isWaiting;
    this._emitSessionDetail();
  }

  _emitSessionDetail(): void {
    this.emit("prompt-kind-change", {
      pendingPromptKind: this._pendingPromptKind,
      isCompacting: this._compaction.isCompacting,
      isWaitingForMemory: this._isWaitingForMemory,
    });
  }

  _finishCompaction(): void {
    const finished = finishCompaction(this._compaction, this.state);
    this._compaction = finished.tracking;
    if (finished.shouldResetDetectionSources) {
      this._resetDetectionSources({ quiet: true });
      this.backgroundTracking.clearGateHeldReady();
    }
    if (finished.event) {
      this.transition(finished.event, { source: "hook", signal: "compaction-end" });
      this._setPendingPromptKind(finished.returnState?.pendingPromptKind ?? null, finished.returnState?.pendingPromptToolName ?? null);
    }
    this._emitSessionDetail();
  }

  _pushAuditEntry(entry: Record<string, unknown>): void {
    this._observability.pushAuditEntry(entry);
  }

  _recordDecision(entry: DecisionEntry): void {
    this._observability.recordDecision(entry);
  }

  recordNotifyDecision(entry: DecisionEntry): void {
    this._recordDecision(entry);
  }

  _resetDetectionSources({ quiet, clearTracking = false }: { quiet?: boolean; clearTracking?: boolean } = {}): void {
    this._titleSource.reset();
    this._statusSource.reset();
    if (quiet !== undefined) this._titleQuiet = quiet;

    if (clearTracking) this._clearDetectionTracking();
  }

  _clearDetectionTracking(): void {
    this._compaction = createCompactionTracking();
    this._emitSessionDetail();
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearAgents();
    this.backgroundTracking.clearWakeups();
    this._setPendingPromptKind(null);
  }

  _onStatus(s: ResolvedStatusSignal): void {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };

    this._observeCompaction(s.signal, s.source);
    if (isCompactionEndingSignal(this._compaction, s.signal, s.source)) {
      this._finishCompaction();
      return;
    }
    if (suppressCompactionSignal(this._compaction, s.signal)) return;

    const signalSeq = this.backgroundTracking.noteStatus(s.signal);

    if (s.signal === "working") this._setPendingPromptKind(null);

    const active = this.backgroundTracking.activeAgentCount();
    const eventWithoutGate = mapSignalToEvent(s.signal, this.state, s.confidence, 0);
    const orphanStopGate = s.signal === "ready" && s.source === "hook"
      && this.backgroundTracking.hasOrphanStopEvidence() && !!eventWithoutGate;
    const event = mapCompactionActivityEvent(this._compaction, s.signal, orphanStopGate
      ? null
      : mapSignalToEvent(s.signal, this.state, s.confidence, active));

    const gateHeld = !event && s.signal === "ready" && (active > 0 || orphanStopGate)
      && !!eventWithoutGate;
    this._recordDecision({
      ts: Date.now(),
      kind: "signal",
      signal: s.signal,
      source: s.source,
      confidence: s.confidence || null,
      state: this.state,
      seq: signalSeq,
      active,
      orphanStop: orphanStopGate,
      ...this.backgroundTracking.agentBreakdown(),
      event: event || null,
      action: event ? "transition" : (gateHeld ? "gate-held" : "no-op"),
    });
    const compactionDetail = isIdleCompactionActivity(this._compaction, s.signal, s.source) ? { isIdleCompactionActivity: true } : {};
    if (event) this.transition(event, { source: s.source, signal: s.signal, ...compactionDetail });
    if (gateHeld) this.backgroundTracking.stashGateHeldReady(s);

    if (s.signal === "ready") this.worktreeLifecycle.scheduleCheck();
  }

  _onMeta(m: MetaStatusSignal): void {

    this._lastSignal = { signal: m.signal, source: m.source, ts: m.ts, meta: true };
  }

  get pid(): number | null {
    return this.ptyProcess ? this.ptyProcess.pid : null;
  }

  get hookSeen(): boolean {
    return this._hookSeen;
  }

  get hasBackgroundWork(): boolean {
    return this.backgroundTracking.hasBackgroundWork();
  }

  get agentToken(): string | null {
    return this._agentToken;
  }

  _agentApiEnv(): Record<string, string> {
    if (!this._agentToken) return {};
    const port = this._hooks.listenerPort();
    if (!port) return {};
    const url = `http://127.0.0.1:${port}/agent/${encodeURIComponent(this.id)}?t=${encodeURIComponent(this._agentToken)}`;
    return { [AGENT_URL_ENV]: url };
  }

  get commitSigningToken(): string | null {
    return this._commitSigningToken;
  }

  _commitSigningEnv(): Record<string, string> {
    if (this._getRemoteLaunch() !== null) return {};
    return commitSigningEnv({
      port: this._hooks.listenerPort(),
      sessionId: this.id,
      token: this._commitSigningToken,
      signingProgram: this._commitSigningProgram,
      inheritedConfigParameters: this._spawnEnv?.GIT_CONFIG_PARAMETERS ?? process.env.GIT_CONFIG_PARAMETERS,
    });
  }

  agentSpawnBudget(): { liveChildren: number; lifetimeSpawns: number; inFlight: number; depth: number } {
    return {
      liveChildren: this._agentLiveChildren,
      lifetimeSpawns: this._agentLifetimeSpawns,
      inFlight: this._agentSpawnsInFlight,
      depth: this._agentDepth,
    };
  }

  beginAgentSpawn(): void {
    this._agentSpawnsInFlight += 1;
    this._agentLifetimeSpawns += 1;
    this._agentLiveChildren += 1;
  }

  finishAgentSpawn(): void {
    this._agentSpawnsInFlight = Math.max(0, this._agentSpawnsInFlight - 1);
  }

  noteAgentChildExit(): void {
    this._agentLiveChildren = Math.max(0, this._agentLiveChildren - 1);
  }

  noteAttention(note: string): AgentAttentionReply {
    if (this._destroyed) return { ok: true, pending: false };
    if (shouldDeferAttention(this.state)) {
      if (this._pendingAttentionNotes.length >= MAX_PENDING_ATTENTION_NOTES) {
        return { ok: false, error: `the session is already holding ${MAX_PENDING_ATTENTION_NOTES} attention notes; wait until it can accept input` };
      }
      this._pendingAttentionNotes.push(note);
      return { ok: true, pending: true };
    }
    this._raiseAttention(note);
    return { ok: true, pending: false };
  }

  _raiseAttention(note: string): void {
    const ts = Date.now();
    this._setPendingPromptKind("agent");
    this.emit("agent-attention", { note, ts });
    this._statusSource.ingest({
      signal: "awaiting-input",
      source: "agent",
      confidence: "high",
      ts,
    });
  }

  _releasePendingAttention(): void {
    if (this._pendingAttentionNotes.length === 0) return;
    if (!acceptsAttentionSignal(this.state)) return;
    const releasing = this._pendingAttentionNotes;
    this._pendingAttentionNotes = [];
    this._raiseAttention(releasing.join(AGENT_ATTENTION_NOTE_SEPARATOR));
  }

  get hasLivePty(): boolean {
    return !this._destroyed && !!this.ptyProcess && !!this._ptyAlive;
  }

  get pendingRestart(): boolean {
    return this._pendingRestart;
  }

  setResumeConversation(id: string | null): void {
    this._resumeSessionId = id || null;
    this._lastClaudeSessionReport = null;
  }

  get resumeSessionId(): string | null {
    return this._resumeSessionId;
  }

  get saneYolo(): boolean {
    return this._isSaneYoloActive;
  }

  _prepareRestart(options: { fresh?: boolean } = {}): void {
    if (options.fresh !== true) return;

    this._suppressResumeCapture = true;
    this.setResumeConversation(null);
    this._transcriptPath = null;
    this._resetAutomaticTaskTitle();
    this.emit("resume-cleared", { id: this.id });
  }

  toSnapshot() {
    return this._projectSnapshots().wire;
  }

  get worktreeDir(): string | null { return this.worktreeLifecycle.snapshot().worktreeDir; }

  get commonGitDir(): string | null { return this.worktreeLifecycle.snapshot().commonGitDir; }

  get baseSha(): string | null { return this.worktreeLifecycle.snapshot().baseSha; }

  get mergeStatus(): string { return this.worktreeLifecycle.snapshot().mergeStatus; }

  get mergeReason(): string | null { return this.worktreeLifecycle.snapshot().mergeReason; }

  get mergeConflicts(): string[] { return this.worktreeLifecycle.snapshot().mergeConflicts; }

  get worktreeNotice(): string | null { return this.worktreeLifecycle.snapshot().worktreeNotice; }

  get isWorktree(): boolean { return this.worktreeLifecycle.snapshot().isWorktree; }
  get isWorkspace(): boolean { return this.worktreeLifecycle.snapshot().isWorkspace; }
  get remoteWorkspace(): string | null { return this._getRemoteLaunch()?.workspace ?? null; }

  getWorktreeCarry() { return this.worktreeLifecycle.getCarry(); }

  get hasOwnWorktree(): boolean { return this.worktreeLifecycle.hasOwnWorktree(); }

  refreshGitContext() { return this.worktreeLifecycle.refreshGitContext(); }

  effectiveCwd(): string { return this.worktreeLifecycle.effectiveCwd(); }

  _spawnCwdSpellings(): string[] {
    const spawnCwd = this.effectiveCwd();
    try {
      return Array.from(new Set([spawnCwd, fs.realpathSync.native(spawnCwd)]));
    } catch {
      return [spawnCwd];
    }
  }

  _provisionWorktree({ fresh = false }: { fresh?: boolean } = {}) { return this.worktreeLifecycle.provision({ fresh }); }

  _settleWorktreeOnExit() { return this.worktreeLifecycle.settleOnExit(); }

  discardWorktreeIfClean() { return this.worktreeLifecycle.discardIfClean(); }

  releaseDroppedWorkspaceMembers(keepRepoPaths: string[]) { return this.worktreeLifecycle.releaseDroppedWorkspaceMembers(keepRepoPaths); }

  pasteMergePrompt() { return this.worktreeLifecycle.pasteMergePrompt(); }

  pasteText(text: string) { return this._output.pasteText(text); }

  pasteTextWhenReady(text: string, { timeoutMs = 120000 }: { timeoutMs?: number } = {}) {
    return this._output.pasteTextWhenReady(text, { timeoutMs });
  }

  _clearPendingPaste(): void { this._output.clearPendingPaste(); }

  hasUnmergedWork() { return this.worktreeLifecycle.hasUnmergedWork(); }

  getDiff() { return this.worktreeLifecycle.getDiff(); }

  getChangeScopes() { return this.worktreeLifecycle.getChangeScopes(); }

  getBranchSync() { return this.worktreeLifecycle.getBranchSync(); }

  resyncBranch() { return this.worktreeLifecycle.resyncBranch(); }

  checkWorktreeChange(signature?: Parameters<ReturnType<typeof createSessionWorktreeLifecycle>["checkWorktreeChange"]>[0]) {
    return this.worktreeLifecycle.checkWorktreeChange(signature);
  }

  mergeWorktree(isolation?: GitIsolationOptions) { return this.worktreeLifecycle.mergeWorktree(isolation); }

  mergeAndContinue(options: { force?: boolean } = {}) { return this.worktreeLifecycle.mergeAndContinue(options); }

  adoptWorktree(options: Parameters<ReturnType<typeof createSessionWorktreeLifecycle>["adoptWorktree"]>[0]) {
    return this.worktreeLifecycle.adoptWorktree(options);
  }

  discardWorktree() { return this.worktreeLifecycle.discardWorktree(); }
  findWorkspaceKeptWork() { return this.worktreeLifecycle.findWorkspaceKeptWork(); }
  confirmWorkspaceWorkDiscard() { this.worktreeLifecycle.confirmWorkspaceWorkDiscard(); }

  getDetectionStats() {
    return {
      lastSignal: this._lastSignal,
      hookSeen: this._hookSeen,
      hooksInjected: this._hooks.hasInjection(),
      titleState: this._titleSource.getState(),
    };
  }

  getHealthStats() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      destroyed: this._destroyed,
      pendingRestart: this._pendingRestart,
      hasPty: this.ptyProcess !== null,
      ptyPid: this.ptyProcess ? this.ptyProcess.pid : null,
      outputBufferEntries: this._output.stats().entries,
      outputBufferBytes: this._output.stats().bytes,
      outputBufferTotal: this._output.stats().total,
      auditLogLength: this.auditLog.length,
      dataListenerCount: this.listenerCount("data"),
      hookSeen: this._hookSeen,
      timers: {
        killPoll: this._killPollTimer !== null,
      },
    };
  }

  getDebugState() {
    return this._projectSnapshots().debug;
  }

  _projectSnapshots() {
    const active = this.backgroundTracking.activeAgentCount();
    const held = this.backgroundTracking.heldReady();
    return projectSessionSnapshots({
      id: this.id,
      name: this.name,
      taskTitle: this.taskTitle,
      taskTitleIsCustom: this.taskTitleIsCustom,
      path: this.path,
      agent: this.agentId,
      state: this.state,
      stateSince: this.stateSince,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      saneYolo: this.saneYolo,
      ephemeral: this.ephemeral,
      ownerId: this.ownerId,
      isWorktree: this.isWorktree,
      isWorkspace: this.isWorkspace,
      remoteWorkspace: this.remoteWorkspace,
      isGuarded: this.isGuarded,
      isGuardrailsReleased: this.isGuardrailsReleased,
      resumeSessionId: this._resumeSessionId,
      activeAgents: active,
      awaitingBackgroundTasks: this.backgroundTracking.awaitingBackgroundTasks(),
      pendingWakeup: this.backgroundTracking.pendingWakeup(),
      pendingPromptKind: this._pendingPromptKind,
      conversationApproval: this._conversationApproval,
      hasConversationBridge: this._codexBridge !== null,
      isConversationViewOn: this._isConversationViewEnabled(),
      isCompacting: this._compaction.isCompacting,
      isWaitingForMemory: this._isWaitingForMemory,
      hasPlan: this._planReviewPort?.hasPlan(this.id) === true,
      mergeStatus: this.mergeStatus,
      mergeReason: this.mergeReason,
      worktreeNotice: this.worktreeNotice,
      failureReason: this.failureReason,
      unseenOutcome: this.unseenOutcome,
      effectiveBase: this.worktreeLifecycle.snapshot().effectiveBase,
      linkedPrs: this.linkedPrs,
      coherenceHooks: this.coherenceHooks,
      auditLog: this.auditLog,
      detection: {
        ...this.getDetectionStats(),
        agents: { ...this.backgroundTracking.agentBreakdown(), active },
        gate: held
          ? { heldForMs: Date.now() - held.ts, seq: held.seq, lastActivitySeq: this.backgroundTracking.lastActivitySeq() }
          : null,
      },
      decisions: this._observability.decisionTail(15),
    });
  }

  transition(event: string, detail?: unknown): boolean {
    const stateTransitions = TRANSITIONS[this.state];
    if (!stateTransitions || !(event in stateTransitions)) {
      return false;
    }

    const guard = GUARDS[event];
    if (guard && !guard(this, detail)) {
      return false;
    }

    const from = this.state;
    const to = stateTransitions[event];

    if (from === to) {
      this._pushAuditEntry({
        from,
        to,
        event,
        detail: detail || null,
        timestamp: Date.now(),
        selfTransition: true,
      });
      if (this._recorder) {
        this._recorder.writeState(from, to, event, detail);
      }
      return true;
    }

    const exitHook = EXIT_HOOKS[from];
    if (exitHook) {
      exitHook(this);
    }

    if (from === STATES.WAITING) {
      this._setPendingPromptKind(null);
    }

    this.state = to;
    if (event === "spawn_fail") this.failureReason = describeSpawnFailure(detail);
    if (to === STATES.INITIALIZING) this.failureReason = null;
    const unseenOutcomeOnEntry = UNSEEN_OUTCOME_ON_ENTRY.get(to);
    if (unseenOutcomeOnEntry !== undefined && !isCompactionRestoreEvent(event)) this._setUnseenOutcome(unseenOutcomeOnEntry);
    if (to === STATES.IDLE || to === STATES.COMPLETE) this._observeCompaction("settled");

    const entryHook = ENTRY_HOOKS[to];
    if (entryHook && !isCompactionRestoreEvent(event)) {
      entryHook(this);
    }

    if (to === STATES.IDLE || to === STATES.COMPLETE) {
      this._titleSource.resyncWorkingLatch();
      void this._refreshTranscriptTaskTitle();
    }

    const enteredAt = Date.now();
    this.stateSince = enteredAt;
    this._pushAuditEntry({
      from,
      to,
      event,
      detail: detail || null,
      timestamp: enteredAt,
    });

    if (this._recorder) {
      this._recorder.writeState(from, to, event, detail);
    }

    this.emit("state-change", { from, to, event, detail: detail || null });

    this._releasePendingAttention();

    return true;
  }

  start(options: { fresh?: boolean; resumePrompt?: string | null } = {}): Promise<void> {
    if (this._startPending) return this._startPending;
    this._startPending = this._startBody(options).finally(() => { this._startPending = null; });
    return this._startPending;
  }

  refreshCoherenceHooks(): Promise<void> {
    if (this._coherenceHooksRefresh) return this._coherenceHooksRefresh;
    this._coherenceHooksRefresh = this._refreshCoherenceHooksBody().finally(() => { this._coherenceHooksRefresh = null; });
    return this._coherenceHooksRefresh;
  }

  async _refreshCoherenceHooksBody(): Promise<void> {
    if (!this.coherenceAttachment || this._destroyed) return;
    const generationAtRefresh = this._coherenceHooksGeneration;
    const refreshedHooks = await this.coherenceAttachment.refreshHooks();
    if (this._destroyed || generationAtRefresh !== this._coherenceHooksGeneration || JSON.stringify(refreshedHooks) === JSON.stringify(this.coherenceHooks)) return;
    this.coherenceHooks = refreshedHooks;
    this.emit('coherence-hooks-change', this.coherenceHooks);
  }

  async _startBody({ fresh = false, resumePrompt = null }: { fresh?: boolean; resumePrompt?: string | null } = {}): Promise<void> {
    if (this._destroyed) return;
    this.setWaitingForMemory(false);

    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;

      this._killReap = this._reapTreeOnce(oldPid);
      this.ptyProcess = null;
    }

    const pendingReaps = this._awaitPendingReaps();
    if (pendingReaps) await pendingReaps;
    if (this._destroyed) return;

    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    const preparingState = this.state;
    const isStartSuperseded = () => this._destroyed || this.state !== preparingState;

    if (!(await this._provisionWorktree({ fresh }))) {
      if (!isStartSuperseded()) this.transition("provision_blocked");
      return;
    }
    if (isStartSuperseded()) return;
    if (this._requiresWorktree && !this.worktreeDir) {
      this.transition("provision_blocked");
      this.emit('error', new Error('This session requires its own git worktree'));
      return;
    }

    if (this._prepareCoherence) {
      this._coherenceHooksGeneration += 1;
      this.coherenceAttachment = await this._prepareCoherence(this.effectiveCwd(), this._prepareGuardrails ? (command) => this._confineCommand(command) : null);
      this.coherenceHooks = this.coherenceAttachment?.hooks ?? null;
      if (isStartSuperseded()) return;
      this.emit('coherence-hooks-change', this.coherenceHooks);
    }

    if (this.worktreeDir) {
      this.worktreeLifecycle.startWatching();

      if (this.mergeStatus === "pending-review") this.worktreeLifecycle.scheduleCheck();
    }
    this._receivedFirstOutput = false;

    this._clearDetectionTracking();
    this._output.reset();

    this.emit("rebaseline");
    this._resetDetectionSources({ quiet: false });

    if (this._getHookTools) {
      const currentHookTools = this._getHookTools().filter((tool) => this._can(HOOK_TOOLS[tool.id].capability));
      this._hookTools.splice(0, this._hookTools.length, ...currentHookTools);
    }
    const remoteLaunch = this._getRemoteLaunch();
    if (remoteLaunch !== null && this.agentId !== DEFAULT_AGENT_ID && this.agentId !== "codex") {
      this._abandonSpawn(new Error("A Coder workspace session runs Claude Code or Codex only"));
      return;
    }
    const isRemoteCodex = remoteLaunch !== null && this.agentId === "codex";
    const hookInjection = this._hooks.inject();
    this._isSaneYoloActive = remoteLaunch === null && hookInjection.isSaneYoloActive;
    if (this._hooks.isRequiredGuardrailsMissing()) {
      this._abandonSpawn(new Error(GUARDRAILS_UNAPPLIED_ERROR));
      return;
    }
    const settingsArgs = [...hookInjection.args];

    this._titleQuiet = this._adapter.titleProfile.quietUntilFirstPrompt === true && this._hooks.hasInjection() && !isRemoteCodex;
    this._armTitleQuietFallback();

    this._titleSource.setContext({ cwdBasename: path.basename(this.effectiveCwd()) });
    const injectedEnv = { ...hookInjection.env, ...this._agentApiEnv(), ...this._commitSigningEnv() };
    const spawnExtraEnv = Object.keys(injectedEnv).length > 0
      ? { ...(this._spawnEnv || {}), ...injectedEnv }
      : this._spawnEnv;

    const rtkTool = this._hookTools.find((tool) => tool.id === "rtk");
    const env = this._buildSpawnEnv({
      prependPathDir: rtkTool ? path.dirname(rtkTool.binPath) : null,
      prependPathDirs: this._prependPathDirs,
      extraEnv: spawnExtraEnv,
    });

    const configuredResumeSessionId = this._can("resume") ? this._resumeSessionId : null;
    let spawnResumeSessionId = configuredResumeSessionId;
    if (this.usageVendor === "claude") {
      const resumeTarget = resolveResumeTarget({
        resumeSessionId: configuredResumeSessionId,
        transcriptPath: this._transcriptPath,
        projectsDirs: projectDirCandidates(env, [], os.homedir()),
        cwds: this._spawnCwdSpellings(),
        isTranscriptRemote: remoteLaunch !== null,
      }, fs.existsSync);
      spawnResumeSessionId = resumeTarget.resumeSessionId;
      if (configuredResumeSessionId && !spawnResumeSessionId) {
        console.warn(`[session:${this.name}] spawning without the stale resume id ${configuredResumeSessionId} because no transcript exists at any of: ${resumeTarget.checkedTranscriptPaths.join(", ")}`);
      }
    }

    this._suppressResumeCapture = false;
    const isSpawnGuarded = remoteLaunch === null && this._prepareGuardrails !== null;
    const launchSession = isSpawnGuarded
      ? this._adapter.launchSessionId?.({ resumeSessionId: spawnResumeSessionId, extraArgs: this._extraClaudeArgs, generatedId: randomUUID() }) ?? null
      : null;
    const agentArgs = this._adapter.buildArgs({
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      resumeSessionId: spawnResumeSessionId,
      extraArgs: launchSession?.extraArgs ?? this._extraClaudeArgs,
      initialPrompt: spawnResumeSessionId && resumePrompt ? resumePrompt : this._initialPrompt,
      hasOuterGuardrails: isSpawnGuarded,
      hasOperatorInstructions: this._hasOperatorInstructions(env),
      canRunHelpCommand: this._canRunHelpCommand,
      canSpawn: !this.ephemeral,
    });

    const bridgedLaunch = isRemoteCodex && remoteLaunch !== null
      ? await this._startRemoteCodexBridge(remoteLaunch, agentArgs, env)
      : await this._startConversationBridge(settingsArgs, agentArgs, env);
    if (isRemoteCodex && !bridgedLaunch) return;
    if (isStartSuperseded()) {
      this._hooks.cleanup();
      await this._stopConversationBridge();
      return;
    }
    const spawnCommand = await this._spawnCommandFor({ remoteLaunch, isRemoteCodex, settingsArgs, agentArgs, bridgedLaunch, agentSessionId: launchSession?.agentSessionId ?? null });
    if (!spawnCommand) {
      await this._stopConversationBridge();
      return;
    }
    if (isStartSuperseded()) {
      this._hooks.cleanup();
      this._disposeGuardrailsLaunch(this._guardrailsLaunch);
      await this._stopConversationBridge();
      return;
    }
    if (bridgedLaunch) env[CODEX_REMOTE_TOKEN_ENV] = bridgedLaunch.token;
    const { file, args } = spawnCommand;

    const ptySize = this._output.ptySize();
    const guardrailsLaunch = this._guardrailsLaunch;
    try {
      this.ptyProcess = this._ptySpawn(file, args, {
        name: "xterm-256color",
        cols: ptySize.cols,
        rows: ptySize.rows,
        cwd: spawnCommand.cwd ?? this.effectiveCwd(),
        env: { ...env, ...spawnCommand.env },
      });
    } catch (err) {
      this._abandonSpawn(err);
      return;
    }
    this._ptyAlive = true;
    this._guardPtyInputSocket();
    this._guardUnixPtySocket();

    const spawnCwdExists = fs.existsSync(this.effectiveCwd());
    if (!this.transition("spawn_success", { spawnCwdExists })) {
      this.ptyProcess.onExit(({ exitCode, signal }) =>
        this._handleSpawnedPtyExit(guardrailsLaunch, exitCode, signal),
      );
      this._isSaneYoloActive = false;
      this._hooks.cleanup();
      this.transition("spawn_fail", { reason: "spawn_cwd_missing" });
      this.kill();
      return;
    }

    const initialPrompt = this._initialPrompt;
    const argsForLog = initialPrompt
      ? args.map((a) => (a === initialPrompt ? `<prompt:${initialPrompt.length}c>` : a)).join(" ")
      : args.join(" ");
    console.log(
      `[session ${this.id}] spawn: ${file} ${argsForLog} (cwd=${this.effectiveCwd()})`,
    );

    if (this._recorder) {
      this._recorder.writeHeader({
        agent: this.agentId,
        hooksInjected: this._hooks.hasInjection(),
        cols: ptySize.cols,
        rows: ptySize.rows,
      });
    }

    this.ptyProcess.onData((data) => this._handlePtyData(data));
    this.ptyProcess.onExit(({ exitCode, signal }) =>
      this._handleSpawnedPtyExit(guardrailsLaunch, exitCode, signal),
    );
  }

  get isGuarded(): boolean {
    return this._prepareGuardrails !== null && this._getRemoteLaunch() === null;
  }

  isConversationBridgeRefused(settingsArgs: readonly string[] = [], agentArgs: readonly string[] = this._extraClaudeArgs): boolean {
    if (this.agentId !== "codex") return false;
    return this._prepareGuardrails !== null || this.bypassHookTrust || needsAppServerRefusedFlag(settingsArgs, agentArgs);
  }

  async _startConversationBridge(settingsArgs: string[], agentArgs: string[], env: SpawnEnv): Promise<{ tuiArgs: string[]; token: string } | null> {
    await this._stopConversationBridge();
    if (this.agentId !== "codex" || !this._isConversationViewEnabled()) return null;
    if (this.isConversationBridgeRefused(settingsArgs, agentArgs)) return null;
    const launch = splitCodexRemoteLaunch(settingsArgs, agentArgs);
    const prefix = this._adapter.buildSpawnCommand({ platform: this._platform, resolved: this._spawnCommand || commandFor(this._adapter), settingsArgs: [], agentArgs: [] });
    try {
      const bridge = await this._startCodexBridge({
        command: { file: prefix.file, argsBeforeAppServer: prefix.args },
        configArgs: launch.appServerConfigArgs,
        cwd: this.effectiveCwd(),
        env: { ...env },
        tokenParentDirectory: os.tmpdir(),
      });
      this._attachCodexBridge(bridge);
      return { tuiArgs: remoteTuiArgs(bridge.url, launch.tuiArgs), token: bridge.token };
    } catch (error) {
      console.warn(`[session:${this.name}] codex app-server bridge unavailable, using the plain terminal: ${errorMessage(error)}`);
      return null;
    }
  }

  async _stopConversationBridge(): Promise<void> {
    const bridge = this._codexBridge;
    if (!bridge) return;
    this._codexBridge = null;
    this._setConversationApproval(null);
    await bridge.stop().catch((error: unknown) => console.warn(`[session:${this.name}] codex app-server stop failed: ${errorMessage(error)}`));
  }

  _setConversationApproval(approval: ConversationApproval | null): void {
    this._conversationApproval = approval;
    this._emitConversationChange();
  }

  _emitConversationChange(): void {
    this.emit("conversation-change", {
      hasConversationBridge: this._codexBridge !== null,
      isConversationViewOn: this._isConversationViewEnabled(),
      conversationApproval: this._conversationApproval,
    });
  }

  announceConversationView(): void {
    this._emitConversationChange();
  }

  holdClaudePermission(payload: unknown, abandoned: AbortSignal): Promise<ClaudeHookReply | null> | null {
    if (this.agentId !== "claude-code" || !this._isConversationViewEnabled()) return null;
    const request = parseClaudePermissionRequest(payload);
    if (!request) return null;
    this._releaseClaudeHolds((hold) => hold.request.agentKey === request.agentKey);
    const requestId = `claude-${this._nextClaudeApprovalNumber}`;
    this._nextClaudeApprovalNumber += 1;
    return new Promise((resolve) => {
      const hold: ClaudeApprovalHold = { request, approval: claudeApprovalFor(request, requestId), resolve };
      this._claudeApprovalHolds.push(hold);
      abandoned.addEventListener("abort", () => this._releaseClaudeHolds((candidate) => candidate === hold), { once: true });
      this._showFirstClaudeApproval();
    });
  }

  _releaseClaudeHoldsAfterHookEvent(event: string, payload: Record<string, unknown>): void {
    if (this._claudeApprovalHolds.length === 0) return;
    this._releaseClaudeHolds((hold) => isHoldReleasedByHookEvent(hold.request, event, payload));
  }

  _releaseClaudeHolds(isReleased: (hold: ClaudeApprovalHold) => boolean): void {
    const released = this._claudeApprovalHolds.filter(isReleased);
    if (released.length === 0) return;
    this._claudeApprovalHolds = this._claudeApprovalHolds.filter((hold) => !released.includes(hold));
    for (const hold of released) hold.resolve(null);
    this._showFirstClaudeApproval();
  }

  _showFirstClaudeApproval(): void {
    this._setConversationApproval(this._claudeApprovalHolds[0]?.approval ?? null);
  }

  _answerClaudeApproval(requestId: number | string, decision: ConversationApprovalDecision, answers: ConversationAnswers | undefined): boolean {
    const hold = this._claudeApprovalHolds.find((candidate) => candidate.approval.requestId === requestId);
    if (!hold) return false;
    const reply = claudeDecisionReply(hold.request, hold.approval, decision, answers);
    if (!reply) return false;
    this._claudeApprovalHolds = this._claudeApprovalHolds.filter((candidate) => candidate !== hold);
    hold.resolve(reply);
    this._showFirstClaudeApproval();
    return true;
  }

  answerConversationApproval(requestId: number | string, decision: ConversationApprovalDecision, answers?: ConversationAnswers): boolean {
    if (this.agentId === "claude-code") return this._answerClaudeApproval(requestId, decision, answers);
    const bridge = this._codexBridge;
    if (!bridge || this._conversationApproval?.requestId !== requestId) return false;
    if (this._conversationApproval.isSummaryTruncated && decision !== "decline") return false;
    return bridge.answerApproval(requestId, decision);
  }

  _abandonSpawn(cause: unknown): void {
    this._isSaneYoloActive = false;
    this._hooks.cleanup();
    this._disposeGuardrailsLaunch(this._guardrailsLaunch);
    void this._stopConversationBridge();
    this._releaseClaudeHolds(() => true);
    this.transition("spawn_fail", { error: errorMessage(cause) });
    this.emit("error", cause);
  }

  _hasOperatorInstructions(env: SpawnEnv): boolean {
    const operatorConfigPath = this._adapter.operatorConfigPath?.(env) ?? null;
    if (operatorConfigPath === null) return false;
    try {
      return this._adapter.setsOperatorInstructions?.(fs.readFileSync(operatorConfigPath, "utf8")) === true;
    } catch (error) {
      return !isMissingFileError(error);
    }
  }

  async _spawnCommandFor({ remoteLaunch, isRemoteCodex, settingsArgs, agentArgs, bridgedLaunch, agentSessionId }: {
    remoteLaunch: RemoteLaunch | null;
    isRemoteCodex: boolean;
    settingsArgs: string[];
    agentArgs: string[];
    bridgedLaunch: { tuiArgs: string[]; token: string } | null;
    agentSessionId: string | null;
  }): Promise<SpawnCommand | null> {
    if (remoteLaunch !== null && !isRemoteCodex) return this._remoteSpawnCommand(remoteLaunch, agentArgs);
    const command = this._adapter.buildSpawnCommand({
      platform: this._platform,
      resolved: this._spawnCommand || commandFor(this._adapter),
      settingsArgs: bridgedLaunch ? [] : settingsArgs,
      agentArgs: bridgedLaunch?.tuiArgs ?? agentArgs,
    });
    if (isRemoteCodex) return { file: command.file, args: command.args, env: {} };
    return this._guardedSpawnCommand(command, agentSessionId);
  }

  async _startRemoteCodexBridge(remote: RemoteLaunch, agentArgs: string[], env: SpawnEnv): Promise<{ tuiArgs: string[]; token: string } | null> {
    await this._stopConversationBridge();
    const prepared = await this._prepareRemoteCodexBridge(remote, agentArgs, env).catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }));
    if (this._destroyed) {
      this._hooks.cleanup();
      await this._stopConversationBridge();
      return null;
    }
    if (!prepared.ok) {
      this._abandonSpawn(new Error(`Coder workspace ${remote.workspace}: ${prepared.reason}`));
      return null;
    }
    return prepared.launch;
  }

  async _prepareRemoteCodexBridge(remote: RemoteLaunch, agentArgs: string[], env: SpawnEnv): Promise<{ ok: true; launch: { tuiArgs: string[]; token: string } } | { ok: false; reason: string }> {
    const running = await remote.ensureRunning();
    if (!running.ok) return running;
    const version = await remote.codexVersion();
    if (version === null) return { ok: false, reason: "the host codex version could not be read, so the workspace cannot install a matching codex" };
    const launch = splitCodexRemoteLaunch([], agentArgs);
    const bridge = await this._startCodexBridge({
      command: { file: "coder", argsBeforeAppServer: [] },
      configArgs: launch.appServerConfigArgs,
      cwd: this.effectiveCwd(),
      env: { ...env },
      tokenParentDirectory: os.tmpdir(),
      startupTimeoutMs: REMOTE_CODEX_STARTUP_TIMEOUT_MS,
      remote: {
        launch: (appServerArgs) => {
          const script = remoteCodexAppServerScript({ version, workingDirectory: remote.checkoutDirectory, appServerArgs });
          const sshArgs = script === null ? null : coderSshExecArgs({ workspace: remote.workspace, remoteCommand: script });
          if (sshArgs === null) throw new Error("the remote Codex app-server command could not be built");
          return { file: "coder", args: sshArgs };
        },
        forward: (remotePort) => startCoderPortForward({ workspace: remote.workspace, remotePort }),
        login: remote.codexLoginParams,
        refreshLogin: remote.codexRefreshResult,
      },
    });
    this._attachCodexBridge(bridge);
    return { ok: true, launch: { tuiArgs: remoteTuiArgs(bridge.url, launch.tuiArgs), token: bridge.token } };
  }

  _attachCodexBridge(bridge: CodexAppServerBridge): void {
    this._codexBridge = bridge;
    bridge.on("records", (records: unknown) => this.emit("conversation-records", { records }));
    bridge.on("approval", (approval: { requestId: number | string; kind: ConversationApproval["kind"]; summary: string; isSummaryTruncated: boolean } | null) => {
      this._setConversationApproval(approval ? { requestId: approval.requestId, kind: approval.kind, summary: approval.summary, isSummaryTruncated: approval.isSummaryTruncated } : null);
    });
    bridge.on("error", (error: unknown) => console.warn(`[session:${this.name}] codex app-server bridge: ${errorMessage(error)}`));
    bridge.on("exit", () => {
      if (this._codexBridge !== bridge) return;
      this._codexBridge = null;
      this._setConversationApproval(null);
    });
    this._emitConversationChange();
  }

  async _remoteSpawnCommand(remote: RemoteLaunch, agentArgs: string[]): Promise<SpawnCommand | null> {
    const prepared = await this._prepareRemoteSpawn(remote, agentArgs).catch((error: unknown) => ({ ok: false as const, reason: errorMessage(error) }));
    if (this._destroyed) {
      this._hooks.cleanup();
      return null;
    }
    if (!prepared.ok) {
      this._abandonSpawn(new Error(`Coder workspace ${remote.workspace}: ${prepared.reason}`));
      return null;
    }
    return prepared.spawnCommand;
  }

  async _prepareRemoteSpawn(remote: RemoteLaunch, agentArgs: string[]): Promise<{ ok: true; spawnCommand: SpawnCommand } | { ok: false; reason: string }> {
    const hookToken = this._hooks.token();
    const ingressPort = this._hooks.listenerPort();
    if (hookToken === null || ingressPort === null) return { ok: false, reason: "hooks are unavailable, so the remote session could not report its status" };
    const running = await remote.ensureRunning();
    if (!running.ok) return running;
    const login = await remote.claudeToken();
    if (!login.ok) return login;
    const settingsPath = path.posix.join(path.posix.dirname(remote.checkoutDirectory), ".glimmervoid-sessions", safePathSegment(this.id), "settings.json");
    const settings = buildHookSettings({ port: remote.remotePort, glimmervoidId: this.id, token: hookToken, remoteNodePath: remote.nodePath });
    await remote.uploadFile({ remotePath: settingsPath, contents: JSON.stringify(settings), mode: 0o600 });
    const remoteCommand = remoteLaunchScript({
      workingDirectory: remote.checkoutDirectory,
      argv: ["claude", ...(this._adapter.settingsArgs?.(settingsPath) ?? []), ...agentArgs],
      tokenAliases: CLAUDE_TOKEN_ALIASES,
    });
    const sshArgs = remoteCommand === null ? null : coderSshArgs({ workspace: remote.workspace, remotePort: remote.remotePort, ingressPort, remoteCommand });
    const sshEnv = encodeCoderSshEnv({ [CLAUDE_TOKEN_ALIAS_ENV]: login.token });
    if (sshArgs === null || sshEnv === null) return { ok: false, reason: "the remote launch command could not be built" };
    return { ok: true, spawnCommand: { file: "coder", args: sshArgs, env: { [CODER_SSH_ENV]: sshEnv } } };
  }

  _respawnAfterAuthFailure(): boolean {
    if (this._getRemoteLaunch() === null || this._hasRespawnedForAuth) return false;
    this._hasRespawnedForAuth = true;
    console.warn(`[session:${this.name}] the remote Claude token was refused; respawning once with a fresh token`);
    return this.forceRestart({ resumePrompt: AUTO_CONTINUE_PROMPT });
  }

  async _guardedSpawnCommand(command: { file: string; args: string[] }, agentSessionId: string | null): Promise<SpawnCommand | null> {
    if (!this._prepareGuardrails) return { ...command, env: {} };
    const wrapped = await this._wrapInGuardrails(this._prepareGuardrails, command, agentSessionId)
      .catch((error: unknown) => new Error(`${GUARDRAILS_REFUSED_PREFIX}${errorMessage(error)}`));
    if (this._destroyed) {
      this._hooks.cleanup();
      this._disposeGuardrailsLaunch(this._guardrailsLaunch);
      return null;
    }
    if (wrapped instanceof Error) {
      this._abandonSpawn(wrapped);
      return null;
    }
    return wrapped;
  }

  async _wrapInGuardrails(prepareGuardrails: PrepareSessionGuardrails, command: { file: string; args: string[] }, agentSessionId: string | null): Promise<SpawnCommand> {
    const prepared = await prepareGuardrails({
      launchId: randomUUID(),
      cwd: this.effectiveCwd(),
      hookPort: this._hooks.hasInjection() ? this._hooks.listenerPort() : null,
      readablePaths: [
        ...this._hooks.injectedReadablePaths(this._isSaneYoloActive),
        ...(this._commitSigningProgram === null ? [] : [this._commitSigningProgram]),
      ],
      writablePaths: this._hooks.injectedWritablePaths(this._isSaneYoloActive),
      agentSessionId,
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    this._disposeGuardrailsLaunch(this._guardrailsLaunch);
    this._guardrailsLaunch = prepared.launch;
    const wrapped = await prepared.launch.wrap(command.file, command.args, { hasTerminal: true });
    return { ...wrapped, env: prepared.launch.env, cwd: prepared.launch.cwd };
  }

  async _confineCommand(command: { file: string; args: string[] }): Promise<ConfinedCommand> {
    if (!this._prepareGuardrails) throw new Error('this session has no guardrails to confine a command in');
    const prepared = await this._prepareGuardrails({
      launchId: randomUUID(), cwd: this.effectiveCwd(), hookPort: null, readablePaths: [], writablePaths: [], agentSessionId: null,
    });
    if (!prepared.ok) throw new Error(prepared.reason);
    const { launch } = prepared;
    try {
      const wrapped = await launch.wrap(command.file, command.args, { hasTerminal: false });
      return { ...wrapped, env: launch.env, ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }), dispose: () => launch.dispose() };
    } catch (error) {
      await launch.dispose();
      throw error;
    }
  }

  _disposeGuardrailsLaunch(launch: GuardrailsLaunch | null): void {
    if (!launch || launch !== this._guardrailsLaunch) return;
    this._guardrailsLaunch = null;
    launch.dispose().catch((error) => {
      console.warn(`[session ${this.id}] guardrails cleanup failed: ${errorMessage(error)}`);
    });
  }

  _guardPtyInputSocket(): void {
    try {
      this.ptyProcess?._agent?.inSocket?.on("error", (err) => {
        console.warn(`[session ${this.id}] pty input socket error (ignored): ${err.message}`);
      });
    } catch {

    }
  }

  _guardUnixPtySocket(): void {
    if (this._platform === "win32") return;
    try {
      this.ptyProcess?.on?.("error", (err) => this._handlePtySocketError(err));
    } catch {

    }
  }

  _handlePtySocketError(err: unknown): void {
    const errorCode = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : "";
    const code = String(errorCode || "");
    if (code.includes("EAGAIN")) return;
    if (code.includes("EIO") || code.includes("errno 5")) return;
    if (!this._ptyAlive) return;
    const message = errorMessage(err);
    console.warn(`[session ${this.id}] pty socket error: ${message} - killing the session`);
    this.kill();
  }

  _armTitleQuietFallback(): void {
    this._clearTimer("_titleQuietFallbackTimer");
    if (!this._titleQuiet) return;
    this._armTimer("_titleQuietFallbackTimer", this._titleQuietFallbackMs, () => {
      if (this._destroyed || !this._titleQuiet) return;
      if (this._hookSeen) return;
      console.warn(`[session:${this.name}] no hook callback within ${Math.round(this._titleQuietFallbackMs / 1000)}s - opening the title tier (detection is degraded)`);
      this._titleQuiet = false;
      this._recordDecision({ kind: "title-latch", ts: Date.now(), decision: "fallback-open", reason: "no hook callback before the deadline" });
    }, { unref: true });
  }

  _buildSpawnEnv({ extraEnv = this._spawnEnv, ...options }: {
    extraEnv?: Record<string, string> | null;
    prependPathDir?: string | null;
    prependPathDirs?: readonly string[];
  } = {}) {
    return this._adapter.buildEnv(process.env, extraEnv, options);
  }

  _handlePtyData(data: string): void {
    if (this._destroyed) return;
    if (this._recorder) {
      this._recorder.writeData(data);
    }

    if (this.state === STATES.STARTING && !this._receivedFirstOutput) {
      this._receivedFirstOutput = true;
      this.transition("first_output");
    }

    try {
      this._titleSource.feed(data);
    } catch (err) {
      console.error(`[session:${this.name}] title source error: ${errorMessage(err)}`);
    }

    this._output.push(data);
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    }
  }

  _isExitHeadedForFailure(event: string): boolean {
    if (this.state === STATES.FAILED) return false;
    const stateTransitions: Partial<Record<string, string>> | undefined = TRANSITIONS[this.state];
    return stateTransitions?.[event] === STATES.FAILED;
  }

  _handleSpawnedPtyExit(guardrailsLaunch: GuardrailsLaunch | null, exitCode: number, signal: ExitSignal): Promise<void> {
    this._disposeGuardrailsLaunch(guardrailsLaunch);
    void this._stopConversationBridge();
    this._releaseClaudeHolds(() => true);
    return this._handlePtyExit(exitCode, signal);
  }

  async _handlePtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._resetDetectionSources({ quiet: false, clearTracking: true });
    this._pendingAttentionNotes = [];

    this._hooks.cleanup();
    this._ptyAlive = false;
    this.ptyProcess = null;

    if (pid) {
      this._exitReap = this._reapTreeOnce(pid);
    }

    const { event, detail } = decideExitTransition(this.state, exitCode, signal, this._receivedFirstOutput);
    const reason = detail.reason || null;
    const pendingRemoteExitReason = this._isExitHeadedForFailure(event) ? this._getRemoteLaunch()?.describeExit().catch(() => null) : undefined;
    if (pendingRemoteExitReason) {
      const remoteExitReason = await pendingRemoteExitReason;
      if (remoteExitReason && this._isExitHeadedForFailure(event)) this.failureReason = remoteExitReason;
    }
    this.transition(event, detail);

    if (this._recorder) {
      this._recorder.writeFooter("pty_exit", exitCode);
      this._recorder.finishRecordingFile();
    }

    try { await this._settleWorktreeOnExit(); }
    catch {}

    this.emit("exit", { exitCode, signal, reason });
  }

  getScreenSnapshot(): ScreenSnapshot {
    return this._output.snapshot();
  }

  getDeepScreenSnapshot(): Promise<ScreenSnapshot> {
    return this._output.deepSnapshot();
  }

  ptySize(): { cols: number; rows: number; seq: number } {
    const size = this._output.ptySize();
    return { cols: size.cols, rows: size.rows, seq: this._resizeSeq };
  }

  getOutputOffset(): number {
    return this._output.stats().total;
  }

  getBufferSince(offset: number) {
    return this._output.since(offset);
  }

  write(text: string): void {
    if (this._recorder) {
      this._recorder.writeInput(text);
    }

    if (this.ptyProcess && this._ptyAlive) {
      this.ptyProcess.write(text);
    }
  }

  noteOperatorDraft(): void {
    this.emit("operator-input");
  }

  noteOperatorInput(input: string): void {
    if (isOperatorKeystroke(input)) this.emit("operator-input");
    const decision = decideWaitingInput({
      state: this.state,
      hasHookAwaitingInput: this._can("hooks") && this._can("awaitingInput"),
      pendingPromptKind: this._pendingPromptKind,
      isQuestionPrompt: this._pendingPromptToolName === ASK_USER_QUESTION_TOOL_NAME,
      input,
    });
    if (decision === "end-waiting") {
      this.transition("user_input");
      return;
    }
    if (decision === "acknowledge") this.emit("waiting-input-acknowledged");
  }

  resize(cols: number, rows: number): void {
    const didSizeChange = this._output.rememberSize(cols, rows);
    if (this._recorder) {
      this._recorder.writeResize(cols, rows);
    }
    if (!didSizeChange) return;

    if (this.ptyProcess) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch {}
      if (this._guardrailsLaunch && this._platform === "linux") void signalWindowChangeBelow(this.ptyProcess.pid);
    }
    this._resizeSeq += 1;
    this.emit("resize", { cols, rows, seq: this._resizeSeq });
  }

  _taskkill(pid: number | null, opts: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this._killProc(["/PID", String(Number(pid)), "/T", "/F"], { ...opts }, (err: unknown) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  _emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  _killProcessGroup(pid: number | null, signal: NodeJS.Signals = "SIGKILL"): void {
    const target = signalablePid(pid);
    if (target === null) return;
    try {
      this._signalProc(-target, signal);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
      if (err && code !== "ESRCH") this._emitError(err);
    }
  }

  _isProcessAlive(pid: number | null): boolean {
    const target = signalablePid(pid);
    if (target === null) return false;
    const probeTarget = this._platform === "win32" ? target : -target;
    try {
      this._signalProc(probeTarget, 0);
      return true;
    } catch {

      return false;
    }
  }

  _reapTreeOnce(pid: number | null): Promise<void> | null {
    if (this._platform === "win32") {
      return this._taskkill(pid, { timeout: KILL_REAP_MAX_WAIT_MS })
        .catch(() => {});
    }
    if (this._resolveKillReap) return this._killReap;
    return this._reapProcessGroup(pid);
  }

  _awaitPendingReaps(): Promise<void> | null {
    const pending = [this._killReap, this._exitReap].filter((reap) => reap !== null);
    if (pending.length === 0) return null;

    return awaitBounded(pending, { capMs: KILL_REAP_MAX_WAIT_MS }).then(() => {});
  }

  _reapProcessGroup(pid: number | null, { maxWaitMs = KILL_REAP_MAX_WAIT_MS }: { maxWaitMs?: number } = {}): Promise<void> {
    this._killProcessGroup(pid);
    return this._awaitProcessGone(pid, maxWaitMs);
  }

  _awaitProcessGone(pid: number | null, maxWaitMs: number): Promise<void> {

    if (this._resolveKillReap) this._resolveKillReap();
    return new Promise((resolve) => {
      const settle = (): void => {
        this._clearTimer("_killReapTimer");
        this._resolveKillReap = null;
        resolve();
      };
      this._resolveKillReap = settle;
      let waited = 0;

      const poll = (): void => {
        if (!this._isProcessAlive(pid)) {
          settle();
          return;
        }
        waited += KILL_POLL_INTERVAL_MS;
        if (waited >= maxWaitMs) {
          settle();
          return;
        }
        this._armTimer("_killReapTimer", KILL_POLL_INTERVAL_MS, poll);
      };

      poll();
    });
  }

  kill(): void {
    if (!this.ptyProcess) return;

    this._ptyAlive = false;
    const pid = this.ptyProcess.pid;

    if (this._platform === "win32") {

      const killReap = this._taskkill(pid);
      this._killReap = killReap;
      killReap.catch((err: unknown) => this._emitError(err));
    }
    if (this._platform !== "win32") {

      this._killReap = this._reapProcessGroup(pid);
    }

    this._forceKillAfterTimeout(pid);
  }

  _forceKillAfterTimeout(pid: number): void {
    let elapsed = 0;
    const poll = (): void => {
      if (this._destroyed) return;
      if (!this._isProcessAlive(pid)) return;
      elapsed += KILL_POLL_INTERVAL_MS;
      if (elapsed >= KILL_MAX_WAIT_MS) {

        if (this._platform === "win32") {
          this._taskkill(pid).catch((err: unknown) => this._emitError(err));
          return;
        }
        this._killProcessGroup(pid);
        return;
      }
      this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
    };

    this._armTimer("_killPollTimer", KILL_POLL_INTERVAL_MS, poll);
  }

  dismiss(): boolean {
    const hadUnseenOutcome = this.unseenOutcome !== null;
    this._setUnseenOutcome(null);
    if (!DISMISSIBLE_STATES.has(this.state)) return hadUnseenOutcome;
    return this.transition("user_dismiss");
  }

  _setUnseenOutcome(nextUnseenOutcome: UnseenOutcome | null): void {
    if (this.unseenOutcome === nextUnseenOutcome) return;
    this.unseenOutcome = nextUnseenOutcome;
    this.emit("unseen-outcome-change", { unseenOutcome: nextUnseenOutcome });
  }

  _teardownPending(): boolean {
    return this._pendingRestart || this._finishing;
  }

  killSession(): boolean {
    if (!KILLABLE_STATES.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill");
  }

  restart(options: { fresh?: boolean } = {}): boolean {
    if (this._destroyed) return false;

    if (this._teardownPending()) return false;
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    this._prepareRestart(options);
    this.transition("user_restart");
    this.start({ fresh: options.fresh === true });
    return true;
  }

  resetToDormant(): boolean {
    if (this._destroyed) return false;
    const did = this.transition("user_reset");
    if (did) this.worktreeLifecycle.setMergeStatus("none", {}, { emit: false });
    return did;
  }

  finishAndMerge(): { ok: boolean; pending?: boolean; reason?: string } {
    if (this._destroyed || this._teardownPending()) {
      return { ok: false, reason: this._teardownPending() ? "in-progress" : "destroyed" };
    }
    if (RESTARTABLE_STATES.includes(this.state)) {

      this._finishing = true;
      this._mergeAndReset().finally(() => { this._finishing = false; }).catch(() => {});
      return { ok: true };
    }
    if (this.state === STATES.COMPLETE || this.state === STATES.IDLE) {
      this._finishing = true;
      this.once("exit", async () => {
        try { if (!this._destroyed) await this._mergeAndReset(); }
        finally { this._finishing = false; }
      });
      this.killSession();
      return { ok: true, pending: true };
    }
    return { ok: false, reason: "not-finishable" };
  }

  async _mergeAndReset() {
    const r = await this.mergeWorktree();
    this.resetToDormant();
    return r;
  }

  forceRestart(options: { fresh?: boolean; resumePrompt?: string | null } = {}): boolean {
    if (this._destroyed) return false;
    if (this._teardownPending()) return false;
    if (KILLABLE_STATES.includes(this.state)) {
      this._prepareRestart(options);
      const fresh = options.fresh === true;
      this._pendingRestart = true;
      this.once("exit", () => {
        this._pendingRestart = false;
        if (this._destroyed) return;
        if (!RESTARTABLE_STATES.includes(this.state)) return;
        this.transition("user_restart");
        this.start({ fresh, resumePrompt: options.resumePrompt ?? null });
      });
      this.kill();
      this.transition("user_kill");
      return true;
    }
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    return this.restart(options);
  }

  updateSettings(cfg: { replayBufferKB?: number | null }): void {
    if (cfg.replayBufferKB != null)
      this._output.setMax(cfg.replayBufferKB * 1024);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._agentToken = null;
    this._commitSigningToken = null;
    this._pendingAttentionNotes = [];

    this._clearPendingPaste();

    this._hooks.cleanup();
    this._disposeGuardrailsLaunch(this._guardrailsLaunch);
    void this._stopConversationBridge();
    this._releaseClaudeHolds(() => true);

    this.kill();

    this._clearTimer("_killPollTimer");
    this._clearTimer("_titleQuietFallbackTimer");

    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearWakeups();

    if (this._recorder) {
      this._recorder.close();
    }
    this.worktreeLifecycle.stopWatching();
    this._output.disposeScreenKeeper();
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.emit("teardown", { id: this.id });
    this.removeAllListeners();
  }
}

function claudeCommand(): ResolvedCommand {
  return commandFor(DEFAULT_AGENT_ID);
}

export { GUARDRAILS_UNAPPLIED_ERROR, Session, claudeCommand };
export type { ClaudeSessionIdEvent, PrepareSessionGuardrails, RemoteLaunch, SessionOptions, SessionPlanReviewPort, SessionGuardrailsFacts };
