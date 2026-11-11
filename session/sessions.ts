import type { GitIsolationOptions } from '../server/git/core/git-invocation-core.ts';
import { errorMessage } from "../shared/text.ts";
import { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent, isIdleCompactionActivity } from "./core/compaction-core.ts";
import { isCompactionRestoreEvent } from "../shared/compaction-restore-events.ts";
import type { CompactionTracking } from "./core/compaction-core.ts";
import { HOOK_TOOLS } from './core/hook-tools.ts';
import { DEFAULT_TERMINAL_COLORS, scanTerminalColorQueries } from "./core/terminal-color-query.ts";
import type { TerminalColors } from "./core/terminal-color-query.ts";
import type { ResolvedHookTool } from './core/hook-tools.ts';
import fs from "node:fs";
import { buildPersistedTaskTitle, cleanTaskPrompt, extractHookTaskTitle, extractOscTaskTitle, extractPromptTaskTitle, isSelfWakePrompt, isSubstantivePrompt, resolveRefocusTaskTitle, resolveTaskTitle, seedTaskTitleSources } from "./core/task-title-core.ts";
import { maskSecrets } from "../shared/secret-patterns.ts";
import type { PersistedTaskTitle } from "../shared/contracts/config.ts";
import type { SessionEndCause } from "../shared/contracts/telemetry.ts";
import type { LinkedPr, SessionPrLinks } from "../shared/contracts/my-prs.ts";
import type { PromptContextReply, QuestionToolDenyResponse } from "../shared/contracts/refocus.ts";
import { mergeSessionPrLink, seedSessionPrLinks, withManualPrLink, withoutPrLink } from "./core/session-pr-links-core.ts";
import type { TaskTitleRefinementResult, TaskTitleSources } from "./core/task-title-core.ts";
import { readTranscriptTaskTitle } from "./session-task-title.ts";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";
import { EventEmitter } from "node:events";
import { assertLaunchable, execFile } from "../server/child-process-safe.ts";
import { projectDirCandidates } from "../server/usage/core/usage-scan-core.ts";
import { requireExecutableSpawnHelper } from "../server/node-pty-preflight.ts";
import { probeGraphicalSession } from "./graphical-session-probe.ts";
import { DETACHED_DESKTOP_BUS_ADDRESS } from "./core/spawn-env.ts";
import type { GraphicalSessionState } from "./core/spawn-env.ts";
import { STATES, KILLABLE_STATES, RESTARTABLE_STATES } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { unrefTimer } from "../shared/timer-deps.ts";
import { hintFor, permitsHelpCommand, promptHintFor, supervisionLine, toolHookFactsOf } from "./core/session-routes.ts";
import type { CommandHint, HintedCommand, PromptHint } from "./core/session-routes.ts";
import { ASK_USER_QUESTION_TOOL_NAME, type AgentAttentionReply, type AttentionNote, type AttentionOrigin } from "../shared/contracts/session.ts";
import { attentionNotesOf, createAttentionLanes, reduceAttention } from "./core/session-attention-core.ts";
import type { AttentionEvent, AttentionLanes } from "./core/session-attention-core.ts";
import { generateToken } from "../detection/settings-injector.ts";
import { mcpLaunchFor } from "../mcp/core/agent-config.ts";
import { createOscTitleSource } from "../detection/osc-title-source.ts";
import { createStatusSource } from "../detection/status-source.ts";
import type { MetaStatusSignal, ResolvedStatusSignal } from "../detection/status-source.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import { DEFAULT_AGENT_ID, isFirstClassAgent, resolveAdapter, commandFor } from "./adapters/index.ts";
import { startCodexAppServerBridge } from "./codex-app-server-bridge.ts";
import { CODEX_REMOTE_TOKEN_ENV } from "./core/codex-remote-launch-core.ts";
import type { CoherenceAttachment } from '../server/coherence/coherence-runtime.ts';
import type { CoherenceHooksState, ConversationAnswers, ConversationApproval, UnseenOutcome } from "../shared/contracts/session.ts";
import type { ClaudeHookReply } from "./core/claude-approval-core.ts";
import type { AgentAdapter, AgentCapabilities, ScratchAgentHome } from "./adapters/index.ts";

import {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
  UNSEEN_OUTCOME_ON_ENTRY,
} from "./core/state-machine.ts";
import { mapSignalToEvent } from "./core/status-mapper.ts";
import { decideWaitingInput, isComposerSubmit, isOperatorKeystroke, isPromptSubmit, LONE_ESCAPE } from "./core/waiting-input-core.ts";
import { decideExitTransition } from "./core/exit-transition.ts";
import { decideTeardown, NO_TEARDOWN } from "./core/session-teardown.ts";
import type { Teardown, TeardownAction } from "./core/session-teardown.ts";
import type { ExitSignal } from "./core/exit-transition.ts";
import * as agentTracker from "./core/agent-tracker.ts";
import { DEFAULT_GATE_RELEASE_SETTLE_MS } from "./core/gate-release.ts";
import { isConversationReplacedAtStartup, resolveResumeTarget, shouldAdoptReportedResumeId, RESUME_ID_RE } from "./core/auto-resume.ts";
import { projectSessionSnapshots } from "./core/snapshot-projection.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { createSessionObservability } from "./session-observability.ts";
import { createSessionOutput } from "./session-output.ts";
import type { ScreenSnapshot } from "./session-output.ts";
import type { ScreenKeeperFactory } from "./screen-keeper.ts";
import { createSessionHookLifecycle } from "./session-hook-lifecycle.ts";
import { folderTrustRoot } from "./core/copilot-trust-core.ts";
import type { HookRouterPort } from "./session-hook-lifecycle.ts";
import { createSessionWorktreeLifecycle } from "./session-worktree-lifecycle.ts";
import type { SeedDependencies } from "../server/git/dependency-clone.ts";
import type { GitWorkspace } from "./worktree/worktree-lifecycle-context.ts";
import { createSessionApprovalHolds } from "./session-approval-holds.ts";
import type { QuestionManagerPort, SessionApprovalHolds } from "./session-approval-holds.ts";
import { createSessionBackgroundTracking } from "./session-background-tracking.ts";
import { createSessionLaunch } from "./session-launch.ts";
import type { RemoteLaunch, SessionLaunch } from "./session-launch.ts";
import { createSessionProcessReaper } from "./session-process-reaper.ts";
import type { KillProc, SessionProcessReaper, SignalProc } from "./session-process-reaper.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { cleanHomeArgs, launchArgs } from "../shared/agent-models-core.ts";
import type { AgentSetup } from "../shared/contracts/agent-models.ts";

const PTY_PROMPT_SETTLE_MS = 1500;
const PTY_PROMPT_SUBMIT_DELAY_MS = 300;
const PASTE_BREAKING_CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
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

async function holdAllWorktreeReaders(holds: Iterable<() => Promise<() => void>>): Promise<() => void> {
  const outcomes = await Promise.allSettled([...holds].map((hold) => hold()));
  const releases = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
  return () => { for (const release of releases) release(); };
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

type TimerField = "_titleQuietFallbackTimer" | "_resumeNoteFallbackTimer";

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
  maskDeliveredValues?(values: readonly string[]): void;
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
  holdsQuestionsForParent?: boolean;
  questionManager?: QuestionManagerPort | null;
  startCodexBridge?: typeof startCodexAppServerBridge;
  titleQuietFallbackMs?: number;
  spawnCommand?: ResolvedCommand | null;
  initialPrompt?: string | null;
  extraClaudeArgs?: string[];
  agentSetup?: AgentSetup | null;
  ephemeral?: boolean;
  resumeSessionId?: string | null;
  settingsPermissions?: Record<string, unknown> | null;
  getRemoteLaunch?: (() => RemoteLaunch | null) | null;
  spawnEnv?: Record<string, string> | null;
  prependPathDirs?: string[];
  enableProjectMcp?: boolean;
  hookTools?: ResolvedHookTool[];
  planLimits?: boolean;
  getUserHooks?: (() => UserHook[]) | null;
  getTerminalColors?: (() => TerminalColors) | null;
  extraUserHooks?: UserHook[];
  scratchAgentHome?: ScratchAgentHome | null;
  isCleanHome?: boolean;
  requiresHooks?: boolean;
  prepareCoherence?: ((cwd: string) => Promise<CoherenceAttachment | null>) | null;
  ptySpawn?: PtySpawn | null;
  screenKeeperFactory?: ScreenKeeperFactory | null;
  killProc?: KillProc | null;
  signalProc?: SignalProc | null;
  platform?: NodeJS.Platform;
  gitWorkspace?: GitWorkspace | null;
  requireWorktree?: boolean;
  integrationBranch?: string | null;
  startSha?: string | null;
  autoRebase?: boolean;
  syncOnStart?: boolean;
  liveWorktreeReview?: boolean;
  worktreeRoot?: string | null;
  worktreeShare?: string[] | null;
  workspaceRepos?: string[];
  seedDependencies?: SeedDependencies | null;
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
  managerSeenSeq: number;
  ephemeral: boolean;
  agentId: string;
  usageVendor: string;
  bypassHookTrust: boolean;
  _launch: SessionLaunch;
  _approvals: SessionApprovalHolds<HookSignal>;
  backgroundTracking: ReturnType<typeof createSessionBackgroundTracking>;
  worktreeLifecycle: ReturnType<typeof createSessionWorktreeLifecycle>;
  _worktreeReaderHolds = new Set<() => Promise<() => void>>();

  _receivedFirstOutput: boolean;
  _hasPromptSinceSpawn: boolean;
  _titleQuietFallbackTimer: NodeJS.Timeout | null;
  _resumeNoteFallbackTimer: NodeJS.Timeout | null;
  _reaper: SessionProcessReaper;
  _teardown: Teardown;
  _ptyAlive: boolean;
  _recorder: SessionRecorderPort | null;
  _deliveredSecretValues: readonly string[] = [];
  _output: ReturnType<typeof createSessionOutput>;
  _adapter: AgentAdapter;
  _observability: ReturnType<typeof createSessionObservability>;
  _titleQuietFallbackMs: number;
  _hookSeen: boolean;
  _lastSignal: Record<string, unknown> | null;
  _compaction: CompactionTracking;
  _pendingPromptKind: string | null;
  _pendingPromptToolName: string | null;
  _attention: AttentionLanes;
  _titleQuiet: boolean;
  _hooksReportPrompts: boolean;
  _spawnCommand: ResolvedCommand | null;
  _initialPrompt: string | null;
  _pendingPromptSupervisionLine: string | null;
  _pendingResumeNote: string | null;
  _resumeNoteAwaitingTurn: string | null;
  _hintedCommands: Set<HintedCommand>;
  _shownHintCommands: Set<HintedCommand>;
  _ranCommands: Set<string>;
  _queuedCommandHints: PromptHint[];
  _extraClaudeArgs: string[];
  _agentSetup: AgentSetup | null;
  _isCleanHome: boolean;
  _resumeSessionId: string | null;
  readonly workspaceRepos: string[] | null;
  _transcriptPath: string | null;
  _lastClaudeSessionReport: { id: string; transcriptPath: string | null; isResumeTarget: boolean } | null;
  _suppressResumeCapture: boolean;
  _spawnEnv: Record<string, string> | null;
  _prependPathDirs: string[];
  _hookTools: ResolvedHookTool[];
  _isSaneYoloActive: boolean;
  _questionManager: QuestionManagerPort | null;
  _planLimits: boolean;
  _prepareCoherence: ((cwd: string) => Promise<CoherenceAttachment | null>) | null;
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
  _probeGraphicalSession: () => Promise<GraphicalSessionState>;
  _getRemoteLaunch: () => RemoteLaunch | null;
  _requiresWorktree: boolean;
  _platform: NodeJS.Platform;
  _startPending: Promise<void> | null;
  _resizeSeq: number;
  _titleSource: ReturnType<typeof createOscTitleSource>;
  _getTerminalColors: () => TerminalColors;
  _pendingColorQuery = "";
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
    holdsQuestionsForParent = false,
    questionManager = null,
    startCodexBridge = startCodexAppServerBridge,

    titleQuietFallbackMs = 30000,

    spawnCommand = null,

    initialPrompt = null,
    extraClaudeArgs = [],
    agentSetup = null,
    ephemeral = false,

    resumeSessionId = null,
    taskTitleState = undefined,
    prLinks = undefined,

    settingsPermissions = null,
    getRemoteLaunch = null,

    spawnEnv = null,
    prependPathDirs = [],

    enableProjectMcp = false,
    hookTools = [],


    planLimits = false,

    getUserHooks = null,
    getTerminalColors = null,
    extraUserHooks = [],
    scratchAgentHome = null,
    isCleanHome,
    requiresHooks = false,
    prepareCoherence = null,

    ptySpawn = null,
    requireWorktree = false,

    screenKeeperFactory = null,

    killProc = null,

    signalProc = null,

    platform = process.platform,

    gitWorkspace = null,
    integrationBranch = null,
    startSha = null,

    autoRebase = true,
    syncOnStart = true,

    liveWorktreeReview = true,

    worktreeRoot = null,
    worktreeShare = null,
    workspaceRepos = undefined,
    seedDependencies = null,

    agentDepth = 0,
    ownerId = null,
    commitSigningProgram = null,
  }: SessionOptions) {
    super();
    this.id = id;
    this.ownerId = ownerId;
    this.name = name;
    this.customTitle = customTitle || null;
    const seededTaskTitleSources = seedTaskTitleSources({ persistedTitle: taskTitleState, resumeSessionId, customTitle: this.customTitle, initialPrompt: initialPrompt ? maskSecrets(initialPrompt) : initialPrompt });
    this._taskTitleStateSignature = JSON.stringify(buildPersistedTaskTitle(seededTaskTitleSources));
    this._taskTitleSources = this._maskedTaskTitleSources(seededTaskTitleSources);
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
    this.managerSeenSeq = 0;
    this._receivedFirstOutput = false;
    this._hasPromptSinceSpawn = false;
    this._teardown = NO_TEARDOWN;

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
      off: (event, listener) => { this.off(event, listener); },
      screenKeeperFactory,
      onPasteExpired: (text) => { console.warn(`[session:${this.name}] dropped a queued paste of ${text.length} characters: the agent never became ready to take it (state ${this.state})`); },
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
    this._questionManager = isFirstClassAgent(this.agentId) && !ephemeral && !holdsQuestionsForParent ? questionManager : null;
    this._approvals = createSessionApprovalHolds({
      agentId: this.agentId,
      holdsQuestionsForParent,
      questionManager: this._questionManager,
      port: {
        emit: (event, detail) => this.emit(event, detail),
        ingestStatus: (signal) => this._ingestHookSignal(signal),
        pushAuditEntry: (entry) => this._pushAuditEntry(entry),
        taskTitle: () => this.refocusTaskTitle,
      },
    });
    this._titleQuietFallbackMs = titleQuietFallbackMs;
    this._titleQuietFallbackTimer = null;
    this._resumeNoteFallbackTimer = null;

    this._hookSeen = false;
    this._lastSignal = null;

    this._compaction = createCompactionTracking();
    this._pendingPromptKind = null;
    this._pendingPromptToolName = null;
    this._attention = createAttentionLanes();

    this._titleQuiet = false;
    this._hooksReportPrompts = false;
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
    this._pendingPromptSupervisionLine = null;
    this._pendingResumeNote = null;
    this._resumeNoteAwaitingTurn = null;
    this._hintedCommands = new Set();
    this._shownHintCommands = new Set();
    this._ranCommands = new Set();
    this._queuedCommandHints = [];
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._agentSetup = agentSetup;
    this._isCleanHome = isCleanHome === true;
    this._resumeSessionId = resumeSessionId || null;
    this.workspaceRepos = workspaceRepos ? [...workspaceRepos] : null;
    this._transcriptPath = null;
    this._lastClaudeSessionReport = null;
    this._suppressResumeCapture = false;
    this.ephemeral = !!ephemeral;
    this._spawnEnv = spawnEnv;
    this._prependPathDirs = prependPathDirs;
    this._hookTools = hookTools.filter((tool) => this._can(HOOK_TOOLS[tool.id].capability));
    this._isSaneYoloActive = false;
    this._planLimits = planLimits === true && this._can("planLimits");
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
      detectScheduledWakeups,
      observeToolCalls: observeToolCalls === true,
      enableProjectMcp: !!enableProjectMcp,
      hookTools: this._hookTools,
      planLimits: this._planLimits,
      getUserHooks,
      extraUserHooks,
      scratchAgentHome,
      isCleanHome,
      requiresHooks: requiresHooks && hookRouter !== null,
      bypassHookTrust: this.bypassHookTrust,
      effectiveCwd: () => this.effectiveCwd(),
      folderTrustRoot: () => folderTrustRoot(this.effectiveCwd(), worktreeRoot),
      agentEnv: () => this._launch.buildEnv(),
      ingestSignal: (raw) => this.ingestHookSignal(raw),
      observeHook: (event, payload) => {
        this._approvals.releaseAfterHookEvent(event, payload);
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
      assertLaunchable(file);
      return pty.spawn(file, args, opts);
    });
    this._getRemoteLaunch = getRemoteLaunch ?? (() => null);
    this._launch = createSessionLaunch({
      id: this.id,
      adapter: this._adapter,
      platform,
      startCodexBridge,
      getRemoteLaunch: this._getRemoteLaunch,
      hooks: this._hooks,
      port: {
        name: () => this.name,
        promptSupervisionLine: () => this._canRunHelpCommand ? supervisionLine({ canSpawn: !this.ephemeral }) : null,
        effectiveCwd: () => this.effectiveCwd(),
        spawnEnv: () => this._spawnEnv,
        spawnCommand: () => this._spawnCommand,
        agentToken: () => this._agentToken,
        commitSigningToken: () => this._commitSigningToken,
        commitSigningProgram: () => this._commitSigningProgram,
        isDestroyed: () => this._destroyed,
        abandonSpawn: (cause) => this._abandonSpawn(cause),
        emit: (event, detail) => this.emit(event, detail),
        forceRestart: (options) => this.forceRestart(options),
      },
    });

    this._reaper = createSessionProcessReaper({
      platform,
      killProc: killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb)),
      signalProc: signalProc || ((pid, signal) => process.kill(pid, signal)),
      port: {
        isDestroyed: () => this._destroyed,
        emitError: (err) => this._emitError(err),
      },
    });
    this._platform = platform;
    this._probeGraphicalSession = probeGraphicalSession;

    this._startPending = null;
    this._resizeSeq = 0;
    this.worktreeLifecycle = createSessionWorktreeLifecycle({
      id: this.id,
      projectPath: this.path,
      integrationBranch,
      startSha,
      gitWorkspace,
      autoRebase,
      syncOnStart,
      liveWorktreeReview,
      worktreeRoot,
      worktreeShare,
      workspaceRepos,
      seedDependencies,
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
        holdWorktreeReaders: () => holdAllWorktreeReaders(this._worktreeReaderHolds),
      },
    });

    this._getTerminalColors = getTerminalColors ?? (() => DEFAULT_TERMINAL_COLORS);

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
      const oscTitle = extractOscTaskTitle(title, this._titleProjectName(), taskTitleVocabulary);
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

  get agentSetup(): AgentSetup | null {
    return this._agentSetup;
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

  _maskedTaskTitleSources(sources: TaskTitleSources): TaskTitleSources {
    const maskedSources: TaskTitleSources = {};
    for (const [source, title] of Object.entries(sources)) {
      maskedSources[source as keyof TaskTitleSources] = title ? maskSecrets(title, this._deliveredSecretValues) : title;
    }
    return maskedSources;
  }

  _updateTaskTitle(): void {
    this._taskTitleSources = this._maskedTaskTitleSources(this._taskTitleSources);
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
    recorder?.maskDeliveredValues?.(this._deliveredSecretValues);
  }

  deliveredSecretValues(): readonly string[] {
    return this._deliveredSecretValues;
  }

  maskDeliveredSecretValues(values: readonly string[]): void {
    this._deliveredSecretValues = values;
    this._recorder?.maskDeliveredValues?.(values);
    this._updateTaskTitle();
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

  _isSubagentTurnStop(raw: HookSignal): boolean {
    if (raw?.signal !== "ready" || String(raw.event || "").toLowerCase() !== "stop") return false;
    return this._can("subagentTurnStops") && this.backgroundTracking.activeAgentCount() > 0;
  }

  ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    if (this._approvals.parksQuestionStatus(raw)) return;
    this._ingestHookSignal(raw);
  }

  _ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    if (raw?.signal === "auth-failed") {
      if (this._launch.respawnAfterAuthFailure()) return;
      this.ingestHookSignal({ ...raw, signal: "awaiting-input" });
      return;
    }
    if (this._isConversationReplacedAtStartup(raw)) {
      this.ingestHookSignal({ ...raw, payload: { ...raw.payload, source: "clear" } });
      return;
    }
    if (raw?.signal === "ready" && String(raw.event || "").toLowerCase() === "stop") this._launch.noteTurnStopped();
    this._hookSeen = true;
    if (this._recorder && raw?.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }

    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this.backgroundTracking.trackSubagent(raw);
      return;
    }

    if (raw && (raw.signal === "task-created" || raw.signal === "task-completed" || raw.signal === "teammate-idle" || raw.signal === "background-task-launched")) {
      this.backgroundTracking.trackTaskLifecycle(raw);
      return;
    }

    if (raw && (raw.signal === "wakeup-scheduled" || raw.signal === "cron-created" || raw.signal === "cron-deleted")) {
      this.backgroundTracking.trackWakeup(raw);
      return;
    }

    if (this._isSubagentTurnStop(raw)) {
      this._recordDecision({ ts: Date.now(), kind: "signal", signal: raw.signal, source: raw.source, state: this.state, active: this.backgroundTracking.activeAgentCount(), action: "subagent-stop-dropped" });
      return;
    }

    if (raw?.payload) {
      this._captureClaudeSessionId(
        this._reportedSessionIdOf(raw.payload), raw.payload.source, raw.payload.transcript_path, raw.signal, raw.confidence);
      const hookTitle = extractHookTaskTitle(raw.payload, path.basename(this.effectiveCwd()), this._adapter.titleProfile.taskTitle);
      if (hookTitle && hookTitle !== this._taskTitleSources.aiTitle) {
        this._taskTitleSources.aiTitle = hookTitle;
        this._updateTaskTitle();
      }
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
      this._dropResumeNote();
      const prompt = raw.payload?.prompt;
      this._queuePromptHint(prompt);
      if (!this._taskTitleSources.promptTitle) {
        this._taskTitleSources.promptTitle = extractPromptTaskTitle(typeof prompt === "string" ? maskSecrets(prompt, this._deliveredSecretValues) : prompt);
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
      this._hasPromptSinceSpawn = true;
      this._observeCompaction("resume");
      this._titleQuiet = false;
      this._setPendingPromptKind(null);

      this.backgroundTracking.noteTaskNotificationsDelivered(raw.payload?.prompt);
      this.backgroundTracking.clearGateHeldReady();
      this.backgroundTracking.resetTurnEvidence();
      this.backgroundTracking.clearBgDeclared();

      const isSelfWake = isSelfWakePrompt(raw.payload?.prompt);
      if (!isSelfWake) this._dispatchAttention({ type: "operator_prompt" });
      this.emit("user-prompt", { state: this.state, stateSince: this.stateSince, ts: Date.now(), isSelfWake });
    }

    if (raw && raw.signal === "ready" && raw.source === "hook") {
      this.backgroundTracking.applyBackgroundTasks(raw.payload);
    }
    this._statusSource.ingest(raw);
  }

  _reportedSessionIdOf(payload: HookPayload): unknown {
    return typeof this._adapter.sessionIdOf === "function" ? this._adapter.sessionIdOf(payload) : payload?.session_id;
  }

  _isConversationReplacedAtStartup(raw: HookSignal): boolean {
    if (raw?.signal !== "session-start" || !raw.payload) return false;
    const reportedId = this._reportedSessionIdOf(raw.payload);
    if (typeof reportedId !== "string") return false;
    return isConversationReplacedAtStartup({ hasPromptSinceSpawn: this._hasPromptSinceSpawn, currentResumeSessionId: this._resumeSessionId, reportedId, sessionStartSource: raw.payload.source });
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
    this._forgetCommandHints();
    this._armPromptSupervisionLine();
  }

  _forgetCommandHints(): void {
    this._hintedCommands.clear();
    this._shownHintCommands.clear();
    this._ranCommands.clear();
    this._queuedCommandHints = [];
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

  _emitSessionDetail(): void {
    this.emit("prompt-kind-change", {
      pendingPromptKind: this._pendingPromptKind,
      isCompacting: this._compaction.isCompacting,
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
    if (isCompactionEndingSignal(this._compaction, s.signal, s.source, this._hooksReportPrompts)) {
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

  get _killPollTimer(): NodeJS.Timeout | null {
    return this._reaper.killPollTimer;
  }

  get _killReapTimer(): NodeJS.Timeout | null {
    return this._reaper.killReapTimer;
  }

  get _killReap(): Promise<void> | null {
    return this._reaper.killReap;
  }

  set _killReap(reap: Promise<void> | null) {
    this._reaper.killReap = reap;
  }

  _awaitPendingReaps(): Promise<void> | null {
    return this._reaper.awaitPendingReaps();
  }

  get _conversationApproval(): ConversationApproval | null {
    return this._approvals.conversationApproval;
  }

  holdClaudePermission(payload: unknown, abandoned: AbortSignal): Promise<ClaudeHookReply | null> | null {
    return this._approvals.hold(payload, abandoned);
  }

  holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null {
    return this._approvals.holdQuestionTool(payload, abandoned);
  }

  answerConversationApproval(requestId: number | string, answers: ConversationAnswers): boolean {
    return this._approvals.answer(requestId, answers);
  }

  releaseQuestionHold(requestId: string): boolean {
    return this._approvals.release(requestId);
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

  get commitSigningToken(): string | null {
    return this._commitSigningToken;
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

  raiseAttention(origin: AttentionOrigin, note: string): AgentAttentionReply {
    if (this._destroyed) return { ok: true, pending: false };
    const effect = this._dispatchAttention({ type: "raise", origin, note, at: Date.now(), state: this.state });
    if (effect.refusal !== null) return { ok: false, error: effect.refusal };
    return { ok: true, pending: effect.isHeld };
  }

  get attentionNotes(): AttentionNote[] {
    return attentionNotesOf(this._attention);
  }

  _dispatchAttention(event: AttentionEvent): ReturnType<typeof reduceAttention>["effect"] {
    const { lanes, effect } = reduceAttention(this._attention, event);
    this._attention = lanes;
    const ts = Date.now();
    for (const record of effect.records) {
      this._recordDecision({ ts, kind: "attention", origin: record.origin, disposition: record.disposition, state: this.state, note: record.note });
    }
    if (effect.hasNotesChanged) this.emit("attention-notes", { notes: this.attentionNotes });
    if (effect.askingNote !== null) this._askOperator(effect.askingNote, ts);
    return effect;
  }

  _askOperator(note: string, ts: number): void {
    this._setPendingPromptKind("agent");
    this.emit("agent-attention", { note, ts });
    this._statusSource.ingest({
      signal: "awaiting-input",
      source: "agent",
      confidence: "high",
      ts,
    });
  }

  get hasLivePty(): boolean {
    return !this._destroyed && !!this.ptyProcess && !!this._ptyAlive;
  }

  get _destroyed(): boolean {
    return this._teardown.kind === "destroyed";
  }

  get pendingRestart(): boolean {
    return this._teardown.kind === "restart-pending";
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

  get isQuestionManagerOn(): boolean | null {
    return this._questionManager?.isOn ?? null;
  }

  _prepareRestart(options: { fresh?: boolean; conversationId?: string | null } = {}): void {
    if (options.fresh !== true) {
      this._bindRestartConversation(options.conversationId);
      return;
    }

    this._suppressResumeCapture = true;
    this.setResumeConversation(null);
    this._transcriptPath = null;
    this._resetAutomaticTaskTitle();
    this._forgetCommandHints();
    this.emit("resume-cleared", { id: this.id });
  }

  _bindRestartConversation(conversationId: string | null | undefined): void {
    if (!conversationId) return;
    this._suppressResumeCapture = true;
    this.setResumeConversation(conversationId);
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

  _provisionWorktree({ fresh = false }: { fresh?: boolean } = {}) { return this.worktreeLifecycle.provision({ fresh }); }

  _settleWorktreeOnExit() { return this.worktreeLifecycle.settleOnExit(); }

  discardWorktreeIfClean() { return this.worktreeLifecycle.discardIfClean(); }

  onBeforeWorktreeDiscard(hold: () => Promise<() => void>): void { this._worktreeReaderHolds.add(hold); }

  releaseDroppedWorkspaceMembers(keepRepoPaths: string[]) { return this.worktreeLifecycle.releaseDroppedWorkspaceMembers(keepRepoPaths); }

  pasteMergePrompt() { return this.worktreeLifecycle.pasteMergePrompt(); }

  pasteText(text: string) { return this._output.pasteText(text); }

  pasteTextWhenReady(text: string, { timeoutMs = 120000, submit = false }: { timeoutMs?: number; submit?: boolean } = {}) {
    const pastableText = text.replaceAll(PASTE_BREAKING_CONTROL_BYTES, "");
    return this._output.pasteTextWhenReady(pastableText, { timeoutMs, settleMs: PTY_PROMPT_SETTLE_MS, submitDelayMs: submit ? PTY_PROMPT_SUBMIT_DELAY_MS : null });
  }

  hasPendingPaste(): boolean { return this._output.hasPendingPaste(); }

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
  releaseCheckouts() { return this.worktreeLifecycle.releaseCheckouts(); }
  findWorkspaceKeptWork() { return this.worktreeLifecycle.findWorkspaceKeptWork(); }
  addCheckout(checkout: { repoPath: string; checkoutRoot: string }) { return this.worktreeLifecycle.addCheckout(checkout); }
  hasWorkspaceMembers(): Promise<boolean> { return this.worktreeLifecycle.hasWorkspaceMembers(); }
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
      pendingRestart: this.pendingRestart,
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
      resumeSessionId: this._resumeSessionId,
      activeAgents: active,
      awaitingBackgroundTasks: this.backgroundTracking.awaitingBackgroundTasks(),
      pendingPromptKind: this._pendingPromptKind,
      attentionNotes: this.attentionNotes,
      mergeStatus: this.mergeStatus,
      mergeReason: this.mergeReason,
      worktreeNotice: this.worktreeNotice,
      failureReason: this.failureReason,
      unseenOutcome: this.unseenOutcome,
      managerSeenSeq: this.managerSeenSeq,
      isQuestionManagerOn: this.isQuestionManagerOn,
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

    this._dispatchAttention({ type: "state", state: to, leftWaiting: from === STATES.WAITING });

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

    if (this.ptyProcess) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      const oldPid = this.ptyProcess.pid;

      this._reaper.killReap = this._reaper.reapTreeOnce(oldPid);
      this.ptyProcess = null;
    }

    const pendingReaps = this._reaper.awaitPendingReaps();
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
      this.coherenceAttachment = await this._prepareCoherence(this.effectiveCwd());
      this.coherenceHooks = this.coherenceAttachment?.hooks ?? null;
      if (isStartSuperseded()) return;
      this.emit('coherence-hooks-change', this.coherenceHooks);
    }

    if (this.worktreeDir) {
      this.worktreeLifecycle.startWatching();

      if (this.mergeStatus === "pending-review") this.worktreeLifecycle.scheduleCheck();
    }
    this._receivedFirstOutput = false;
    this._hasPromptSinceSpawn = false;

    this._clearDetectionTracking();
    this._output.reset();

    this.emit("rebaseline");
    this._resetDetectionSources({ quiet: false });

    const remoteLaunch = this._getRemoteLaunch();
    if (remoteLaunch !== null && this.agentId !== DEFAULT_AGENT_ID && this.agentId !== "codex") {
      this._abandonSpawn(new Error("A Coder workspace session runs Claude Code or Codex only"));
      return;
    }
    const isRemoteCodex = remoteLaunch !== null && this.agentId === "codex";
    await this._hooks.prepare();
    if (remoteLaunch === null && this._adapter.trustFolder) {
      await this._adapter.trustFolder(this.effectiveCwd(), this._launch.buildEnv({ prependPathDirs: this._prependPathDirs, extraEnv: this._spawnEnv }))
        .catch((error: unknown) => console.warn(`[session:${this.name}] ${errorMessage(error)}`));
    }
    if (isStartSuperseded()) return;
    const hookInjection = this._hooks.inject();
    if (hookInjection.refusal) {
      this._abandonSpawn(new Error(hookInjection.refusal));
      return;
    }
    this._isSaneYoloActive = remoteLaunch === null && hookInjection.isSaneYoloActive;
    const mcpLaunch = remoteLaunch === null
      ? mcpLaunchFor({ agentId: this.agentId, listenerPort: this._hooks.listenerPort(), sessionId: this.id, agentToken: this._agentToken })
      : { args: [], env: {} };
    const settingsArgs = [...hookInjection.args, ...mcpLaunch.args];

    this._hooksReportPrompts = this._hooks.hasInjection() && !isRemoteCodex;
    this._titleQuiet = this._adapter.titleProfile.quietUntilFirstPrompt === true && this._hooksReportPrompts;
    this._armTitleQuietFallback();

    this._applyTitleContext();
    const injectedEnv = { ...hookInjection.env, ...this._launch.agentApiEnv(), ...mcpLaunch.env, ...this._launch.commitSigningEnv() };
    const spawnExtraEnv = Object.keys(injectedEnv).length > 0
      ? { ...(this._spawnEnv || {}), ...injectedEnv }
      : this._spawnEnv;

    const env = this._launch.buildEnv({
      prependPathDirs: this._prependPathDirs,
      extraEnv: spawnExtraEnv,
    });
    if (await this._shouldDetachDesktopBus()) env.DBUS_SESSION_BUS_ADDRESS = DETACHED_DESKTOP_BUS_ADDRESS;

    const configuredResumeSessionId = this._can("resume") ? this._resumeSessionId : null;
    let spawnResumeSessionId = configuredResumeSessionId;
    if (this.usageVendor === "claude") {
      const resumeTarget = resolveResumeTarget({
        resumeSessionId: configuredResumeSessionId,
        transcriptPath: this._transcriptPath,
        projectsDirs: projectDirCandidates(env, [], os.homedir()),
        cwds: this._launch.spawnCwdSpellings(),
        isTranscriptRemote: remoteLaunch !== null,
      }, { existsSync: fs.existsSync, readdirSync: fs.readdirSync });
      spawnResumeSessionId = resumeTarget.resumeSessionId;
      if (configuredResumeSessionId && !spawnResumeSessionId) {
        console.warn(`[session:${this.name}] spawning without the stale resume id ${configuredResumeSessionId} because no transcript exists at any of: ${resumeTarget.checkedTranscriptPaths.join(", ")}`);
      }
    }

    this._suppressResumeCapture = false;
    const isResumeNoteLaunch = Boolean(spawnResumeSessionId && resumePrompt);
    const isResumeNoteByHook = isResumeNoteLaunch && this._can("resumeNoteByHook") && this._hooks.hasInjection();
    this._pendingResumeNote = isResumeNoteByHook ? resumePrompt : null;
    this._resumeNoteAwaitingTurn = this._pendingResumeNote;
    const launchPrompt = isResumeNoteLaunch ? (isResumeNoteByHook ? null : resumePrompt) : this._initialPrompt;
    const agentArgs = this._adapter.buildArgs({
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      resumeSessionId: spawnResumeSessionId,
      extraArgs: [...this._extraClaudeArgs, ...launchArgs(this._adapter.id, this._agentSetup), ...cleanHomeArgs(this._adapter.id, this._isCleanHome)],
      initialPrompt: launchPrompt,
    });

    const bridgedLaunch = isRemoteCodex && remoteLaunch !== null
      ? await this._launch.startRemoteCodexBridge(remoteLaunch, agentArgs, env)
      : null;
    if (isRemoteCodex && !bridgedLaunch) return;
    if (isStartSuperseded()) {
      this._hooks.cleanup();
      await this._launch.stopCodexBridge();
      return;
    }
    const spawnCommand = await this._launch.spawnCommandFor({ remoteLaunch, isRemoteCodex, settingsArgs, agentArgs, bridgedLaunch });
    if (!spawnCommand) {
      await this._launch.stopCodexBridge();
      return;
    }
    if (isStartSuperseded()) {
      this._hooks.cleanup();
      await this._launch.stopCodexBridge();
      return;
    }
    if (bridgedLaunch) env[CODEX_REMOTE_TOKEN_ENV] = bridgedLaunch.token;
    const { file, args } = spawnCommand;

    const ptySize = this._output.ptySize();
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
        this._handleSpawnedPtyExit(exitCode, signal),
      );
      this._isSaneYoloActive = false;
      this._hooks.cleanup();
      this.transition("spawn_fail", { reason: "spawn_cwd_missing" });
      this.kill();
      return;
    }

    const initialPrompt = this._initialPrompt;
    const argsForLog = initialPrompt
      ? args.map((a) => a.replace(initialPrompt, `<prompt:${initialPrompt.length}c>`)).join(" ")
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
      this._handleSpawnedPtyExit(exitCode, signal),
    );
    this._deliverPtyInitialPrompt(launchPrompt);
    this._armResumeNoteFallback();
    this._armPromptSupervisionLine();
  }

  _armResumeNoteFallback(): void {
    this._clearTimer("_resumeNoteFallbackTimer");
    if (this._resumeNoteAwaitingTurn === null) return;
    this._armTimer("_resumeNoteFallbackTimer", this._titleQuietFallbackMs, () => {
      const resumeNote = this._resumeNoteAwaitingTurn;
      if (this._destroyed || !this._ptyAlive || resumeNote === null) return;
      this._dropResumeNote();
      console.warn(`[session:${this.name}] no turn started from the resume note within ${Math.round(this._titleQuietFallbackMs / 1000)}s - pasting it into the terminal`);
      this.pasteTextWhenReady(resumeNote, { submit: true });
    }, { unref: true });
  }

  _armPromptSupervisionLine(): void {
    this._pendingPromptSupervisionLine = this._canRunHelpCommand ? supervisionLine({ canSpawn: !this.ephemeral }) : null;
  }

  promptContextReply(): PromptContextReply | null {
    return this._adapter.promptContextReply ?? null;
  }

  noteCommandRan(command: string): void {
    const followedHint = this._ranCommands.has(command) ? undefined : [...this._shownHintCommands].find((shown) => shown === command);
    this._ranCommands.add(command);
    if (followedHint !== undefined) this._noteCommandHint(followedHint, "followed");
  }

  _noteCommandHint(command: HintedCommand, outcome: "shown" | "followed"): void {
    if (outcome === "shown") this._shownHintCommands.add(command);
    this.emit("command-hint", { command, outcome });
  }

  takeCommandHint(event: string, payload: Record<string, unknown>, answers: (command: HintedCommand) => boolean): CommandHint | null {
    const facts = toolHookFactsOf(event, payload);
    if (facts === null) return null;
    const hint = hintFor(facts, { answers, hintedCommands: this._hintedCommands, ranCommands: this._ranCommands });
    if (hint === null) return null;
    this._hintedCommands.add(hint.command);
    if (!this._can("toolHookContext")) {
      this._queuedCommandHints.push(hint);
      return null;
    }
    this._noteCommandHint(hint.command, "shown");
    return hint;
  }

  _queuePromptHint(prompt: unknown): void {
    const hint = promptHintFor(prompt, { hintedCommands: this._hintedCommands, ranCommands: this._ranCommands });
    if (hint === null) return;
    this._hintedCommands.add(hint.command);
    this._queuedCommandHints.push(hint);
  }

  _dropResumeNote(): void {
    this._pendingResumeNote = null;
    this._resumeNoteAwaitingTurn = null;
    this._clearTimer("_resumeNoteFallbackTimer");
  }

  pendingResumeNote(): string | null {
    return this._resumeNoteAwaitingTurn;
  }

  takeResumeNote(): string | null {
    const resumeNote = this._pendingResumeNote;
    this._pendingResumeNote = null;
    return resumeNote;
  }

  takePromptNotes(keepsHint: (command: HintedCommand) => boolean): string[] {
    const queuedHints = this._queuedCommandHints.filter((hint) => keepsHint(hint.command));
    const notes = [this._pendingPromptSupervisionLine, ...queuedHints.map((hint) => hint.text)].filter((note) => note !== null);
    this._pendingPromptSupervisionLine = null;
    this._queuedCommandHints = [];
    for (const hint of queuedHints) this._noteCommandHint(hint.command, "shown");
    return notes;
  }

  _deliverPtyInitialPrompt(prompt: string | null): void {
    if (!prompt || !this._can("ptyInitialPrompt")) return;
    const pastablePrompt = prompt.replaceAll(PASTE_BREAKING_CONTROL_BYTES, "");
    this._output.pasteTextWhenReady(pastablePrompt, { settleMs: PTY_PROMPT_SETTLE_MS, submitDelayMs: PTY_PROMPT_SUBMIT_DELAY_MS });
  }

  async _shouldDetachDesktopBus(): Promise<boolean> {
    if (this._platform !== "linux") return false;
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
    return await this._probeGraphicalSession() === "inactive";
  }

  _abandonSpawn(cause: unknown): void {
    this._isSaneYoloActive = false;
    this._hooks.cleanup();
    void this._launch.stopCodexBridge();
    this._approvals.releaseAll();
    this.transition("spawn_fail", { error: errorMessage(cause) });
    this.emit("error", cause);
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

  _titleProjectName(): string {
    const cwdBasename = path.basename(this.effectiveCwd());
    return this._adapter.titleProfile.projectTitleOf?.(cwdBasename) ?? cwdBasename;
  }

  _applyTitleContext(): void {
    this._titleSource.setContext({ cwdBasename: this._titleProjectName() });
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

    this._answerColorQueries(data);

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

  _handleSpawnedPtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    void this._launch.stopCodexBridge();
    this._approvals.releaseAll();
    return this._handlePtyExit(exitCode, signal);
  }

  async _handlePtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    const pid = this.ptyProcess ? this.ptyProcess.pid : null;
    this._resetDetectionSources({ quiet: false, clearTracking: true });
    this._dispatchAttention({ type: "teardown" });

    this._hooks.cleanup();
    this._ptyAlive = false;
    this.ptyProcess = null;
    this._dropResumeNote();

    if (pid) {
      this._reaper.exitReap = this._reaper.reapTreeOnce(pid);
    }

    const { event, detail } = decideExitTransition(this.state, exitCode, signal, this._receivedFirstOutput);
    const reason = detail.reason || null;
    const pendingRemoteExitReason = this._isExitHeadedForFailure(event) ? this._getRemoteLaunch()?.describeExit().catch(() => null) : undefined;
    if (pendingRemoteExitReason) {
      const remoteExitReason = await pendingRemoteExitReason;
      if (remoteExitReason && this._isExitHeadedForFailure(event)) this.failureReason = remoteExitReason;
    }
    const didTransition = this.transition(event, detail);
    const isUnsignalledCleanExit = didTransition && event === "process_exit_ok" && !signal;

    if (this._recorder) {
      this._recorder.writeFooter("pty_exit", exitCode);
      this._recorder.finishRecordingFile();
    }

    try { await this._settleWorktreeOnExit(); }
    catch {}

    const exitedOnItsOwn = isUnsignalledCleanExit && this.state === STATES.DONE && !this._teardownPending() && !this._destroyed;
    this.emit("exit", { exitCode, signal, reason, exitedOnItsOwn });
    this._dispatchTeardown({ kind: "pty_exited" });
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

  _answerColorQueries(data: string): void {
    const scan = scanTerminalColorQueries(this._pendingColorQuery, data, this._getTerminalColors());
    this._pendingColorQuery = scan.pending;
    for (const reply of scan.replies) this.write(reply);
  }

  write(text: string): void {
    if (this._recorder) {
      this._recorder.writeInput(text);
    }

    if (!this.ptyProcess || !this._ptyAlive) return;
    this.ptyProcess.write(text);
    if (!isPromptSubmit(text)) return;
    if (isComposerSubmit(text, this.state)) this._output.forgetUnsubmittedComposerPaste();
    this._observeCompaction("resume");
    this._titleQuiet = false;
  }

  noteOperatorDraft(): void {
    this._approvals.yieldManagerDecisions();
    this.emit("operator-input");
  }

  noteOperatorInput(input: string): void {
    if (isOperatorKeystroke(input)) {
      this._approvals.yieldManagerDecisions();
      this.emit("operator-input");
    }
    const decision = decideWaitingInput({
      state: this.state,
      hasHookAwaitingInput: this._can("hooks") && this._can("awaitingInput"),
      pendingPromptKind: this._pendingPromptKind,
      isQuestionPrompt: this._pendingPromptToolName === ASK_USER_QUESTION_TOOL_NAME,
      input,
    });
    if (decision === "end-waiting") this.transition("user_input");
    if (input === LONE_ESCAPE) this._titleSource.rearmIdleReading();
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
    }
    this._resizeSeq += 1;
    this.emit("resize", { cols, rows, seq: this._resizeSeq });
  }

  _emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  kill(): void {
    if (!this.ptyProcess) return;

    this._ptyAlive = false;
    this._dropResumeNote();
    this._reaper.kill(this.ptyProcess.pid);
  }

  dismiss(): boolean {
    const hadUnseenOutcome = this.unseenOutcome !== null;
    const hadAttentionNotes = this.attentionNotes.length > 0;
    this._setUnseenOutcome(null);
    this._dispatchAttention({ type: "dismiss" });
    if (!DISMISSIBLE_STATES.has(this.state)) return hadUnseenOutcome || hadAttentionNotes;
    return this.transition("user_dismiss");
  }

  markManagerDecisionsSeen(throughSeq: number): void {
    const seenSeq = Math.min(throughSeq, this._approvals.latestManagerDecisionSeq);
    if (seenSeq <= this.managerSeenSeq) return;
    this.managerSeenSeq = seenSeq;
    this.emit("manager-seen-change", { managerSeenSeq: seenSeq });
  }

  setQuestionManagerOn(isOn: boolean): void {
    if (!this._questionManager || this._questionManager.isOn === isOn) return;
    this._questionManager.setOn(isOn);
    this.emit("question-manager-change", { isQuestionManagerOn: isOn });
  }

  _setUnseenOutcome(nextUnseenOutcome: UnseenOutcome | null): void {
    if (this.unseenOutcome === nextUnseenOutcome) return;
    this.unseenOutcome = nextUnseenOutcome;
    this.emit("unseen-outcome-change", { unseenOutcome: nextUnseenOutcome });
  }

  _teardownPending(): boolean {
    return this._teardown.kind === "restart-pending" || this._teardown.kind === "finish-pending";
  }

  _dispatchTeardown(event: Parameters<typeof decideTeardown>[1]): boolean {
    const decision = decideTeardown(this._teardown, event);
    if (!decision) return false;
    this._teardown = decision.teardown;
    for (const action of decision.actions) this._runTeardownAction(action);
    return true;
  }

  _runTeardownAction(action: TeardownAction): void {
    if (action.kind === "merge-and-reset") {
      void this._mergeAndReset().catch(() => {}).finally(() => this._dispatchTeardown({ kind: "merge_settled" }));
      return;
    }
    if (!RESTARTABLE_STATES.includes(this.state)) return;
    this.transition("user_restart");
    this.start({ fresh: action.fresh, resumePrompt: action.resumePrompt });
  }

  killSession(): boolean {
    if (!KILLABLE_STATES.includes(this.state)) return false;
    this.kill();
    return this.transition("user_kill");
  }

  restart(options: { fresh?: boolean; conversationId?: string | null } = {}): boolean {
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
      this._dispatchTeardown({ kind: "finish_requested", isProcessLive: false });
      return { ok: true };
    }
    if (this.state === STATES.COMPLETE || this.state === STATES.IDLE) {
      this._dispatchTeardown({ kind: "finish_requested", isProcessLive: true });
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

  forceRestart(options: { fresh?: boolean; conversationId?: string | null; resumePrompt?: string | null } = {}): boolean {
    if (this._destroyed) return false;
    if (this._teardownPending()) return false;
    if (KILLABLE_STATES.includes(this.state)) {
      this._prepareRestart(options);
      this._dispatchTeardown({ kind: "restart_requested", fresh: options.fresh === true, resumePrompt: options.resumePrompt ?? null });
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

  destroy(cause: SessionEndCause = "removed"): void {
    if (!this._dispatchTeardown({ kind: "destroy_requested" })) return;
    this._agentToken = null;
    this._commitSigningToken = null;
    this._dispatchAttention({ type: "teardown" });

    this._clearPendingPaste();

    this._hooks.cleanup();
    void this._launch.stopCodexBridge();
    this._approvals.releaseAll();

    this.kill();

    this._reaper.clearKillPoll();
    this._clearTimer("_titleQuietFallbackTimer");
    this._clearTimer("_resumeNoteFallbackTimer");

    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearWakeups();

    if (this._recorder) {
      this._recorder.close();
    }
    this.worktreeLifecycle.stopWatching();
    this._output.disposeScreenKeeper();
    this._titleSource.destroy();
    this._statusSource.destroy();
    this.emit("teardown", { id: this.id, cause });
    this.removeAllListeners();
  }
}

function claudeCommand(): ResolvedCommand {
  return commandFor(DEFAULT_AGENT_ID);
}

export { Session, claudeCommand };
export type { ClaudeSessionIdEvent, RemoteLaunch, SessionOptions };
