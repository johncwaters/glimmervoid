import type { GitIsolationOptions } from '../server/git/core/git-invocation-core.ts';
import { errorMessage } from "../shared/text.ts";
import { createCompactionTracking, observeCompaction, finishCompaction, isCompactionEndingSignal, suppressCompactionSignal, mapCompactionActivityEvent, isIdleCompactionActivity } from "./core/compaction-core.ts";
import { isCompactionRestoreEvent } from "../shared/compaction-restore-events.ts";
import type { CompactionTracking } from "./core/compaction-core.ts";
import { HOOK_TOOLS } from './core/hook-tools.ts';
import { DEFAULT_TERMINAL_COLORS } from "./core/terminal-color-query.ts";
import type { TerminalColors } from "./core/terminal-color-query.ts";
import type { InputReadyCondition } from "./core/input-ready-core.ts";
import type { ResolvedHookTool } from './core/hook-tools.ts';
import fs from "node:fs";
import { isSelfWakePrompt } from "./core/task-title-core.ts";
import type { PersistedTaskTitle } from "../shared/contracts/config.ts";
import type { ParentLink } from "../shared/contracts/session.ts";
import { ownerIdOf } from "../shared/parent-link.ts";
import type { SessionEndCause } from "../shared/contracts/telemetry.ts";
import type { LinkedPr, SessionPrLinks } from "../shared/contracts/my-prs.ts";
import type { PromptContextReply, QuestionToolDenyResponse } from "../shared/contracts/refocus.ts";
import { mergeSessionPrLink, seedSessionPrLinks, withManualPrLink, withoutPrLink, withoutReleasedPrLink } from "./core/session-pr-links-core.ts";
import type { TaskTitleRefinementResult, TaskTitleSources } from "./core/task-title-core.ts";
import { createSessionTaskTitle } from "./session-task-title.ts";
import type { SessionTaskTitleController } from "./session-task-title.ts";
import { createSessionPromptNotes } from "./session-prompt-notes.ts";
import type { SessionPromptNotes } from "./session-prompt-notes.ts";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "../server/child-process-safe.ts";
import { createPtyDriver } from "./drivers/pty-driver.ts";
import type { PtyDriver, PtySpawn, SessionPty } from "./drivers/pty-driver.ts";
import type { DriverEvent } from "./drivers/driver.ts";
import { probeGraphicalSession, resolveSessionScopeHost, stopSessionScope } from "./systemd-user.ts";
import { scopedLaunch, sessionScopeUnitName } from "./core/session-scope-core.ts";
import { randomBytes } from "node:crypto";
import { DETACHED_DESKTOP_BUS_ADDRESS } from "./core/spawn-env.ts";
import { readProcessTreeResidentBytes } from "./process-tree-memory.ts";
import type { SessionAccountHome } from "./core/agent-account-core.ts";
import type { GraphicalSessionState, SpawnEnv } from "./core/spawn-env.ts";
import { STATES, KILLABLE_STATES, RESTARTABLE_STATES, SIGN_IN_PROMPT_KIND, API_KEY_PROMPT_KIND, LOGIN_PROMPT_KINDS, RATE_LIMIT_PROMPT_KIND, CHECK_TERMINAL_PROMPT_KIND, SIGNED_IN_SIGNAL, LOGIN_COMMAND_BY_AGENT } from "../shared/states.ts";
import type { SessionState } from "../shared/states.ts";
import { unrefTimer } from "../shared/timer-deps.ts";
import { permitsHelpCommand } from "./core/session-routes.ts";
import type { CommandHint, HintedCommand } from "./core/session-routes.ts";
import { ASK_USER_QUESTION_TOOL_NAME, type AgentAttentionReply, type AttentionNote, type AttentionOrigin } from "../shared/contracts/session.ts";
import { PROPOSED_PLAN_TEXT_FIELD } from "../shared/contracts/plan-gate.ts";
import { CatalogAgentId } from "../shared/contracts/agent-models.ts";
import type { PlanDecision, PlanGate } from "../shared/contracts/plan-gate.ts";
import { attentionNotesOf, attentionOwnerOf, createAttentionLanes, reduceAttention } from "./core/session-attention-core.ts";
import type { AttentionEvent, AttentionLanes } from "./core/session-attention-core.ts";
import { generateToken } from "../detection/settings-injector.ts";
import { mcpLaunchFor } from "../mcp/core/agent-config.ts";
import type { PackMcpLaunch, PackMcpLaunchHold, PackMcpServer } from "../shared/contracts/pack.ts";
import { createOscTitleSource } from "../detection/osc-title-source.ts";
import { createStatusSource } from "../detection/status-source.ts";
import type { MetaStatusSignal, ResolvedStatusSignal } from "../detection/status-source.ts";
import type { HookSignal } from "../detection/hook-source.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import { DEFAULT_AGENT_ID, resolveAdapter, commandFor } from "./adapters/index.ts";
import type { AgentDoneLine, AttentionOwner, ChatApprovalMode, ChatOutboxEntry, ChatOutboxOrigin, ConversationAnswers, ConversationApproval, PermissionDecision, UnseenOutcome, UsageLimit } from "../shared/contracts/session.ts";
import type { ClaudeHookReply, PermissionHookReply } from "./core/claude-approval-core.ts";
import type { ElicitationHookReply } from "./core/claude-elicitation-core.ts";
import type { AgentAdapter, AgentCapabilities, ScratchAgentHome } from "./adapters/index.ts";

import {
  TRANSITIONS,
  GUARDS,
  ENTRY_HOOKS,
  EXIT_HOOKS,
  UNSEEN_OUTCOME_ON_ENTRY,
  nextStateClock,
} from "./core/state-machine.ts";
import { mapSignalToEvent } from "./core/status-mapper.ts";
import { decideWaitingInput, isComposerSubmit, isOperatorKeystroke, isPromptSubmit, isWaitingOnHookRaisedPrompt, LONE_ESCAPE } from "./core/waiting-input-core.ts";
import { decideExitTransition } from "./core/exit-transition.ts";
import { decideTeardown, NO_TEARDOWN } from "./core/session-teardown.ts";
import type { Teardown, TeardownAction } from "./core/session-teardown.ts";
import type { ExitSignal } from "./core/exit-transition.ts";
import * as agentTracker from "./core/agent-tracker.ts";
import type { ExpiredOpenWork } from "./core/agent-tracker.ts";
import { DEFAULT_GATE_RELEASE_SETTLE_MS } from "./core/gate-release.ts";
import { isConversationReplacedAtStartup, shouldAdoptReportedResumeId, RESUME_ID_RE } from "./core/auto-resume.ts";
import { projectSessionSnapshots } from "./core/snapshot-projection.ts";
import { promptWithDoneMeans } from "./core/done-means-prompt.ts";
import type { UserHook } from "./core/user-hooks-core.ts";
import type { DecisionEntry } from "./core/decision-log.ts";
import { createSessionObservability } from "./session-observability.ts";
import { createChatOutbox } from "./chat-outbox.ts";
import type { ChatOutbox } from "./chat-outbox.ts";
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
import type { LaunchSecretsOutcome, PrepareSandbox, ResolveLaunchSecrets, SandboxLaunchFacts, SessionLaunch } from "./session-launch.ts";
import { createSessionProcessReaper } from "./session-process-reaper.ts";
import type { KillProc, SessionProcessReaper, SignalProc } from "./session-process-reaper.ts";
import type { HookPayload } from "../shared/contracts/index.ts";
import { REBASELINE_EVENT, type RebaselineSignal, SUBAGENT_SIGNAL_EVENT, type SubagentSignal } from "../shared/contracts/trace.ts";
import { cleanHomeArgs, launchPlanFor } from "../shared/agent-models-core.ts";
import { claudePluginArgs } from "./core/pack-session-core.ts";
import type { PackAgentLaunch } from "./core/pack-session-core.ts";
import type { AgentSetup } from "../shared/contracts/agent-models.ts";
import { clock } from '../shared/clock.ts';
import { cleanPastedText } from './core/input-delivery-core.ts';
import type { DeliverOptions, DeliveryOutcome } from './core/input-delivery-core.ts';

const SPAWN_FAILURE_TEXT_BY_REASON: Record<string, string> = {
  spawn_cwd_missing: "The session folder no longer exists. Re-add the session on a folder that exists.",
};
const SPAWN_FAILURE_FALLBACK_TEXT = "The agent could not be started. The server log has the cause.";

function stopReasonOf(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null || !("error" in detail)) return null;
  return typeof detail.error === "string" && detail.error ? detail.error : null;
}

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
const BETWEEN_PROMPT_STATES: ReadonlySet<SessionState> = new Set([STATES.IDLE, STATES.COMPLETE]);
const STOP_BACKGROUND_WORK_TEXT = "Stop every background task and subagent you started, then end your turn.";
const TURN_REACHED_STATES: ReadonlySet<SessionState> = new Set([STATES.RUNNING, STATES.WAITING, STATES.COMPLETE]);

function startsTurn(from: SessionState, to: SessionState): boolean {
  return BETWEEN_PROMPT_STATES.has(from) && TURN_REACHED_STATES.has(to) && from !== to;
}

type StartupSignal = "output" | "ready";
type TimerField = "_titleQuietFallbackTimer" | "_inputReadyFallbackTimer";
type SnoozeRefusal = "in-progress" | "no-conversation" | "not-snoozable";
type SnoozeOutcome = { ok: true } | { ok: false; reason: SnoozeRefusal };

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
  readChatApprovals?: () => ChatApprovalMode;
  chatUploadsDirectory?: string | null;
  questionManager?: QuestionManagerPort | null;
  titleQuietFallbackMs?: number;
  spawnCommand?: ResolvedCommand | null;
  initialPrompt?: string | null;
  doneMeans?: readonly string[];
  agentDoneLines?: readonly AgentDoneLine[];
  extraClaudeArgs?: string[];
  agentSetup?: AgentSetup | null;
  ephemeral?: boolean;
  resumeSessionId?: string | null;
  settingsPermissions?: Record<string, unknown> | null;
  getPackAgentLaunch?: (() => PackAgentLaunch | null) | null;
  spawnEnv?: Record<string, string> | null;
  resolveAccountHome?: (() => SessionAccountHome) | null;
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
  packMcpServers?: ((agentId: string, cwd: string) => Promise<PackMcpLaunchHold>) | null;
  sharedPackMcpServers?: ((agentId: string) => PackMcpServer[]) | null;
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
  raceId?: string | null;
  attentionOwner?: AttentionOwner | null;
  parent?: ParentLink | null;
  isStudioMain?: boolean;
  commitSigningProgram?: string | null;
  resolveGitCredentialHelper?: ((cwd: string) => Promise<string | null>) | null;
  resolveHostSigningEnv?: ((cwd: string) => Promise<Record<string, string>>) | null;
  resolveLaunchSecrets?: ResolveLaunchSecrets | null;
  prepareSandbox?: PrepareSandbox | null;
  privateHomeKey?: string | null;
}

interface ClaudeSessionIdEvent {
  id: string;
  source: string | null;
  vendor: string;
  sessionId: string;
  transcriptPath: string | null;
  isResumeTarget: boolean;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

type HookActivity = "unseen" | "seen";
type PromptPhase = "awaiting-first-prompt" | "prompted";
type TitleGate = "open" | "quiet";
type HookPromptReporting = "none" | "hooks";
type ResumeCaptureMode = "active" | "suppressed";

class Session extends EventEmitter {
  _taskTitle: SessionTaskTitleController;
  _promptNotes: SessionPromptNotes;
  _lastOperatorInputAt: number;
  _prLinks: SessionPrLinks;
  id: string;
  name: string;
  path: string;
  dangerouslySkipPermissions: boolean;
  state: SessionState;
  stateSince: number;
  failureReason: string | null;
  _stopReason: string | null;
  unseenOutcome: UnseenOutcome | null;
  managerSeenSeq: number;
  passedQuestionSeq: number;
  ephemeral: boolean;
  agentId: string;
  usageVendor: string;
  bypassHookTrust: boolean;
  _launch: SessionLaunch;
  _approvals: SessionApprovalHolds<HookSignal>;
  backgroundTracking: ReturnType<typeof createSessionBackgroundTracking>;
  worktreeLifecycle: ReturnType<typeof createSessionWorktreeLifecycle>;
  _worktreeReaderHolds = new Set<() => Promise<() => void>>();

  _startupSignals: Set<StartupSignal>;
  _promptPhase: PromptPhase;
  _titleQuietFallbackTimer: NodeJS.Timeout | null;
  _inputReadyFallbackTimer: NodeJS.Timeout | null;
  _reaper: SessionProcessReaper;
  _teardown: Teardown;
  _recorder: SessionRecorderPort | null;
  _deliveredSecretValues: readonly string[] = [];
  _driver: PtyDriver;
  _chatOutbox: ChatOutbox;
  _adapter: AgentAdapter;
  _observability: ReturnType<typeof createSessionObservability>;
  _titleQuietFallbackMs: number;
  _hookActivity: HookActivity;
  _lastSignal: Record<string, unknown> | null;
  _compaction: CompactionTracking;
  _pendingPromptKind: string | null;
  _usageLimit: UsageLimit | null;
  _loginFailurePromptKind: string;
  _pendingPromptToolName: string | null;
  _attention: AttentionLanes;
  _titleGate: TitleGate;
  _hookPromptReporting: HookPromptReporting;
  _spawnCommand: ResolvedCommand | null;
  _initialPrompt: string | null;
  _firstTurnSince: number | null;
  _extraClaudeArgs: string[];
  _agentSetup: AgentSetup | null;
  _isCleanHome: boolean;
  _resumeSessionId: string | null;
  _restartStartsNewConversation = false;
  readonly workspaceRepos: string[] | null;
  _transcriptPath: string | null;
  _lastClaudeSessionReport: { id: string; transcriptPath: string | null; isResumeTarget: boolean } | null;
  _resumeCapture: ResumeCaptureMode;
  _spawnEnv: Record<string, string> | null;
  _prependPathDirs: string[];
  _hookTools: ResolvedHookTool[];
  _questionManager: QuestionManagerPort | null;
  _planLimits: boolean;
  _readChatApprovals: () => ChatApprovalMode;
  _chatUploadsDirectory: string | null;
  _packMcpServers: ((agentId: string, cwd: string) => Promise<PackMcpLaunchHold>) | null;
  _sharedPackMcpServers: ((agentId: string) => PackMcpServer[]) | null;
  _hooks: ReturnType<typeof createSessionHookLifecycle>;
  _agentDepth: number;
  readonly parent: ParentLink | null;
  readonly isStudioMain: boolean;
  readonly doneMeans: readonly string[];
  agentDoneLines: readonly AgentDoneLine[];
  readonly attentionOwner: AttentionOwner;
  _agentToken: string | null;
  _commitSigningProgram: string | null;
  _commitSigningToken: string | null;
  _gitCredentialToken: string | null;
  _canRunHelpCommand: boolean;
  _agentLiveChildren: number;
  _agentLifetimeSpawns: number;
  _agentSpawnsInFlight: number;
  _probeGraphicalSession: () => Promise<GraphicalSessionState>;
  _requiresWorktree: boolean;
  _platform: NodeJS.Platform;
  _startPending: Promise<void> | null;
  _startGeneration = 0;
  _titleSource: ReturnType<typeof createOscTitleSource>;
  _getTerminalColors: () => TerminalColors;
  _statusSource: ReturnType<typeof createStatusSource>;

  constructor({
    customTitle,
    id,
    name,
    path: projectPath,
    dangerouslySkipPermissions,
    replayBufferKB = 512,

    hookRouter = null,
    getHookPort = null,
    hooksBaseDir = undefined,
    titleStabilizationMs = 1500,
    statusConflictMs = undefined,
    statusDedupMs = undefined,

    detectBackgroundAgents,
    agentTtlMs = agentTracker.DEFAULT_AGENT_TTL_MS,

    shellTaskTtlMs = agentTracker.DEFAULT_SHELL_TASK_TTL_MS,

    teammateTaskTtlMs = agentTracker.DEFAULT_TEAMMATE_TASK_TTL_MS,

    gateReleaseSettleMs = DEFAULT_GATE_RELEASE_SETTLE_MS,

    detectScheduledWakeups,

    observeToolCalls,

    agent = DEFAULT_AGENT_ID,

    adapter = null,

    bypassHookTrust,
    holdsQuestionsForParent,
    readChatApprovals = () => "off",
    chatUploadsDirectory = null,
    questionManager = null,

    titleQuietFallbackMs = 30000,

    spawnCommand = null,

    initialPrompt = null,
    doneMeans = [],
    agentDoneLines = [],
    extraClaudeArgs = [],
    agentSetup = null,
    ephemeral,

    resumeSessionId = null,
    taskTitleState = undefined,
    prLinks = undefined,

    settingsPermissions = null,
    getPackAgentLaunch = null,

    spawnEnv = null,
    resolveAccountHome = null,
    prependPathDirs = [],

    enableProjectMcp,
    hookTools = [],


    planLimits,

    getUserHooks = null,
    getTerminalColors = null,
    extraUserHooks = [],
    scratchAgentHome = null,
    isCleanHome,
    requiresHooks,
    packMcpServers = null,
    sharedPackMcpServers = null,

    ptySpawn = null,
    requireWorktree,

    screenKeeperFactory = null,

    killProc = null,

    signalProc = null,

    platform = process.platform,

    gitWorkspace = null,
    integrationBranch = null,
    startSha = null,

    autoRebase,
    syncOnStart,

    liveWorktreeReview,

    worktreeRoot = null,
    worktreeShare = null,
    workspaceRepos = undefined,
    seedDependencies = null,

    agentDepth = 0,
    raceId = null,
    attentionOwner = null,
    parent = null,
    isStudioMain = false,
    commitSigningProgram = null,
    resolveGitCredentialHelper = null,
    resolveHostSigningEnv = null,
    resolveLaunchSecrets = null,
    prepareSandbox = null,
    privateHomeKey = null,
  }: SessionOptions) {
    super();
    const isEphemeral = ephemeral === true;
    const holdsQuestions = holdsQuestionsForParent === true;
    const hasScheduledWakeups = detectScheduledWakeups ?? true;
    const hasBackgroundAgentDetection = detectBackgroundAgents ?? true;
    this.id = id;
    this.parent = parent;
    this.isStudioMain = isStudioMain;
    this.doneMeans = doneMeans;
    this.agentDoneLines = agentDoneLines.map((line) => ({ ...line }));
    this.attentionOwner = attentionOwner ?? attentionOwnerOf(ownerIdOf(parent), raceId);
    this.name = name;
    const resolvedAdapter = adapter || resolveAdapter(agent, { label: `session:${name}` });
    if (!resolvedAdapter) throw new TypeError("default agent adapter is unavailable");
    this._adapter = resolvedAdapter;
    this.agentId = this._adapter.id;
    this._taskTitle = createSessionTaskTitle({
      customTitle: customTitle || null,
      persistedTitle: taskTitleState,
      resumeSessionId,
      initialPrompt,
      titleProfile: this._adapter.titleProfile,
      port: {
        isDestroyed: () => this._destroyed,
        transcriptPath: () => this._transcriptPath,
        deliveredSecretValues: () => this._deliveredSecretValues,
        emit: (event, ...args) => this.emit(event, ...args),
      },
    });
    this._promptNotes = createSessionPromptNotes({
      canUseToolHookContext: () => this._can("toolHookContext"),
      onCommandHint: (command, outcome) => this.emit("command-hint", { command, outcome }),
    });
    this._prLinks = seedSessionPrLinks(prLinks);
    this.path = projectPath;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions === true;
    this.state = STATES.DORMANT;
    this.stateSince = clock.nowMs();
    this.failureReason = null;
    this._stopReason = null;
    this.unseenOutcome = null;
    this.managerSeenSeq = 0;
    this.passedQuestionSeq = 0;
    this._startupSignals = new Set();
    this._promptPhase = "awaiting-first-prompt";
    this._teardown = NO_TEARDOWN;

    this._recorder = null;
    this._lastOperatorInputAt = Number.NEGATIVE_INFINITY;
    this._driver = createPtyDriver({
      sessionId: id,
      spawn: ptySpawn,
      platform: () => this._platform,
      inputReadyCondition: () => this._inputReadyCondition(),
      isInputReady: () => this._startupSignals.has("ready"),
      noteInputReady: () => this._noteInputReady(),
      noteOutput: (data) => this._noteOutput(data),
      feedTitle: (data) => this._feedTitle(data),
      terminalColors: () => this._getTerminalColors(),
      signalsWindowChange: () => this._launch.hasActiveSandbox,
      killTree: (pid) => this._reaper.kill(pid),
      onSocketFailure: () => this.kill(),
      maxBytes: replayBufferKB * 1024,
      getState: () => this.state,
      isBetweenTurns: () => this.isBetweenTurns(),
      isDestroyed: () => this._destroyed,
      lastOperatorInputAt: () => this._lastOperatorInputAt,
      write: (text) => this.write(text),
      start: () => { this.start(); },
      restart: () => { this.restart(); },
      on: (event, listener) => { this.on(event, listener); },
      off: (event, listener) => { this.off(event, listener); },
      screenKeeperFactory,
      onPasteExpired: (text) => { console.warn(`[session:${this.name}] dropped a queued paste of ${text.length} characters: the agent never became ready to take it (state ${this.state})`); },
    });
    this._driver.subscribe((event) => this._onDriverEvent(event));
    this._chatOutbox = createChatOutbox({
      canTakeMessage: () => this.hasLivePty && this.isBetweenTurns() && this._isAgentReadyForChat(),
      reportsTurnStarts: () => this._hooksReportPrompts,
      recordsPrompts: () => CatalogAgentId.safeParse(this.agentId).success,
      isDeliveryInFlight: () => this._output.isDeliveryInFlight(),
      deliver: (entry, onSettled) => this.deliverChatEntry(entry, onSettled),
      noteSubmitted: (entry) => {
        const pastedPrefix = this.chatAttachmentPrefixOf(entry);
        if (pastedPrefix !== null) this.emit("chat-attachments-sent", { files: entry.attachments, pastedPrefix, ts: clock.nowMs() });
      },
      noteTaken: (entry, submittedAtMs) => {
        if (entry.origin === "board-answer") this.emit("chat-board-answer-sent", { ts: submittedAtMs });
      },
      nowMs: () => clock.nowMs(),
      noteNotTaken: () => this.enterCheckTerminal(),
      emitChange: (chatOutbox) => this.emit("chat-outbox-change", { chatOutbox }),
    });
    this._output.onDeliveryIdle(() => this._chatOutbox.drain());
    this.on("state-change", ({ from, to }: { from: SessionState; to: SessionState }) => {
      if (startsTurn(from, to)) this._chatOutbox.noteTurnStarted();
      this._chatOutbox.drain();
    });

    this._observability = createSessionObservability({
      agentId: this.agentId,
      getRecorder: () => this._recorder,
    });

    this.usageVendor = this._adapter.usageVendor || "claude";
    this.bypassHookTrust = bypassHookTrust === true;
    const supportsChatApprovals = this._adapter.capabilities.chatApprovals === true;
    this._questionManager = supportsChatApprovals && !isEphemeral && !holdsQuestions ? questionManager : null;
    this._chatUploadsDirectory = chatUploadsDirectory;
    this._readChatApprovals = supportsChatApprovals ? readChatApprovals : () => "off";
    this._approvals = createSessionApprovalHolds({
      agentId: this.agentId,
      questionDenyReply: this._adapter.questionDenyReply ?? "hook-specific-output",
      holdsQuestionsForParent: holdsQuestions,
      readChatApprovals: this._readChatApprovals,
      questionManager: this._questionManager,
      port: {
        emit: (event, detail) => this.emit(event, detail),
        notePassedQuestion: (seq) => this._setPassedQuestionSeq(seq),
        ingestStatus: (signal) => this._ingestHookSignal(signal),
        noteQuestionDismissed: () => this._ingestHookSignal({ signal: "ready", source: "hook", confidence: "high", ts: clock.nowMs() }),
        pushAuditEntry: (entry) => this._pushAuditEntry(entry),
        noteHeldForChat: (toolName, payload) => this._ingestHookSignal({ signal: "awaiting-input", source: "hook", ts: clock.nowMs(), promptKind: "elicitation", promptToolName: toolName, payload }),
        noteAnsweredFromChat: () => this._ingestHookSignal({ signal: "working", source: "hook", confidence: "high", ts: clock.nowMs() }),
        taskTitle: () => this.refocusTaskTitle,
      },
    });
    this._titleQuietFallbackMs = titleQuietFallbackMs;
    this._titleQuietFallbackTimer = null;
    this._inputReadyFallbackTimer = null;

    this._hookActivity = "unseen";
    this._lastSignal = null;

    this._compaction = createCompactionTracking();
    this._pendingPromptKind = null;
    this._usageLimit = null;
    this._loginFailurePromptKind = SIGN_IN_PROMPT_KIND;
    this._pendingPromptToolName = null;
    this._attention = createAttentionLanes();

    this._titleGate = "open";
    this._hookPromptReporting = "none";
    this.backgroundTracking = createSessionBackgroundTracking({
      detectBackgroundAgents: hasBackgroundAgentDetection && this._can("backgroundAgents"),
      agentTtlMs,
      shellTaskTtlMs,
      teammateTaskTtlMs,
      gateReleaseSettleMs,
      announcesFinishedBackgroundWork: this._can("announcesFinishedBackgroundWork"),
      detectScheduledWakeups: hasScheduledWakeups,
      port: {
        state: () => this.state,
        isDestroyed: () => this._destroyed,
        emit: (event, detail) => this.emit(event, detail),
        recordDecision: (entry) => this._recordDecision(entry),
        transition: (event, detail) => this.transition(event, detail),
        resyncWorkingLatch: () => this._titleSource.resyncWorkingLatch(),
        enterCheckTerminal: () => this.enterCheckTerminal(),
      },
    });
    this._spawnCommand = spawnCommand;
    this._requiresWorktree = requireWorktree === true;
    this._initialPrompt = promptWithDoneMeans(initialPrompt, doneMeans);
    this._firstTurnSince = null;
    this._extraClaudeArgs = Array.isArray(extraClaudeArgs) ? extraClaudeArgs : [];
    this._agentSetup = agentSetup;
    this._isCleanHome = isCleanHome === true;
    this._resumeSessionId = resumeSessionId || null;
    this.workspaceRepos = workspaceRepos ? [...workspaceRepos] : null;
    this._transcriptPath = null;
    this._lastClaudeSessionReport = null;
    this._resumeCapture = "active";
    this.ephemeral = isEphemeral;
    this._spawnEnv = spawnEnv;
    this._prependPathDirs = prependPathDirs;
    this._hookTools = hookTools.filter((tool) => this._can(HOOK_TOOLS[tool.id].capability));
    this._planLimits = planLimits === true && this._can("planLimits");
    this._packMcpServers = packMcpServers;
    this._sharedPackMcpServers = sharedPackMcpServers;
    this._hooks = createSessionHookLifecycle({
      id: this.id,
      name: this.name,
      agentId: this.agentId,
      adapter: this._adapter,
      hookRouter,
      getHookPort,
      hooksBaseDir,
      settingsPermissions,
      detectScheduledWakeups: hasScheduledWakeups,
      observeToolCalls: observeToolCalls === true,
      readChatApprovals: this._readChatApprovals,
      enableProjectMcp: enableProjectMcp === true,
      hookTools: this._hookTools,
      planLimits: this._planLimits,
      getUserHooks,
      extraUserHooks,
      scratchAgentHome,
      isCleanHome,
      isOsSandboxed: prepareSandbox !== null,
      privateHomeKey: prepareSandbox === null ? null : privateHomeKey,
      packSkillDirs: () => this._launch.packLaunch?.namedSkillDirs ?? [],
      packHookFiles: () => this._launch.packLaunch?.hookFiles ?? [],
      modelSelection: () => this._agentSetup,
      requiresHooks: requiresHooks === true && hookRouter !== null,
      bypassHookTrust: this.bypassHookTrust,
      effectiveCwd: () => this.effectiveCwd(),
      folderTrustRoot: () => folderTrustRoot(this.effectiveCwd(), worktreeRoot),
      packMcpServers: () => this._launch.packMcpServers,
      sharedPackMcpServers: () => this._launch.sharedPackMcpServers,
      agentEnv: () => this._launch.buildEnv(),
      accountFolder: () => this._launch.accountFolder,
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
    this._gitCredentialToken = resolveGitCredentialHelper === null ? null : generateToken();
    this._canRunHelpCommand = permitsHelpCommand(settingsPermissions);
    this._agentLiveChildren = 0;
    this._agentLifetimeSpawns = 0;
    this._agentSpawnsInFlight = 0;
    this._platform = platform;
    this._probeGraphicalSession = probeGraphicalSession;
    this._launch = createSessionLaunch({
      id: this.id,
      usageVendor: this.usageVendor,
      adapter: this._adapter,
      hooks: this._hooks,
      port: {
        platform: () => this._platform,
        effectiveCwd: () => this.effectiveCwd(),
        spawnEnv: () => this._spawnEnv,
        spawnCommand: () => this._spawnCommand,
        agentToken: () => this._agentToken,
        commitSigningToken: () => this._commitSigningToken,
        commitSigningProgram: () => this._commitSigningProgram,
        gitCredentialToken: () => this._gitCredentialToken,
        resolveGitCredentialHelper,
        resolveHostSigningEnv: commitSigningProgram === null ? null : resolveHostSigningEnv,
        resolveLaunchSecrets,
        resolveAccountHome,
        getPackAgentLaunch: getPackAgentLaunch ?? (() => null),
        getPackMcpServers: () => this._packMcpServers,
        getSharedPackMcpServers: () => this._sharedPackMcpServers,
        prepareSandbox,
        privateHomeKey: prepareSandbox === null ? null : privateHomeKey,
        probeGraphicalSession: () => this._probeGraphicalSession(),
        onSandboxRefused: (cause) => this._abandonSpawn(cause),
        onSupersededSandbox: () => this._hooks.cleanup(),
      },
    });

    this._reaper = createSessionProcessReaper({
      platform,
      killProc: killProc || ((args, opts, cb) => execFile("taskkill", args, opts, cb)),
      signalProc: signalProc || ((pid, signal) => process.kill(pid, signal)),
      stopScope: stopSessionScope,
      port: {
        isDestroyed: () => this._destroyed,
        emitError: (err) => this._emitError(err),
      },
    });

    this._startPending = null;
    this.worktreeLifecycle = createSessionWorktreeLifecycle({
      id: this.id,
      projectPath: this.path,
      integrationBranch,
      startSha,
      gitWorkspace,
      autoRebase: autoRebase ?? true,
      syncOnStart: syncOnStart ?? true,
      liveWorktreeReview: liveWorktreeReview ?? true,
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
        deliver: (text, options) => this.deliver(text, options),
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
      this._taskTitle.noteOscTitle(title, this._titleProjectName());
    });
    this._titleSource.on("signal", (s) => {
      if (this._titleGate === "quiet") return;
      this._statusSource.ingest(s);
    });
    this._statusSource.on("status", (s: ResolvedStatusSignal) => this._onStatus(s));
    this._statusSource.on("meta", (m: MetaStatusSignal) => this._onMeta(m));
  }

  get _ptyAlive(): boolean {
    return this._driver.isMarkedLive;
  }

  set _ptyAlive(isAlive: boolean) {
    this._driver.setLive(isAlive);
  }

  get ptyProcess(): SessionPty | null {
    return this._driver.process;
  }

  set ptyProcess(process: SessionPty | null) {
    this._driver.adoptProcess(process);
  }

  get _output(): PtyDriver["output"] {
    return this._driver.output;
  }

  get _ptySpawn(): PtySpawn {
    return this._driver.spawnFunction();
  }

  set _ptySpawn(spawn: PtySpawn) {
    this._driver.useSpawnFunction(spawn);
  }

  get _hooksReportPrompts(): boolean {
    return this._hookPromptReporting === "hooks";
  }

  set _hooksReportPrompts(reports: boolean) {
    this._hookPromptReporting = reports ? "hooks" : "none";
  }

  get _taskTitleSources(): TaskTitleSources {
    return this._taskTitle.sources;
  }

  get customTitle(): string | null {
    return this._taskTitle.customTitle;
  }

  get taskTitle(): string | null {
    return this._taskTitle.taskTitle;
  }

  get taskTitleIsCustom(): boolean {
    return this._taskTitle.taskTitleIsCustom;
  }

  get taskTitlePromptRevision(): number {
    return this._taskTitle.promptRevision;
  }

  setCustomTitle(title: string | null): void {
    this._taskTitle.setCustomTitle(title);
  }

  launchEnv(): SpawnEnv {
    return this._launch.buildEnv();
  }

  get agentSetup(): AgentSetup | null {
    return this._agentSetup;
  }

  get refinedTaskTitle(): string | null {
    return this._taskTitle.refinedTaskTitle;
  }

  get transcriptPath(): string | null {
    return this._transcriptPath;
  }

  get persistedTaskTitle(): PersistedTaskTitle | undefined {
    return this._taskTitle.persistedTaskTitle;
  }

  get refocusTaskTitle(): string | null {
    return this._taskTitle.refocusTaskTitle;
  }

  setAgentDoneLines(lines: readonly AgentDoneLine[]): void {
    this.agentDoneLines = lines.map((line) => ({ ...line }));
    this.emit("agent-done-lines-change", { agentDoneLines: this.agentDoneLines });
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

  releasePr(pullRequestKey: string): void {
    this._replacePrLinks(withoutReleasedPrLink(this._prLinks, pullRequestKey));
  }

  _replacePrLinks(next: SessionPrLinks): void {
    if (next === this._prLinks) return;
    this._prLinks = next;
    this.emit("pr-links-change", next);
  }

  get recentTaskPrompts(): readonly string[] {
    return this._taskTitle.recentTaskPrompts;
  }

  applyTaskTitleRefinement(refinement: TaskTitleRefinementResult): void {
    this._taskTitle.applyRefinement(refinement);
  }

  _updateTaskTitle(): void {
    this._taskTitle.refreshSecretMask();
  }

  _refreshTranscriptTaskTitle(): Promise<void> {
    return this._taskTitle.refreshFromTranscript();
  }

  get _ranCommands(): ReadonlySet<string> {
    return this._promptNotes.ranCommands;
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
    this._taskTitle.refreshSecretMask();
  }

  get auditLog(): Record<string, unknown>[] {
    return this._observability.auditLog;
  }

  get agentDrawsAlternateScreen(): boolean {
    return this._can("drawsOwnAlternateScreen");
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

  emitSubagentSignal(raw: HookSignal): void {
    const payload = raw.payload ?? {};
    const subagentId = nonEmptyText(payload.agent_id);
    if (subagentId === null) return;
    const toolInput = typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
    const declaredType = "subagent_type" in toolInput ? toolInput.subagent_type : null;
    const task = "description" in toolInput ? toolInput.description : null;
    const signal: SubagentSignal = {
      phase: raw.signal === "subagent-start" ? "start" : "stop",
      subagentId,
      subagentType: nonEmptyText(payload.agent_type) ?? nonEmptyText(declaredType),
      task: nonEmptyText(task),
      ts: raw.ts || clock.nowMs(),
    };
    this.emit(SUBAGENT_SIGNAL_EVENT, signal);
  }

  _isSubagentTurnStop(raw: HookSignal): boolean {
    if (raw?.signal !== "ready" || String(raw.event || "").toLowerCase() !== "stop") return false;
    return this._can("subagentTurnStops") && this.backgroundTracking.activeAgentCount() > 0;
  }

  ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    if (this._approvals.parksQuestionStatus(raw)) return;
    if (this._conversationApproval !== null && raw?.signal === "working") return;
    this._ingestHookSignal(raw);
  }

  _ingestHookSignal(raw: HookSignal): void {
    if (this._destroyed) return;
    if (raw?.promptKind === SIGN_IN_PROMPT_KIND && this._loginFailurePromptKind !== SIGN_IN_PROMPT_KIND) {
      this._ingestHookSignal({ ...raw, promptKind: this._loginFailurePromptKind });
      return;
    }
    if (raw?.signal === SIGNED_IN_SIGNAL) {
      const isWaitingOnLogin = this.state === STATES.WAITING && this._pendingPromptKind !== null && LOGIN_PROMPT_KINDS.has(this._pendingPromptKind);
      if (!isWaitingOnLogin) return;
      this._ingestHookSignal({ ...raw, signal: "ready", confidence: "high" });
      return;
    }
    if (this._isConversationReplacedAtStartup(raw)) {
      this.ingestHookSignal({ ...raw, payload: { ...raw.payload, source: "clear" } });
      return;
    }
    this._hookActivity = "seen";
    if (!this._startupSignals.has("ready") && this._inputReadyCondition() === "startup-hook") this._noteInputReady();
    if (this._recorder && raw?.event) {
      this._recorder.writeHook(raw.event, raw.payload);
    }

    if (raw && (raw.signal === "subagent-start" || raw.signal === "subagent-stop")) {
      this.backgroundTracking.trackSubagent(raw);
      this.emitSubagentSignal(raw);
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
      this._recordDecision({ ts: clock.nowMs(), kind: "signal", signal: raw.signal, source: raw.source, state: this.state, active: this.backgroundTracking.activeAgentCount(), action: "subagent-stop-dropped" });
      return;
    }

    if (raw?.payload) {
      this._captureClaudeSessionId(
        this._reportedSessionIdOf(raw.payload), raw.payload.source, raw.payload.transcript_path, raw.signal, raw.confidence);
      this._taskTitle.noteHookPayload(raw.payload, path.basename(this.effectiveCwd()));
    }

    const hookEvent = String(raw.event || "").toLowerCase();
    if (hookEvent === "stop" || (raw.signal === "ready" && raw.source === "hook")) this._observeCompaction("stop");
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

    if (hookEvent === "userpromptsubmit" || raw.signal === "resume") {
      this._promptNotes.dropResumeNote();
      if (this._usageLimit !== null) this._setUsageLimit(null);
      const prompt = raw.payload?.prompt;
      if (prompt !== undefined) {
        this._promptNotes.queuePromptHint(prompt);
        this._taskTitle.notePrompt(prompt);
      }
    }
    if (hookEvent === "stop" && (this.state === STATES.IDLE || this.state === STATES.COMPLETE)) {
      void this._taskTitle.refreshFromTranscript();
    }

    if (raw && raw.signal === "awaiting-input") {
      const isNotificationInSameWaitingEpisode = String(raw.event || "").toLowerCase() === "notification" && this.state === STATES.WAITING;
      this._setPendingPromptKind(raw.promptKind || null, raw.promptToolName ?? null, isNotificationInSameWaitingEpisode);
      const proposedPlanText = raw.payload?.[PROPOSED_PLAN_TEXT_FIELD];
      if (raw.promptKind === "plan" && typeof proposedPlanText === "string") this.emit("plan-proposed", { planText: proposedPlanText });
    }
    if (raw && raw.signal === "session-start" && this._onSessionStartHook(raw)) return;
    if (raw && raw.signal === "resume") {
      this._promptPhase = "prompted";
      this._observeCompaction("resume");
      this._titleGate = "open";
      this._setPendingPromptKind(null);
      this._setPassedQuestionSeq(0);

      this.backgroundTracking.noteTaskNotificationsDelivered(raw.payload?.prompt);
      this.backgroundTracking.clearGateHeldReady();
      this.backgroundTracking.resetTurnEvidence();
      this.backgroundTracking.clearBgDeclared();
      if (this.state === STATES.RUNNING) this._chatOutbox.noteTurnStarted();

      const isSelfWake = isSelfWakePrompt(raw.payload?.prompt);
      if (!isSelfWake) this._dispatchAttention({ type: "operator_prompt" });
      this.emit("user-prompt", { state: this.state, stateSince: this.stateSince, ts: clock.nowMs(), isSelfWake });
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
    return isConversationReplacedAtStartup({ hasPromptSinceSpawn: this._promptPhase === "prompted", currentResumeSessionId: this._resumeSessionId, reportedId, sessionStartSource: raw.payload.source });
  }

  _onSessionStartHook(raw: HookSignal): boolean {
    const payload = raw.payload || {};
    const src = String(payload.source || "").toLowerCase();
    if (src !== "clear" && src !== "compact") return false;
    if (src === "compact") {
      this._finishCompaction();
      return true;
    }
    this._compaction = createCompactionTracking();
    this._emitSessionDetail();
    this._taskTitle.resetAutomatic();
    this._resetDetectionSources({ quiet: true });
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.resetTurnEvidence();
    this._setPendingPromptKind(null);
    this._promptNotes.forgetHints();
    this._armPromptSupervisionLine();
    return false;
  }

  _captureClaudeSessionId(
    id: unknown,
    source: unknown,
    transcriptPath: unknown,
    signal: string | null,
    confidence?: string | null,
  ): void {
    if (this._resumeCapture === "suppressed") return;
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

  _setPendingPromptKind(kind: string | null, toolName: string | null = null, mayInheritCurrentToolName?: boolean): void {
    const next = kind || null;
    this._pendingPromptToolName = nextPendingPromptToolName(this._pendingPromptKind, this._pendingPromptToolName, next, toolName, mayInheritCurrentToolName ?? false);
    if (next === this._pendingPromptKind) return;
    const isLeavingRateLimit = this._pendingPromptKind === RATE_LIMIT_PROMPT_KIND;
    this._pendingPromptKind = next;
    this._emitSessionDetail();
    if (isLeavingRateLimit && this._usageLimit !== null) this._setUsageLimit(null);
  }

  _observeCompaction(signal: string, source?: string | null): void {
    if (!this._can("compactQuiet")) return;
    const wasCompacting = this._compaction.isCompacting;
    this._compaction = observeCompaction(this._compaction, {
      signal, source, state: this.state,
      pendingPromptKind: this._pendingPromptKind,
      pendingPromptToolName: this._pendingPromptToolName,
      heldReady: this.backgroundTracking.heldReady(),
    });
    if (this._compaction.isCompacting !== wasCompacting) this._emitSessionDetail();
  }

  _emitSessionDetail(): void {
    this.emit("prompt-kind-change", {
      pendingPromptKind: this._pendingPromptKind,
      isCompacting: this._compaction.isCompacting,
    });
  }

  _finishCompaction(): boolean {
    const finished = finishCompaction(this._compaction, this.state, this.backgroundTracking.heldReady());
    this._compaction = finished.tracking;
    const isTurnStillOpen = finished.tracking.hasPromptInFlight;
    if (finished.shouldResetDetectionSources) {
      this._resetDetectionSources({ quiet: !isTurnStillOpen });
      this.backgroundTracking.clearGateHeldReady();
    }
    if (finished.event) {
      this.transition(finished.event, { source: "hook", signal: "compaction-end" });
      this._setPendingPromptKind(finished.returnState?.pendingPromptKind ?? null, finished.returnState?.pendingPromptToolName ?? null);
    }
    if (finished.returnHeldReady) {
      this.backgroundTracking.restoreGateHeldReady(finished.returnHeldReady);
      if (this.backgroundTracking.heldReady() !== null) {
        this._chatOutbox.drain();
        this.emit("turn-end-held");
      }
    }
    this._emitSessionDetail();
    return isTurnStillOpen;
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

  _resetDetectionSources({ quiet, clearTracking }: { quiet?: boolean; clearTracking?: boolean } = {}): void {
    this._titleSource.reset();
    this._statusSource.reset();
    if (quiet !== undefined) this._titleGate = quiet ? "quiet" : "open";

    if (clearTracking === true) this._clearDetectionTracking();
  }

  _clearDetectionTracking(): void {
    this._compaction = createCompactionTracking();
    this._emitSessionDetail();
    this.backgroundTracking.clearGateHeldReady();
    this.backgroundTracking.clearAgents();
    this.backgroundTracking.clearWakeups();
    this._setPendingPromptKind(null);
  }

  _isSignalConsumedByCompactionEnd(s: ResolvedStatusSignal): boolean {
    if (!isCompactionEndingSignal(this._compaction, s.signal, s.source, this._hooksReportPrompts)) return false;
    const isTurnStillOpen = this._finishCompaction();
    return !isTurnStillOpen;
  }

  _onStatus(s: ResolvedStatusSignal): void {
    if (this._destroyed) return;
    this._lastSignal = { signal: s.signal, source: s.source, confidence: s.confidence, ts: s.ts };

    this._observeCompaction(s.signal, s.source);
    if (this._isSignalConsumedByCompactionEnd(s)) return;
    if (suppressCompactionSignal(this._compaction, s.signal)) return;

    const signalSeq = this.backgroundTracking.noteStatus(s.signal);

    if (s.signal === "working") {
      this._setPendingPromptKind(null);
      this._setPassedQuestionSeq(0);
    }

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
      ts: clock.nowMs(),
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
    if (gateHeld) {
      this.backgroundTracking.stashGateHeldReady(s);
      this._chatOutbox.drain();
      this.emit("turn-end-held");
    }

    if (s.signal === "ready") this.worktreeLifecycle.scheduleCheck();
  }

  _onMeta(m: MetaStatusSignal): void {

    this._lastSignal = { signal: m.signal, source: m.source, ts: m.ts, meta: true };
  }

  get pid(): number | null {
    return this._driver.pid;
  }

  measureResidentBytes(): Promise<number | null> {
    const processId = this.pid;
    return processId === null ? Promise.resolve(null) : readProcessTreeResidentBytes(processId);
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

  holdConversationPermission(payload: unknown, abandoned: AbortSignal): Promise<PermissionHookReply | null> | null {
    return this._approvals.hold(payload, abandoned);
  }

  holdQuestionTool(payload: unknown, abandoned: AbortSignal): Promise<QuestionToolDenyResponse | null> | null {
    return this._approvals.holdQuestionTool(payload, abandoned);
  }

  get planGate(): PlanGate | null {
    return this._approvals.planGate;
  }

  holdElicitation(payload: unknown, abandoned: AbortSignal): Promise<ElicitationHookReply | null> | null {
    return this._approvals.holdElicitation(payload, abandoned);
  }

  holdPlanPermission(payload: unknown, abandoned: AbortSignal, isPlanGateOn: boolean): Promise<ClaudeHookReply | null> | null {
    return this._approvals.holdPlan(payload, abandoned, isPlanGateOn);
  }

  get isChatApprovalsOn(): boolean {
    return this._readChatApprovals() !== "off";
  }

  proposePlan(planText: string): void {
    this._approvals.proposePlan(planText);
  }

  decidePlan(decision: PlanDecision, feedback: string | null): { ok: true; isHeld: boolean } | { ok: false; reason: string } {
    return this._approvals.decidePlan(decision, feedback);
  }

  answerConversationApproval(requestId: number | string, answers: ConversationAnswers): boolean {
    return this._approvals.answer(requestId, answers);
  }

  decideConversationApproval(requestId: number | string, decision: PermissionDecision, denyMessage: string | null = null): boolean {
    return this._approvals.decide(requestId, decision, denyMessage);
  }

  releaseQuestionHold(requestId: string): boolean {
    return this._approvals.release(requestId);
  }

  get hookSeen(): boolean {
    return this._hookActivity === "seen";
  }

  get hasBackgroundWork(): boolean {
    return this.backgroundTracking.hasBackgroundWork();
  }

  get expiredOpenWork(): ExpiredOpenWork {
    return this.backgroundTracking.expiredOpenWork();
  }

  get agentToken(): string | null {
    return this._agentToken;
  }

  get commitSigningToken(): string | null {
    return this._commitSigningToken;
  }

  get isSandboxed(): boolean {
    return this._launch.isSandboxed;
  }

  get accountIdInUse(): string | null {
    return this._launch.accountIdInUse;
  }

  get accountInUseSinceMs(): number | null {
    return this._launch.accountInUseSinceMs;
  }

  get gitCredentialToken(): string | null {
    return this._gitCredentialToken;
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
    const effect = this._dispatchAttention({ type: "raise", origin, note, at: clock.nowMs(), state: this.state });
    if (effect.refusal !== null) return { ok: false, error: effect.refusal };
    return { ok: true, pending: effect.isHeld };
  }

  get attentionNotes(): AttentionNote[] {
    return attentionNotesOf(this._attention);
  }

  _dispatchAttention(event: AttentionEvent): ReturnType<typeof reduceAttention>["effect"] {
    const { lanes, effect } = reduceAttention(this._attention, event);
    this._attention = lanes;
    const ts = clock.nowMs();
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

  enterCheckTerminal(): void {
    if (mapSignalToEvent("awaiting-input", this.state, "high", 0) !== "prompt_detected") return;
    this._setPendingPromptKind(CHECK_TERMINAL_PROMPT_KIND);
    this._statusSource.ingest({ signal: "awaiting-input", source: "glimmervoid", confidence: "high", ts: clock.nowMs() });
  }

  get hasLivePty(): boolean {
    return !this._destroyed && this._driver.isLive;
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
    return this._hooks.isSaneYoloActive();
  }

  get isQuestionManagerOn(): boolean | null {
    return this._questionManager?.isOn ?? null;
  }

  _prepareRestart(options: { fresh?: boolean; conversationId?: string | null } = {}): void {
    const switchesConversation = Boolean(options.conversationId) && options.conversationId !== this._resumeSessionId;
    this._restartStartsNewConversation = options.fresh === true || switchesConversation;
    if (options.fresh !== true) {
      this._bindRestartConversation(options.conversationId);
      return;
    }

    this._resumeCapture = "suppressed";
    this.setResumeConversation(null);
    this._transcriptPath = null;
    this._taskTitle.resetAutomatic();
    this._promptNotes.forgetHints();
    this.emit("resume-cleared", { id: this.id });
  }

  _bindRestartConversation(conversationId: string | null | undefined): void {
    if (!conversationId) return;
    this._resumeCapture = "suppressed";
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
  get isAutoRebasing(): boolean { return this.worktreeLifecycle.snapshot().isAutoRebasing; }
  get isWorkspace(): boolean { return this.worktreeLifecycle.snapshot().isWorkspace; }

  getWorktreeCarry() { return this.worktreeLifecycle.getCarry(); }

  get hasOwnWorktree(): boolean { return this.worktreeLifecycle.hasOwnWorktree(); }

  effectiveCwd(): string { return this.worktreeLifecycle.effectiveCwd(); }
  get workingDirectory(): string { return this.effectiveCwd(); }

  _provisionWorktree({ fresh = false }: { fresh?: boolean } = {}) { return this.worktreeLifecycle.provision({ fresh }); }

  _settleWorktreeOnExit() { return this.worktreeLifecycle.settleOnExit(); }

  discardWorktreeIfClean() { return this.worktreeLifecycle.discardIfClean(); }

  onBeforeWorktreeDiscard(hold: () => Promise<() => void>): void { this._worktreeReaderHolds.add(hold); }

  releaseDroppedWorkspaceMembers(keepRepoPaths: string[]) { return this.worktreeLifecycle.releaseDroppedWorkspaceMembers(keepRepoPaths); }

  pasteMergePrompt() { return this.worktreeLifecycle.pasteMergePrompt(); }

  deliver(text: string, options: DeliverOptions): DeliveryOutcome {
    return this._driver.send(cleanPastedText(text), {
      ...options,
      onSettled: (settlement) => {
        if (settlement === "submitted") this.emit("delivered-input");
        options.onSettled?.(settlement);
      },
    });
  }


  hasPendingPaste(): boolean { return this._output.hasPendingPaste(); }
  isDeliveryInFlight(): boolean { return this._output.isDeliveryInFlight(); }

  _clearPendingPaste(): void { this._output.clearPendingPaste(); }

  hasUnmergedWork() { return this.worktreeLifecycle.hasUnmergedWork(); }

  getDiff() { return this.worktreeLifecycle.getDiff(); }
  getDiffFileContents(request: { path: string; oldBlobId: string | null; newBlobId: string }) { return this.worktreeLifecycle.getDiffFileContents(request); }

  getChangeScopes() { return this.worktreeLifecycle.getChangeScopes(); }

  worktreeSignature(): string | null { return this.worktreeLifecycle.worktreeSignature(); }

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
      hookSeen: this.hookSeen,
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
      hasPty: this._driver.process !== null,
      ptyPid: this._driver.pid,
      outputBufferEntries: this._output.stats().entries,
      outputBufferBytes: this._output.stats().bytes,
      outputBufferTotal: this._output.stats().total,
      auditLogLength: this.auditLog.length,
      dataListenerCount: this.listenerCount("data"),
      hookSeen: this.hookSeen,
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
      workingDirectory: this.effectiveCwd(),
      agent: this.agentId,
      agentDrawsAlternateScreen: this.agentDrawsAlternateScreen,
      state: this.state,
      stateSince: this.stateSince,
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      saneYolo: this.saneYolo,
      ephemeral: this.ephemeral,
      attentionOwner: this.attentionOwner,
      isWorktree: this.isWorktree,
      isWorkspace: this.isWorkspace,
      resumeSessionId: this._resumeSessionId,
      activeAgents: active,
      awaitingBackgroundTasks: this.backgroundTracking.awaitingBackgroundTasks(),
      pendingPromptKind: this._pendingPromptKind,
      usageLimit: this._usageLimit,
      attentionNotes: this.attentionNotes,
      planGate: this.planGate,
      conversationApproval: this._conversationApproval,
      chatOutbox: this._chatOutbox.entries(),
      mergeStatus: this.mergeStatus,
      mergeReason: this.mergeReason,
      worktreeNotice: this.worktreeNotice,
      failureReason: this.failureReason,
      unseenOutcome: this.unseenOutcome,
      managerSeenSeq: this.managerSeenSeq,
      passedQuestionSeq: this.passedQuestionSeq,
      isQuestionManagerOn: this.isQuestionManagerOn,
      accountId: this.accountId,
      parent: this.parent,
      isStudioMain: this.isStudioMain,
      agentSetup: this._agentSetup,
      effectiveBase: this.worktreeLifecycle.snapshot().effectiveBase,
      linkedPrs: this.linkedPrs,
      doneMeans: this.doneMeans,
      agentDoneLines: this.agentDoneLines,
      auditLog: this.auditLog,
      detection: {
        ...this.getDetectionStats(),
        agents: { ...this.backgroundTracking.agentBreakdown(), active },
        gate: held
          ? { heldForMs: clock.nowMs() - held.ts, seq: held.seq, lastActivitySeq: this.backgroundTracking.lastActivitySeq() }
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
        timestamp: clock.nowMs(),
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
    if (to === STATES.FAILED && event !== "spawn_fail") this.failureReason = stopReasonOf(detail);
    if (to === STATES.INITIALIZING) this.failureReason = null;
    if (to === STATES.INITIALIZING) this._stopReason = null;
    const unseenOutcomeOnEntry = UNSEEN_OUTCOME_ON_ENTRY.get(to);
    if (unseenOutcomeOnEntry !== undefined && !isCompactionRestoreEvent(event)) this._setUnseenOutcome(unseenOutcomeOnEntry);
    if (to === STATES.IDLE || to === STATES.COMPLETE) this._observeCompaction("settled");

    const entryHook = ENTRY_HOOKS[to];
    if (entryHook && !isCompactionRestoreEvent(event)) {
      entryHook(this);
    }

    if (to === STATES.IDLE || to === STATES.COMPLETE) {
      this._titleSource.resyncWorkingLatch();
      void this._taskTitle.refreshFromTranscript();
    }

    const enteredAt = clock.nowMs();
    const stateClock = nextStateClock(from, to, enteredAt, this.stateSince, this._firstTurnSince);
    this.stateSince = stateClock.stateSince;
    this._firstTurnSince = stateClock.firstTurnSince;
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

  holdResumePromptForNextStart(resumePrompt: string | null): void {
    this._promptNotes.holdResumePrompt(resumePrompt);
  }

  start(options: { fresh?: boolean; resumePrompt?: string | null } = {}): Promise<void> {
    if (this._startPending) return this._startPending;
    const resumePrompt = this._promptNotes.takeHeldResumePrompt(options.resumePrompt);
    const pending = this._startBody({ ...options, resumePrompt }).finally(() => {
      if (this._startPending === pending) this._startPending = null;
    });
    this._startPending = pending;
    return pending;
  }

  async _startBody({ fresh = false, resumePrompt = null }: { fresh?: boolean; resumePrompt?: string | null } = {}): Promise<void> {
    if (this._destroyed) return;
    const startGeneration = ++this._startGeneration;

    const previousPty = this._driver.currentHandle();
    if (previousPty) {
      console.warn(`[session:${this.name}] start() called while PTY exists - killing previous PTY first`);
      this._reaper.killReap = this._reaper.reapTreeOnce(previousPty.pid, previousPty.scopeUnit);
      this._driver.forget();
    }

    const pendingReaps = this._reaper.awaitPendingReaps();
    if (pendingReaps) await pendingReaps;
    if (this._destroyed || this._startGeneration !== startGeneration) {
      this._launch.clearApprovedLaunches();
      return;
    }

    if (this.state === STATES.DORMANT) {
      this.transition("user_start");
    }
    const preparingState = this.state;
    const isStartSuperseded = () => this._destroyed || this.state !== preparingState || this._startGeneration !== startGeneration;

    if (!(await this._provisionWorktree({ fresh }))) {
      this._launch.clearApprovedLaunches();
      if (!isStartSuperseded()) this.transition("provision_blocked");
      return;
    }
    if (isStartSuperseded()) {
      this._launch.clearApprovedLaunches();
      return;
    }
    if (this._requiresWorktree && !this.worktreeDir) {
      this._launch.clearApprovedLaunches();
      this.transition("provision_blocked");
      this.emit('error', new Error('This session requires its own git worktree'));
      return;
    }

    if (!(await this._launch.resolveGitAndSigning(this.effectiveCwd(), isStartSuperseded))) {
      this._launch.clearApprovedLaunches();
      return;
    }

    const launchPlan = launchPlanFor(this._adapter.id, this._agentSetup, this._platform);
    const launchSecretEnv = await this._launch.resolveLaunchSecretEnv(launchPlan, this.effectiveCwd());
    if (isStartSuperseded()) {
      this._launch.clearApprovedLaunches();
      return;
    }
    if ("refusal" in launchSecretEnv) {
      this._abandonSpawn(new Error(launchSecretEnv.refusal));
      return;
    }
    if ("held" in launchSecretEnv) {
      void launchSecretEnv.held.then((outcome) => this._resumeHeldLaunch(outcome, preparingState, startGeneration));
      return;
    }
    const packMcpLaunch = await this._launch.resolvePackMcpLaunch(this.effectiveCwd());
    if (isStartSuperseded()) {
      this._launch.clearApprovedLaunches();
      return;
    }
    if ("held" in packMcpLaunch) {
      void packMcpLaunch.held.then((launch) => this._resumeHeldPackMcpLaunch(launch, preparingState, startGeneration));
      return;
    }
    this._launch.clearApprovedLaunches();

    if (this.worktreeDir) {
      this.worktreeLifecycle.startWatching();

      if (this.mergeStatus === "pending-review") this.worktreeLifecycle.scheduleCheck();
    }
    this._startupSignals.clear();
    this._promptPhase = "awaiting-first-prompt";
    this._clearTimer("_inputReadyFallbackTimer");

    this._clearDetectionTracking();
    this._driver.resetForStart();

    const rebaseline: RebaselineSignal = { startsNewConversation: this._restartStartsNewConversation };
    this._restartStartsNewConversation = false;
    this.emit(REBASELINE_EVENT, rebaseline);
    this._resetDetectionSources({ quiet: false });

    const accountRefusal = await this._launch.prepareAccountAndPacks(this._isCleanHome, packMcpLaunch, isStartSuperseded);
    if (isStartSuperseded()) return;
    if (accountRefusal !== null) {
      this._abandonSpawn(new Error(accountRefusal));
      return;
    }
    await this._hooks.prepare();
    if (this._adapter.trustFolder) {
      await this._adapter.trustFolder(this.effectiveCwd(), this._launch.buildEnv({ prependPathDirs: this._prependPathDirs }))
        .catch((error: unknown) => console.warn(`[session:${this.name}] ${errorMessage(error)}`));
    }
    if (isStartSuperseded()) return;
    const hookInjection = this._hooks.inject();
    if (hookInjection.refusal) {
      this._abandonSpawn(new Error(hookInjection.refusal));
      return;
    }
    const mcpLaunch = mcpLaunchFor({ agentId: this.agentId, listenerPort: this._hooks.listenerPort(), sessionId: this.id, agentToken: this._agentToken, packServers: this._launch.packMcpServers });
    const settingsArgs = [...hookInjection.args, ...mcpLaunch.args];

    this._hookPromptReporting = this._hooks.hasInjection() ? "hooks" : "none";
    this._titleGate = this._adapter.titleProfile.quietUntilFirstPrompt === true && this._hooksReportPrompts ? "quiet" : "open";
    this._armTitleQuietFallback();

    this._applyTitleContext();
    const injectedEnv = { ...hookInjection.env, ...this._launch.agentApiEnv(), ...this._launch.packMcpEnv, ...mcpLaunch.env, ...this._launch.gitEnv(), ...launchPlan.env, ...launchSecretEnv.env };
    const baseLaunchEnv = this._launch.launchSpawnEnv();
    const spawnExtraEnv = Object.keys(injectedEnv).length > 0
      ? { ...(baseLaunchEnv || {}), ...injectedEnv }
      : baseLaunchEnv;

    const env = this._launch.buildEnv({
      prependPathDirs: this._prependPathDirs,
      extraEnv: spawnExtraEnv,
    });
    this._loginFailurePromptKind = (this._adapter.credentialEnvNames ?? []).some((name) => (env[name] ?? "") !== "") ? API_KEY_PROMPT_KIND : SIGN_IN_PROMPT_KIND;
    if (await this._launch.shouldDetachDesktopBus()) env.DBUS_SESSION_BUS_ADDRESS = DETACHED_DESKTOP_BUS_ADDRESS;

    const configuredResumeSessionId = this._can("resume") ? this._resumeSessionId : null;
    const resumeTarget = this._launch.resolveResumeSessionId(configuredResumeSessionId, this._transcriptPath, env);
    const spawnResumeSessionId = resumeTarget.resumeSessionId;
    if (configuredResumeSessionId && !spawnResumeSessionId) {
      console.warn(`[session:${this.name}] spawning without the stale resume id ${configuredResumeSessionId} because no transcript exists at any of: ${resumeTarget.checkedTranscriptPaths.join(", ")}`);
    }

    this._resumeCapture = "active";
    const isResumeNoteLaunch = Boolean(spawnResumeSessionId && resumePrompt);
    const isResumeNoteByHook = isResumeNoteLaunch && this._can("resumeNoteByHook") && this._hooks.hasInjection();
    this._promptNotes.armResumeNote(isResumeNoteByHook ? resumePrompt : null);
    const launchPrompt = isResumeNoteLaunch ? (isResumeNoteByHook ? null : resumePrompt) : this._initialPrompt;
    if (!launchPrompt && !this._promptNotes.pendingResumeNote()) this._firstTurnSince = null;
    if (isResumeNoteLaunch) this.emit("delivered-input");
    const agentArgs = this._adapter.buildArgs({
      dangerouslySkipPermissions: this.dangerouslySkipPermissions,
      resumeSessionId: spawnResumeSessionId,
      extraArgs: [...this._extraClaudeArgs, ...launchPlan.args, ...cleanHomeArgs(this._adapter.id, this._isCleanHome), ...claudePluginArgs(this._adapter.id, this._launch.packLaunch), ...this._launch.osSandboxArgs(this.dangerouslySkipPermissions)],
      initialPrompt: launchPrompt,
    });

    if (isStartSuperseded()) {
      this._hooks.cleanup();
      return;
    }
    const scopeHost = this._driver.spawnsWithNodePty() ? await resolveSessionScopeHost() : null;
    if (isStartSuperseded()) {
      this._hooks.cleanup();
      return;
    }
    const agentCommand = this._launch.spawnCommandFor({ settingsArgs, agentArgs });
    const sandboxedCommand = await this._launch.sandboxedCommand(agentCommand, env, Object.keys(spawnExtraEnv ?? {}), isStartSuperseded);
    if (sandboxedCommand === null) return;
    const { file, args } = sandboxedCommand;
    const scopeUnit = scopeHost === null ? null : sessionScopeUnitName(this.id, randomBytes(4).toString("hex"));
    const sandboxedEnv = sandboxedCommand.env;
    const launch = scopeUnit === null ? { file, args, env: sandboxedEnv } : scopedLaunch({ unitName: scopeUnit, serverUnit: scopeHost?.serverUnit ?? null, file, args, env: sandboxedEnv });

    const ptySize = this._driver.ptySize();
    try {
      this._driver.start({ file: launch.file, args: launch.args, cwd: this.effectiveCwd(), env: launch.env, scopeUnit, resumeAgentSessionId: null });
    } catch (err) {
      this._abandonSpawn(err);
      return;
    }

    const spawnCwdExists = fs.existsSync(this.effectiveCwd());
    if (spawnCwdExists) this._hooks.confirmSaneYoloActive();
    if (!this.transition("spawn_success", { spawnCwdExists })) {
      this._hooks.deactivateSaneYolo();
      this._hooks.cleanup();
      this.transition("spawn_fail", { reason: "spawn_cwd_missing" });
      this.kill();
      return;
    }

    this._watchSandboxLogin();

    const initialPrompt = this._initialPrompt;
    const argsForLog = initialPrompt
      ? args.map((a) => a.replace(initialPrompt, `<prompt:${initialPrompt.length}c>`)).join(" ")
      : args.join(" ");
    console.log(
      `[session ${this.id}] spawn: ${file} ${argsForLog} (cwd=${this.effectiveCwd()}${scopeUnit === null ? "" : `, scope=${scopeUnit}`})`,
    );

    if (this._recorder) {
      this._recorder.writeHeader({
        agent: this.agentId,
        hooksInjected: this._hooks.hasInjection(),
        cols: ptySize.cols,
        rows: ptySize.rows,
      });
    }

    this._driver.streamOutput();
    this._deliverPtyInitialPrompt(launchPrompt);
    this._armResumeNoteFallback();
    this._armPromptSupervisionLine();
  }

  _inputReadyCondition(): InputReadyCondition | undefined {
    const condition = this._adapter.inputReady;
    if (condition === "startup-hook" && !this._hooks.hasInjection()) return undefined;
    return condition;
  }

  isBetweenTurns(): boolean {
    return BETWEEN_PROMPT_STATES.has(this.state) || this._isTurnEndHeldForBackgroundWork();
  }

  _isTurnEndHeldForBackgroundWork(): boolean {
    return this.state === STATES.RUNNING && this.backgroundTracking.heldReady() !== null;
  }

  _isAgentReadyForChat(): boolean {
    return this._startupSignals.has("ready") || this._inputReadyCondition() === undefined;
  }

  _noteInputReady(): void {
    this._startupSignals.add("ready");
    this._clearTimer("_inputReadyFallbackTimer");
    if (this.state === STATES.STARTING) this.transition("first_output");
    this._chatOutbox.drain();
  }

  _armInputReadyFallback(): void {
    this._armTimer("_inputReadyFallbackTimer", this._titleQuietFallbackMs, () => {
      if (this._destroyed || this.state !== STATES.STARTING) return;
      const waitedSeconds = Math.round(this._titleQuietFallbackMs / 1000);
      if (this._inputReadyCondition() !== "startup-hook") {
        console.warn(`[session:${this.name}] the agent showed no input-ready signal within ${waitedSeconds}s of first output - treating it as ready to take input`);
        this._noteInputReady();
        return;
      }
      console.warn(`[session:${this.name}] the agent showed no input-ready signal within ${waitedSeconds}s of first output - showing the session as idle (detection is degraded); Chat keeps holding messages until the signal arrives`);
      this.transition("first_output");
    }, { unref: true });
  }

  _armResumeNoteFallback(): void {
    this._promptNotes.armResumeNoteFallback(this._titleQuietFallbackMs, (resumeNote) => {
      if (this._destroyed || !this._ptyAlive) return;
      this._promptNotes.dropResumeNote();
      console.warn(`[session:${this.name}] no turn started from the resume note within ${Math.round(this._titleQuietFallbackMs / 1000)}s - pasting it into the terminal`);
      this.deliver(resumeNote, { when: "ready", submit: true });
    });
  }

  _armPromptSupervisionLine(): void {
    this._promptNotes.armSupervision(this._canRunHelpCommand, this.ephemeral, this._launch.packLaunch?.contextLines ?? []);
  }

  promptContextReply(): PromptContextReply | null {
    return this._adapter.promptContextReply ?? null;
  }

  noteCommandRan(command: string): void {
    this._promptNotes.noteCommandRan(command);
  }

  takeCommandHint(event: string, payload: Record<string, unknown>, answers: (command: HintedCommand) => boolean): CommandHint | null {
    return this._promptNotes.takeCommandHint(event, payload, answers);
  }

  pendingResumeNote(): string | null {
    return this._promptNotes.pendingResumeNote();
  }

  takeResumeNote(): string | null {
    return this._promptNotes.takeResumeNote();
  }

  takePromptNotes(keepsHint: (command: HintedCommand) => boolean): string[] {
    return this._promptNotes.takePromptNotes(keepsHint);
  }

  _deliverPtyInitialPrompt(prompt: string | null): void {
    if (!prompt || !this._can("ptyInitialPrompt")) return;
    this.deliver(prompt, { when: "ready", submit: true });
  }

  _resumeAfterStartSettles(heldState: string, generation: number, accept: () => boolean): void {
    const settle = this._startPending ?? Promise.resolve();
    void settle.finally(() => {
      if (this._destroyed || this.state !== heldState || this._startGeneration !== generation) return;
      if (!accept()) return;
      void this.start();
    });
  }

  _resumeHeldPackMcpLaunch(launch: PackMcpLaunch, heldState: string, generation: number): void {
    this._resumeAfterStartSettles(heldState, generation, () => {
      this._launch.acceptApprovedPackMcpLaunch(launch);
      return true;
    });
  }

  _resumeHeldLaunch(outcome: LaunchSecretsOutcome, heldState: string, generation: number): void {
    this._resumeAfterStartSettles(heldState, generation, () => {
      if ("refusal" in outcome) {
        this._abandonSpawn(new Error(outcome.refusal));
        return false;
      }
      this._launch.acceptApprovedLaunchSecrets(outcome.valuesByName);
      return true;
    });
  }

  _watchSandboxLogin(): void {
    const awaitLoginProof = this._launch.sandboxLoginProof();
    if (awaitLoginProof === null) return;
    const generation = this._startGeneration;
    void awaitLoginProof().then((reason) => {
      if (reason === null || this._destroyed || generation !== this._startGeneration) return;
      this._stopReason = reason;
      this._emitError(new Error(reason));
      this._launch.clearApprovedLaunches();
      this.kill();
    });
  }

  _abandonSpawn(cause: unknown): void {
    this._startGeneration += 1;
    this._launch.clearApprovedLaunches();
    this._hooks.deactivateSaneYolo();
    this._hooks.cleanup();
    this._launch.disposeSandbox();
    this._approvals.releaseAll();
    this.transition("spawn_fail", { error: errorMessage(cause) });
    this.emit("error", cause);
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
    if (this._titleGate !== "quiet") return;
    this._armTimer("_titleQuietFallbackTimer", this._titleQuietFallbackMs, () => {
      if (this._destroyed || this._titleGate !== "quiet") return;
      if (this.hookSeen) return;
      console.warn(`[session:${this.name}] no hook callback within ${Math.round(this._titleQuietFallbackMs / 1000)}s - opening the title tier (detection is degraded)`);
      this._titleGate = "open";
      this._recordDecision({ kind: "title-latch", ts: clock.nowMs(), decision: "fallback-open", reason: "no hook callback before the deadline" });
    }, { unref: true });
  }

  _handlePtyData(data: string): void {
    this._driver.handleOutput(data);
  }

  _noteOutput(data: string): void {
    if (this._recorder) {
      this._recorder.writeData(data);
    }
    if (this.state === STATES.STARTING && !this._startupSignals.has("output")) {
      this._startupSignals.add("output");
      this._armInputReadyFallback();
    }
  }

  _feedTitle(data: string): void {
    try {
      this._titleSource.feed(data);
    } catch (err) {
      console.error(`[session:${this.name}] title source error: ${errorMessage(err)}`);
    }
  }

  _onDriverEvent(event: DriverEvent): void {
    if (event.kind === "output") {
      if (this.listenerCount("data") > 0) this.emit("data", event.data);
      return;
    }
    if (event.kind === "exit") void this._handleSpawnedPtyExit(event.exitCode, event.signal);
  }

  _isExitHeadedForFailure(event: string): boolean {
    if (this.state === STATES.FAILED) return false;
    const stateTransitions: Partial<Record<string, string>> | undefined = TRANSITIONS[this.state];
    return stateTransitions?.[event] === STATES.FAILED;
  }

  _handleSpawnedPtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    this._launch.disposeSandbox();
    this._approvals.releaseAll();
    return this._handlePtyExit(exitCode, signal);
  }

  async _handlePtyExit(exitCode: number, signal: ExitSignal): Promise<void> {
    const exitedPty = this._driver.currentHandle();
    this._resetDetectionSources({ quiet: false, clearTracking: true });
    this._dispatchAttention({ type: "teardown" });

    this._hooks.cleanup();
    this._driver.markExited();
    this._driver.forget();
    this._lastClaudeSessionReport = null;
    this._promptNotes.dropResumeNote();

    if (exitedPty?.pid) {
      this._reaper.exitReap = this._reaper.reapTreeOnce(exitedPty.pid, exitedPty.scopeUnit);
    }

    const { event, detail } = decideExitTransition(this.state, exitCode, signal, this._startupSignals.has("output"), this._stopReason);
    const reason = detail.reason || null;
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
    return this._driver.ptySize();
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

    if (!this._driver.write(text)) return;
    if (!isPromptSubmit(text)) return;
    if (isComposerSubmit(text, this.state)) this._output.forgetUnsubmittedComposerPaste();
    this._observeCompaction("resume");
    this._titleGate = "open";
  }

  queueChatMessage(text: string, attachments: readonly string[] = [], origin: ChatOutboxOrigin = "operator") { return this._chatOutbox.queue(text, attachments, origin); }

  cancelChatMessage(entryId: string): ChatOutboxEntry[] { return this._chatOutbox.cancel(entryId); }
  noteChatPromptRecorded() { this._chatOutbox.noteTurnTaken(); }
  takenChatEntryIds(): string[] { return this._chatOutbox.takenEntryIds(); }
  settleUnrecordedChatPrompts(entryIds: readonly string[]) { this._chatOutbox.settleUnrecordedPrompts(entryIds); }

  stopFromChat(sendNextEntryId?: string): void {
    const isTurnEndHeldForBackgroundWork = this._isTurnEndHeldForBackgroundWork();
    if (sendNextEntryId !== undefined) {
      const isTurnRunning = this.state === STATES.RUNNING || isTurnEndHeldForBackgroundWork;
      if (!isTurnRunning || !this._chatOutbox.sendNext(sendNextEntryId)) return;
      if (isTurnEndHeldForBackgroundWork) {
        this._chatOutbox.drain();
        return;
      }
    }
    if (isTurnEndHeldForBackgroundWork) {
      const isStopAlreadyAsked = this._chatOutbox.entries().some((entry) => entry.origin === "stop-background" && entry.state !== "failed");
      if (!isStopAlreadyAsked) this._chatOutbox.queue(STOP_BACKGROUND_WORK_TEXT, [], "stop-background");
      return;
    }
    this.write(LONE_ESCAPE);
    this.noteOperatorInput(LONE_ESCAPE);
  }

  get isWaitingOnRateLimit(): boolean {
    return this.state === STATES.WAITING && this._pendingPromptKind === RATE_LIMIT_PROMPT_KIND;
  }

  noteUsageLimit(usageLimit: UsageLimit): void {
    if (usageLimit.resetsAtMs <= clock.nowMs()) return;
    this._setUsageLimit(usageLimit);
  }

  _setUsageLimit(usageLimit: UsageLimit | null): void {
    this._usageLimit = usageLimit;
    this.emit("usage-limit-change", { usageLimit });
  }

  get chatOutboxEntries() { return this._chatOutbox.entries(); }

  adoptChatOutbox(carriedEntries: readonly ChatOutboxEntry[]): void { this._chatOutbox.adopt(carriedEntries); }

  get chatUploadsDirectory(): string | null { return this._chatUploadsDirectory; }

  chatAttachmentPrefixOf(entry: ChatOutboxEntry): string | null {
    const uploadsDirectory = this._chatUploadsDirectory;
    if (entry.attachments.length === 0 || uploadsDirectory === null) return null;
    return entry.attachments.map((fileName) => path.join(uploadsDirectory, fileName)).join(" ");
  }

  deliverChatEntry(entry: ChatOutboxEntry, onSettled: DeliverOptions["onSettled"]): { ok: boolean; reason?: string } {
    if (entry.attachments.length === 0) return this.deliverOperatorText(entry.text, onSettled);
    const pastedPrefix = this.chatAttachmentPrefixOf(entry);
    if (pastedPrefix === null) return { ok: false, reason: "this session keeps no uploads" };
    return this.deliverOperatorText([pastedPrefix, entry.text].filter((part) => part.length > 0).join(" "), onSettled);
  }

  deliverOperatorText(text: string, onSettled?: DeliverOptions["onSettled"]): ReturnType<Session["deliver"]> {
    this._approvals.yieldManagerDecisions();
    this.emit("operator-input");
    return this.deliver(text, { when: "ready", submit: true, onSettled });
  }

  startSignIn(onSettled: NonNullable<DeliverOptions["onSettled"]>): ReturnType<Session["deliver"]> | null {
    const loginCommand = LOGIN_COMMAND_BY_AGENT[this.agentId];
    if (!loginCommand) return null;
    this._applyWaitingInputDecision(loginCommand);
    return this.deliverOperatorText(loginCommand, onSettled);
  }

  noteOperatorDraft(): void {
    this._lastOperatorInputAt = clock.nowMs();
    this._approvals.yieldManagerDecisions();
    this.emit("operator-input");
  }

  noteOperatorInput(input: string): void {
    if (isOperatorKeystroke(input)) {
      this._lastOperatorInputAt = clock.nowMs();
      this._approvals.yieldManagerDecisions();
      this.emit("operator-input");
    }
    this._applyWaitingInputDecision(input);
  }

  _applyWaitingInputDecision(input: string): void {
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
    if (this._recorder) {
      this._recorder.writeResize(cols, rows);
    }
    const resizeSeq = this._driver.resize(cols, rows);
    if (resizeSeq === null) return;
    this.emit("resize", { cols, rows, seq: resizeSeq });
  }

  _emitError(err: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  kill(): void {
    if (!this._driver.process) return;
    this._promptNotes.dropResumeNote();
    this._driver.stop();
  }

  dismiss(): boolean {
    const hadUnseenOutcome = this.unseenOutcome !== null;
    const hadAttentionNotes = this.attentionNotes.length > 0;
    this._setUnseenOutcome(null);
    this._dispatchAttention({ type: "dismiss" });
    if (!DISMISSIBLE_STATES.has(this.state)) return hadUnseenOutcome || hadAttentionNotes;
    if (this.state === STATES.WAITING && isWaitingOnHookRaisedPrompt(this._can("hooks") && this._can("awaitingInput"), this._pendingPromptKind)) {
      this.emit("waiting-input-acknowledged");
      return true;
    }
    if (this.state === STATES.WAITING && this._pendingPromptKind === CHECK_TERMINAL_PROMPT_KIND) return this.transition("check_terminal_dismiss");
    return this.transition("user_dismiss");
  }

  _setPassedQuestionSeq(seq: number): void {
    if (seq === this.passedQuestionSeq) return;
    this.passedQuestionSeq = seq;
    this.emit("passed-question-change", { passedQuestionSeq: seq });
  }

  markManagerDecisionsSeen(throughSeq: number): void {
    const seenSeq = Math.min(throughSeq, this._approvals.latestManagerDecisionSeq);
    if (seenSeq <= this.managerSeenSeq) return;
    this.managerSeenSeq = seenSeq;
    this.emit("manager-seen-change", { managerSeenSeq: seenSeq });
  }

  get accountId(): string | null {
    return this._launch.accountId;
  }

  announceAccountChange(): void {
    this.emit("account-change", { accountId: this.accountId });
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
    this._startGeneration += 1;
    this._launch.clearApprovedLaunches();
    this.kill();
    return this.transition("user_kill");
  }

  restart(options: { fresh?: boolean; conversationId?: string | null } = {}): boolean {
    if (this._destroyed) return false;

    if (this._teardownPending()) return false;
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    this._launch.clearApprovedLaunches();
    this._prepareRestart(options);
    this.transition("user_restart");
    this.start({ fresh: options.fresh === true });
    return true;
  }

  resetToDormant(): boolean {
    if (this._destroyed) return false;
    const did = this.transition("user_reset");
    if (did) {
      this._startGeneration += 1;
      this._launch.clearApprovedLaunches();
      this.worktreeLifecycle.setMergeStatus("none", {}, { emit: false });
    }
    return did;
  }

  snooze(): SnoozeOutcome {
    if (this._destroyed || this._teardownPending()) return { ok: false, reason: "in-progress" };
    if (!this._resumeSessionId) return { ok: false, reason: "no-conversation" };
    if (!this.transition("user_snooze")) return { ok: false, reason: "not-snoozable" };
    this._startGeneration += 1;
    this._launch.clearApprovedLaunches();
    this.kill();
    return { ok: true };
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
      this._startGeneration += 1;
      this._launch.clearApprovedLaunches();
      this._prepareRestart(options);
      this._dispatchTeardown({ kind: "restart_requested", fresh: options.fresh === true, resumePrompt: options.resumePrompt ?? null });
      this.kill();
      this.transition("user_kill");
      return true;
    }
    if (!RESTARTABLE_STATES.includes(this.state)) return false;
    return this.restart(options);
  }

  destroy(cause: SessionEndCause = "removed"): void {
    this.backgroundTracking.stopAnnouncedBackgroundTasks();
    if (!this._dispatchTeardown({ kind: "destroy_requested" })) return;
    this._startGeneration += 1;
    this._launch.clearApprovedLaunches();
    this._chatOutbox.dispose();
    this._agentToken = null;
    this._commitSigningToken = null;
    this._gitCredentialToken = null;
    this._dispatchAttention({ type: "teardown" });

    this._clearPendingPaste();

    this._hooks.cleanup();
    this._approvals.releaseAll();

    this.kill();
    this._launch.disposeSandbox();

    this._reaper.clearKillPoll();
    this._clearTimer("_titleQuietFallbackTimer");
    this._promptNotes.dispose();
    this._clearTimer("_inputReadyFallbackTimer");

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
export type { ClaudeSessionIdEvent, PrepareSandbox, SandboxLaunchFacts, SessionOptions, SnoozeRefusal };
