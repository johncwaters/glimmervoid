import { toMyPrsWireStatus } from './github/core/my-prs-core.ts';
import type { IssuesStatus } from '../shared/contracts/issues.ts';
import { createKeyedSerialQueue } from './spawn-gate.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import type { GithubPollingRefreshResult, GithubPrsFreshness } from '../shared/contracts/github-polling.ts';
import type { GithubPrsFrame } from '../shared/contracts/github-prs.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage, RUNTIME_CONFIG_SCALAR_KEYS, ConfigUpdate, configIssueMessage, SHELL_AGENT_ID,
  type ClientMessageOf, type OperatorActionOf, type OperatorSurface, type ServerMessageOf,
} from '../shared/contracts/index.ts';
import { SESSION_NAME_PATTERN, SESSION_NAME_RULE_TEXT, TASK_TITLE_MAX_LENGTH, TaskTitle } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import { claudeProjectsDir, listRepoConversations } from '../session/core/conversation-history.ts';
import type { Session } from '../session/sessions.ts';
import { readSessionSetup } from './session/session-setup-wiring.ts';
import type { ControlSocket } from './backend/backend-websockets.ts';
import { ABORT_CONFIG_SAVE } from './config-store.ts';
import type { ConfigStore, GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord, ReplayLog } from './core/control-replay-core.ts';
import type { TelegramDeliveryControl } from './core/telegram-delivery-core.ts';
import { normalizeClientTrust } from './core/request-trust.ts';
import { mergeSettingsBlock, settingsBlockSpecFor, validateSettingsBlock } from './core/settings-block-core.ts';
import { readPosthogReport } from './radar/radar-report.ts';
import * as radarLaneCore from './radar/core/radar-lane-core.ts';
import { buildGithubIssuePrompt, deriveIssueSessionName } from './github/core/github-issues-core.ts';
import { machineSkipsPermissionsByDefault } from './session/core/session-registry-core.ts';
import { planQuickSession } from './session/core/quick-session-core.ts';
import { nextSuggestedName } from '../shared/session-naming.ts';
import { prKey, prSessionName, prSessionPrompt } from './github/core/team-review-core.ts';
import type { PrSessionCheckout } from './github/team-review-wiring.ts';
import { mergeWorkflowsUpdateOverStored } from './core/workflows-core.ts';
import type { GithubLaneStore } from './github/github-store-wiring.ts';
import { githubStoreRateLimitedError } from './github/github-store-poller.ts';
import { buildSettingsPayload as buildSettingsPayloadFrom } from './settings-payload.ts';
import { RESUME_ID_RE } from '../session/core/auto-resume.ts';
import { listDroppedRepoPaths, planWorkspace, planWorkspaceMembers } from '../session/core/workspace-core.ts';
import { runGit } from './git/git-exec.ts';
import { firstGitErrorLine } from './core/branch-sync-core.ts';
import { DEFAULT_AGENT_ID, describeAgentResolvability, isKnownAgentId, listAgentIds, resetCommandCache } from '../session/adapters/index.ts';
import { suggestRepoRoots } from './repo-root-suggestions.ts';
import { expandTilde } from './usage/core/usage-scan-core.ts';
import { HOOK_EVENT_CATALOG, ID_RE as HOOK_ID_RE, MAX_TIMEOUT_SEC as HOOK_MAX_TIMEOUT_SEC, normalizeHook, rawStoredHooks, readStoredHooks, removeHook, upsertHook } from '../session/core/user-hooks-core.ts';
import { describeBuiltinHooks } from '../detection/settings-injector.ts';
import { PlanDecision } from '../shared/contracts/plan-review.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';
import type { ChangeMap } from '../shared/contracts/change-map.ts';
import { CLIENT_LOG_SCOPE_MAX_CHARS, CLIENT_LOG_TEXT_MAX_CHARS } from '../shared/contracts/control-messages.ts';
import type { GithubTeam, KeptWorkPath } from '../shared/contracts/control-messages.ts';
import { sanitizeOneLine, showHomeAsTilde } from './core/text-core.ts';
import { TeamReviewActionRequest } from '../shared/contracts/team-review.ts';
import { CommunityActionRequest } from '../shared/contracts/community.ts';
import type { CommunityActionResult } from '../shared/contracts/community.ts';
import { BenchmarkActionRequest } from '../shared/contracts/benchmark.ts';
import type { BenchmarkActionResult, BenchmarkStatus } from '../shared/contracts/benchmark.ts';
import type { FeatureHintsWiring } from './feature-hints-wiring.ts';
import type { TeamReviewActionResult, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { MyPrKeepMergeableRequest, MyPrMergeRequest, MyPrMergeWhenReadyRequest } from '../shared/contracts/my-prs.ts';
import type { MyPrKeepMergeableResult, MyPrMergeResult, MyPrMergeWhenReadyResult, MyPrsSnapshot } from '../shared/contracts/my-prs.ts';
import { manualPrLink } from '../session/core/session-pr-links-core.ts';
import type { UpdateStatus } from './backend/backend-update.ts';
import type { UpdateApplyOutcome } from './update-apply.ts';
import type { PlanReadRequest, PlanReadResult } from './plan-review-wiring.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { WhiteboardPort } from './whiteboard/whiteboard-wiring.ts';
import type { CoherenceSessionFeed } from './coherence/coherence-session-feed.ts';
import type { TracePage, TracePageRequest } from './trace-wiring.ts';
import { createChangeMapService } from './change-map/change-map-wiring.ts';
import { createChangesWatch } from './changes-watch.ts';
import type { Telemetry } from './telemetry.ts';
import { DashboardTelemetryReport } from '../shared/contracts/telemetry.ts';
import { errorCode, errorMessage, isMissingFileError } from '../shared/text.ts';
import { isRecord } from '../shared/coerce.ts';
import { sanitizeWorktreeName } from '../shared/paths.ts';
import type { createCoderEnvWiring } from './coder/coder-env-wiring.ts';
import type { createAgentConnect } from './agent-login/agent-connect.ts';
import type { RemoteSetupAgent, RemoteSetupOutcome } from './remote-setup-wiring.ts';
import type { GitWorkspaceInstance } from './git/git-workspace.ts';
import { configuredIntegrationBranch } from './core/integration-branch-core.ts';

type ControlRequest = ClientMessage;
type ControlHandler<Type extends ClientMessage['type']> = (msg: ClientMessageOf<Type>, ws: ControlSocket) => unknown;

interface RadarLaneStatus {
  projects?: unknown;
  [key: string]: unknown;
}

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

interface RadarFixControl {
  pendingFixFor: (id: string) => { record: radarLaneCore.InvestigationRecord; fix: radarLaneCore.PendingFix } | null;
  settlePendingFix: (id: string, options: { releaseBranch: boolean }) => Promise<{ ok: boolean; error?: string }>;
}

interface CommunityActionControl {
  submitAction(request: CommunityActionRequest): Promise<Omit<CommunityActionResult, 'key'>>;
  sessionPromptFor(key: string): { ok: true; title: string; prompt: string } | { ok: false; error: string };
}

interface TeamReviewActionControl {
  refresh?: () => Promise<GithubPollingRefreshResult>;
  isRunning(): boolean;
  submitAction(request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome>;
  preparePrSession?(key: string): Promise<PrSessionCheckout>;
}

interface MyPrMergeControl {
  refresh?: () => Promise<GithubPollingRefreshResult>;
  mergePr(request: MyPrMergeRequest): Promise<Omit<MyPrMergeResult, 'key'>>;
  setKeepMergeable?: (request: MyPrKeepMergeableRequest) => Promise<Omit<MyPrKeepMergeableResult, 'key'>>;
  setMergeWhenReady?: (request: MyPrMergeWhenReadyRequest) => Promise<Omit<MyPrMergeWhenReadyResult, 'key'>>;
}

interface BenchmarkControl {
  getStatus(): BenchmarkStatus;
  submitAction(request: BenchmarkActionRequest): Promise<BenchmarkActionResult>;
}

interface ControlHandlerDeps {
  sessions: Map<string, Session>;
  agentSessions?: Map<string, Session>;
  markChildWorktreeDiscard?: ((childId: string) => void) | null;

  makeSession?: (project: ProjectEntry, config: GlimmervoidConfig) => Session;
  wireSessionEvents?: (session: Session) => void;
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  broadcastControl: (message: ControlMessageRecord) => void;
  generateProjectId: () => string;
  applyConfigReload: (config: GlimmervoidConfig) => void;
  applySettingsReload: (config: GlimmervoidConfig) => void;
  requestShutdown?: (() => unknown) | null;
  requestRestart?: (() => unknown) | null;
  handleClientFocus?: ((socket: ControlSocket, focused: boolean) => void) | null;
  buildHealthSnapshot?: (() => unknown) | null;
  getUpdateStatus?: (() => UpdateStatus | null) | null;
  getUpdateJournal?: (() => UpdateJournal | null) | null;
  getPostTurnLeftoversNotice?: (() => ServerMessageOf<'post-turn-leftovers'> | null) | null;
  recheckPostTurnLeftovers?: (() => void) | null;
  checkNow?: (() => Promise<UpdateStatus>) | null;
  applyUpdate?: (() => Promise<UpdateApplyOutcome>) | null;
  noteRestartRequested?: (() => void) | null;
  getRadarStatus?: (() => RadarLaneStatus | null) | null;
  posthogReportsDir?: string | null;
  posthogSetIssueStatus?: ((args: { projectId: string; issueId: string; action: string }) => Promise<Record<string, unknown>>) | null;
  radarArchiveInvestigation?: ((args: { id: string }) => Promise<Record<string, unknown>>) | null;
  radarFixes?: RadarFixControl | null;
  getTeamReviewStatus?: (() => TeamReviewStatus | null) | null;
  getCommunityStatus?: (() => Record<string, unknown> | null) | null;
  community?: CommunityActionControl | null;
  getMyPrsStatus?: (() => MyPrsSnapshot | null) | null;
  getIssuesStatus?: (() => IssuesStatus | null) | null;
  githubStore?: { snapshotMessage: () => GithubPrsFrame; getFreshness: () => GithubPrsFreshness } | null;
  issues?: { refresh: () => Promise<GithubPollingRefreshResult>; getLinkedSessionId?: (issueKey: string) => Promise<string | null>; linkSession?: (issueKey: string, sessionId: string) => Promise<void> } | null;
  teamReview?: TeamReviewActionControl | null;
  myPrs?: MyPrMergeControl | null;
  getBenchmarkStatus?: (() => BenchmarkStatus | null) | null;
  benchmarks?: BenchmarkControl | null;
  requestIssue?: GithubLaneStore['requestIssue'];
  requestViewer?: GithubLaneStore['requestViewer'];
  requestViewerTeams?: GithubLaneStore['requestViewerTeams'];
  issueProjectRepos?: ((projectId: string) => Promise<string[]>) | null;
  serverBuild?: () => string | null;
  getUsageSessions?: (() => unknown) | null;
  getUsageReport?: (() => unknown) | null;
  requestUsageReport?: ((args: { days?: number; force?: boolean; requestId?: string | null }) => Promise<unknown>) | null;
  getPlanLimits?: (() => readonly unknown[]) | null;
  controlReplayLog?: ReplayLog | null;
  telegramDelivery?: TelegramDeliveryControl | null;
  conversationFs?: typeof fs;
  conversationGit?: (args: string[], cwd: string) => Promise<string>;
  conversationProjectsDir?: string;
  readTracePage?: ((glimmervoidSessionId: string, request: TracePageRequest) => Promise<TracePage>) | null;
  readPlanRevision?: ((sessionId: string, request: PlanReadRequest) => Promise<PlanReadResult | null>) | null;
  decidePlanReview?: ((sessionId: string, decision: PlanDecision) => string | null) | null;
  sessionDocs?: SessionDocsPort | null;
  whiteboards?: Pick<WhiteboardPort, 'handleOperator'> | null;
  coherenceFeed?: Pick<CoherenceSessionFeed, 'readJournal'> | null;
  telemetry?: (Pick<Telemetry, 'captureException' | 'captureClientError'> & Partial<Pick<Telemetry, 'capture' | 'requestDataDeletion'>>) | null;
  coderEnv?: Pick<ReturnType<typeof createCoderEnvWiring>, 'reserve' | 'provision' | 'renew' | 'availableEnvironments' | 'settleRemoval'> | null;
  agentConnect?: Pick<ReturnType<typeof createAgentConnect>, 'logins' | 'refresh' | 'start' | 'cancel' | 'submitCode'> | null;
  remoteSetup?: { start: (agent: RemoteSetupAgent) => Promise<RemoteSetupOutcome> } | null;
  remoteRepoGit?: Pick<GitWorkspaceInstance, 'originUrl' | 'detectDefaultBranch'> | null;
  featureHints?: Pick<FeatureHintsWiring, 'noteViewShown' | 'settle' | 'pendingHintMessage'> | null;
}

type AddSessionRefusal = { error: string };
type AddSessionRequest = ClientMessageOf<'add-session'> & { runSettings?: Partial<ProjectEntry> };

function scanRepoRoots(roots: string[] | undefined): { root: string; projects: { name: string; path: string }[] }[] {
  const results: { root: string; projects: { name: string; path: string }[] }[] = [];
  if (!roots) return results;
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) {
        results.push({ root, projects: [] });
        continue;
      }
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const projects = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => ({ name: d.name, path: path.join(root, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      results.push({ root, projects });
    } catch (err) {
      console.warn(`[settings] Failed to scan root: ${root}: ${errorCode(err) || errorMessage(err)}`);
      results.push({ root, projects: [] });
    }
  }
  return results;
}

const SETTINGS_NOT_SAVED_MESSAGE = 'Settings were not saved: the config file could not be read, validated or written.';

function settingsNotSavedText(failureReason: string | null): string {
  if (failureReason === null) return SETTINGS_NOT_SAVED_MESSAGE;
  return `Settings were not saved. ${failureReason}`;
}
const WORKFLOWS_SETTINGS_KEY = 'workflows';

type IncomingSettingsBlock = readonly [key: string, block: Record<string, unknown>];

function incomingSettingsBlocks(incoming: Record<string, unknown>): IncomingSettingsBlock[] {
  return Object.entries(incoming)
    .filter((entry): entry is [string, Record<string, unknown>] => entry[0] !== WORKFLOWS_SETTINGS_KEY && isRecord(entry[1]));
}

function incomingSettingsBlocksError(blocks: readonly IncomingSettingsBlock[]): string | null {
  for (const [key, block] of blocks) {
    const error = validateSettingsBlock(block, settingsBlockSpecFor(key));
    if (error) return error;
  }
  return null;
}

const USAGE_REPORT_MAX_DAYS = 3650;
const CONVERSATION_HISTORY_GIT_TIMEOUT_MS = 20000;

async function runGitForConversationHistory(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: CONVERSATION_HISTORY_GIT_TIMEOUT_MS, trim: false });
  if (!result.ok) throw result.error;
  return result.out;
}

function missingFolderError(folderPath: string): string {
  return `No folder at ${folderPath}. It may have been moved or renamed; pick it again or enter its current path.`;
}

function sendError(ws: ControlSocket, message: string, { type = 'error', requestId, id, scope }: { type?: string; requestId?: string | null; id?: string; scope?: string } = {}): void {
  const payload = {
    type,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(id ? { id } : {}),
    ...(scope ? { scope } : {}),
    message,
  };
  ws.send(JSON.stringify(payload));
}

const SESSION_GONE_TEXT = 'That session no longer exists. Reload the page to refresh the session list.';
const UNREADABLE_REQUEST_TEXT = 'The server could not read a request from this page, most likely because the page is older than the server. Reload the page.';

function myPrMergeKey(msg: Record<string, unknown> | null | undefined): string {
  return typeof msg?.repo === 'string' && typeof msg.number === 'number' ? prKey(msg.repo, msg.number) : '';
}

function requestValidationErrorReply(msg: Record<string, unknown> | null | undefined, message: string): Record<string, unknown> | null {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const builders: Record<string, () => Record<string, unknown>> = {
    'list-conversations': () => ({ type: 'conversations', requestId, id: typeof msg?.id === 'string' ? msg.id : null, conversations: [], error: message }),
    'resume-conversation': () => ({ type: 'resume-conversation-ack', requestId, id: typeof msg?.id === 'string' ? msg.id : undefined, ok: false, error: message }),
    'ping': () => ({ type: 'pong', requestId, error: message }),
    'get-settings': () => ({ type: 'settings-error', requestId, message }),
    'get-agent-logins': () => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'agent-connect': () => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'start-remote-setup': () => ({ type: 'start-remote-setup-result', requestId, ok: false, error: message }),
    'agent-connect-code': () => ({ type: 'agent-logins', requestId, logins: [], error: message }),
    'update-settings': () => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': () => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'list-agents': () => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'list-github-teams': () => ({ type: 'github-teams-listed', requestId, viewer: null, teams: [], error: message }),
    'get-radar-report': () => ({ type: 'radar-report', requestId, ok: false, found: false, issueId: null, error: message }),
    'radar-open-session': () => ({ type: 'radar-open-session-result', requestId, ok: false, error: message }),
    'issue-detail': () => ({ type: 'issue-detail-result', requestId, ok: false, body: null, error: message }),
    'open-issue-session': () => ({ type: 'open-issue-session-result', requestId, ok: false, error: message }),
    'open-team-review-session': () => ({ type: 'open-team-review-session-result', requestId, ok: false, error: message }),
    'radar-issue-action': () => ({ type: 'radar-issue-action-result', requestId, ok: false, error: message }),
    'radar-archive-investigation': () => ({ type: 'radar-archive-investigation-result', requestId, ok: false, error: message }),
    'radar-approve-fix': () => ({ type: 'radar-approve-fix-result', requestId, ok: false, error: message }),
    'radar-dismiss-fix': () => ({ type: 'radar-dismiss-fix-result', requestId, ok: false, error: message }),
    'telegram-test': () => ({ type: 'telegram-test-result', requestId, ok: false, error: message, telegramDelivery: null }),
    'team-review-action': () => ({ type: 'team-review-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'community-action': () => ({ type: 'community-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'open-community-session': () => ({ type: 'open-community-session-result', requestId, ok: false, error: message }),
    'github-polling-refresh': () => ({ type: 'github-polling-refresh-result', requestId, ok: false, error: message }),
    'my-pr-merge': () => ({ type: 'my-pr-merge-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-keep-mergeable': () => ({ type: 'my-pr-keep-mergeable-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-merge-when-ready': () => ({ type: 'my-pr-merge-when-ready-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'benchmark-action': () => ({ type: 'benchmark-action-result', requestId, suiteId: typeof msg?.suiteId === 'string' ? msg.suiteId : '', action: typeof msg?.action === 'string' ? msg.action : 'run', ok: false, error: message }),
    'request-usage-report': () => ({ type: 'usage-report', requestId, error: message }),
    'request-hooks-report': () => ({ type: 'hooks-report', requestId, error: message }),
    'whiteboard-create': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-op': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-delete': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-get': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-connect': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-disconnect': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'whiteboard-nudge': () => ({ type: 'whiteboard-result', requestId, ok: false, error: message }),
    'save-hook': () => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'add-session': () => ({ type: 'add-session-result', requestId, ok: false, error: message }),
    'quick-session': () => ({ type: 'add-session-result', requestId, ok: false, error: message }),
    'remove-session': () => ({ type: 'remove-session-result', requestId, ok: false, error: message }),
    'delete-hook': () => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
    'session-doc-read': () => ({ type: 'session-doc-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-doc-save': () => ({ type: 'session-doc-save-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-coherence-journal': () => ({ type: 'session-coherence-journal-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, entries: [], error: message }),
    'session-setup': () => ({ type: 'session-setup-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  };
  const requestType = typeof msg?.type === 'string' ? msg.type : '';
  if (Object.hasOwn(builders, requestType)) return builders[requestType]();
  const genericErrorRequests = new Set([
    'request-session-diff',
    'request-change-map',
    'request-branch-sync',
    'resync-branch',
    'debug-state',
    'session-trace',
    'session-plan',
    'plan-decision',
    'request-health-snapshot',
  ]);
  if (genericErrorRequests.has(requestType)) return { type: 'error', message: UNREADABLE_REQUEST_TEXT };
  return null;
}

function parseSinceParam(url: string | undefined): number | null {
  if (!url) return null;
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return null;
  const raw = new URLSearchParams(url.slice(qIndex + 1)).get('since');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function registerControlHandlers(controlWss: WebSocketServer, deps: ControlHandlerDeps) {
  const {
    sessions,
    agentSessions = new Map<string, Session>(),
    markChildWorktreeDiscard = null,
    config,
    configStore,
    broadcastControl,
    generateProjectId,
    applyConfigReload,
    applySettingsReload,
    requestShutdown,
    requestRestart,
    handleClientFocus,
    buildHealthSnapshot,
    getUpdateStatus,
    getUpdateJournal = null,
    getPostTurnLeftoversNotice = null,
    recheckPostTurnLeftovers = null,
    featureHints = null,
    checkNow = null,
    applyUpdate = null,
    noteRestartRequested = null,

    getRadarStatus,
    posthogReportsDir = null,

    posthogSetIssueStatus = null,
    radarArchiveInvestigation = null,
    radarFixes = null,
    getTeamReviewStatus = null,
    getCommunityStatus = null,
    community = null,
    getMyPrsStatus = null,
    getIssuesStatus = null,
    githubStore = null,
    issues = null,
    teamReview = null,
    myPrs = null,
    getBenchmarkStatus = null,
    benchmarks = null,

    requestIssue = async () => ({ isRateLimited: false, value: { ok: false, issue: null, error: 'Issues polling is not running.' } }),
    requestViewer = async () => ({ isRateLimited: false, value: null }),
    requestViewerTeams = async () => ({ isRateLimited: false, value: null }),
    issueProjectRepos = null,

    serverBuild = () => null,

    getUsageSessions = null,
    getUsageReport = null,
    requestUsageReport = null,
    getPlanLimits = null,

    controlReplayLog = null,

    telegramDelivery = null,

    conversationFs = fs,
    conversationGit = runGitForConversationHistory,
    conversationProjectsDir = claudeProjectsDir(process.env, os.homedir()),
    readTracePage = null,
    readPlanRevision = null,
    decidePlanReview = null,
    sessionDocs = null,
    whiteboards = null,
    coherenceFeed = null,
    coderEnv = null,
    remoteRepoGit = null,
    agentConnect = null,
    remoteSetup = null,
  } = deps;

  const changeMaps = createChangeMapService({ sessions });
  const changesWatch = createChangesWatch<ControlSocket>({
    findSession: (id) => sessions.get(id) ?? agentSessions.get(id) ?? null,
    isHolderOpen: (ws) => ws.readyState === 1,
  });

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, telegramDelivery: telegramDelivery?.status() ?? null, coderEnvironments: coderEnv?.availableEnvironments() ?? null, agentLogins: agentConnect?.logins() ?? null });
  }

  function findSession(msg: Pick<ClientMessageOf<'kill'>, 'id'>): Session | null {
    if (!msg.id) return null;
    return sessions.get(msg.id) ?? agentSessions.get(msg.id) ?? null;
  }

  const MERGE_REFUSAL_COPY: Record<string, string> = {
    'destroyed':         'session no longer exists',
    'no-worktree':       'no worktree to merge',
    'merge-in-progress': 'a merge is already in flight on this worktree',
  };

  function reportMergeRefusal(ws: ControlSocket, s: Session, r: { refused?: boolean; reason?: string | null } | null | undefined): void {
    if (r?.refused !== true) return;
    const detail = r.reason === 'not-continuable'
      ? `session state ${s.state} is not mergeable`
      : ((r.reason ? MERGE_REFUSAL_COPY[r.reason] : '') || r.reason);
    console.log(`[control] merge refused: id=${s.id} state=${s.state} reason=${r.reason}`);
    ws.send(JSON.stringify({ type: 'session-error', id: s.id, session: s.name, message: `Merge refused: ${detail}.` }));
  }

  function buildSnapshot() {
    const list: unknown[] = [];
    for (const [, sess] of sessions) {
      list.push(sess.toSnapshot());
    }
    for (const [, sess] of agentSessions) {
      list.push(sess.toSnapshot());
    }

    return {
      type: 'snapshot', sessions: list, serverBuild: serverBuild(),
    };
  }


  function handleAddSession(request: AddSessionRequest, ws: ControlSocket): Promise<void> | undefined {
    const msg = withShellDefaults(request);
    const refusal = shellAddSessionRefusal(msg) ?? addSessionRefusal(msg);
    if (refusal) {
      refuseAddSession(msg, ws, refusal);
      return undefined;
    }
    const environmentName = typeof msg.environment === 'string' ? msg.environment.trim() : '';
    if (environmentName) return createRemoteAddedSession(msg, ws, environmentName);
    createAddedSession(msg, ws);
    return undefined;
  }

  function handleQuickSession(msg: ClientMessageOf<'quick-session'>, ws: ControlSocket): Promise<void> | undefined {
    const source = findSession(msg);
    if (!source) {
      replyTo(ws, msg, 'add-session-result', { ok: false, error: 'The session to copy no longer exists.' });
      return undefined;
    }
    const plan = planQuickSession({
      live: source,
      project: config.projects.find((project) => project.id === source.id) ?? null,
      sessionNames: liveSessionNames(),
    });
    return handleAddSession({ type: 'add-session', requestId: msg.requestId, ...plan.request, runSettings: plan.runSettings }, ws);
  }

  function createAddedSession(msg: AddSessionRequest, ws: ControlSocket, remote?: { id: string; environment: NonNullable<ProjectEntry['environment']> }): ProjectEntry | null {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();
    const repos = msg.repos;

    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';

    const skipPerms = typeof msg.dangerouslySkipPermissions === 'boolean'
      ? msg.dangerouslySkipPermissions
      : machineSkipsPermissionsByDefault(config);
    const created = createProjectSession({
      id: remote?.id,
      name,
      path: projectPath,
      repos,
      agent: requestedAgent && requestedAgent !== DEFAULT_AGENT_ID ? requestedAgent : undefined,
      dangerouslySkipPermissions: skipPerms,
      saneYolo: skipPerms && msg.saneYolo === true,
      requireExistingPath: !repos,
      environment: remote?.environment,
      runSettings: msg.runSettings,
    });
    if (!created.ok) {
      refuseAddSession(msg, ws, { error: created.error });
      return null;
    }
    if (msg.requestId) replyTo(ws, msg, 'add-session-result', { ok: true, error: null, sessionId: created.project.id });
    console.log(`[control] Added session via UI: ${created.project.name}${skipPerms ? ' (skip permissions)' : ' (permission prompts)'}${remote ? ` (Coder environment ${remote.environment.name})` : ''}`);
    return created.project;
  }

  async function remoteRepoSource(projectPath: string): Promise<{ ok: true; repoRemoteUrl: string; baseBranch: string } | { ok: false; error: string }> {
    if (!remoteRepoGit) return { ok: false, error: 'Coder environments are unavailable on this host' };
    const repoRemoteUrl = await remoteRepoGit.originUrl({ projectPath });
    if (!repoRemoteUrl) return { ok: false, error: `${projectPath} has no origin remote, so a Coder workspace cannot clone it.` };
    const baseBranch = configuredIntegrationBranch(config) ?? await remoteRepoGit.detectDefaultBranch({ projectPath });
    if (!baseBranch) return { ok: false, error: `Could not find the default branch of ${projectPath} on origin.` };
    return { ok: true, repoRemoteUrl, baseBranch };
  }

  async function restartSession(msg: ClientMessageOf<'restart'> | ClientMessageOf<'force-restart'>, ws: ControlSocket, restart: (session: Session, options: { fresh: boolean; conversationId?: string }) => boolean): Promise<void> {
    const sess = findSession(msg);
    if (!sess) return;
    const fresh = msg.fresh === true;
    const conversationId = fresh ? null : requestedConversationId(msg.conversationId);
    if (!conversationId) {
      await renewAndRestart(sess, ws, () => { restart(sess, { fresh }); });
      return;
    }
    const refusal = resumeConversationRefusal(sess, conversationId);
    if (refusal) { sendError(ws, refusal, { id: sess.id }); return; }
    await renewAndRestart(sess, ws, () => {
      if (restart(sess, { fresh, conversationId })) persistResumeConversation(sess.id, conversationId);
    });
  }

  async function renewAndRestart(sess: Session, ws: ControlSocket, restart: () => void): Promise<void> {
    const project = config.projects.find((candidate) => candidate.id === sess.id);
    if (sess.state !== STATES.FAILED || !project?.environment || !coderEnv) {
      restart();
      return;
    }
    const source = await remoteRepoSource(project.path);
    if (!source.ok) {
      sendError(ws, source.error, { id: sess.id });
      return;
    }
    const renewal = await coderEnv.renew({
      projectId: project.id,
      repoRemoteUrl: source.repoRemoteUrl,
      baseBranch: source.baseBranch,
      liveCount: liveWorkspaceCount(project.environment.name, project.id),
    });
    if (!renewal.ok) {
      sendError(ws, renewal.reason, { id: sess.id });
      return;
    }
    restart();
  }

  function liveWorkspaceCount(environmentName: string, excludedProjectId?: string): number {
    return config.projects.filter((project) => {
      if (project.environment?.name !== environmentName) return false;
      if (project.id === excludedProjectId) return false;
      const session = sessions.get(project.id);
      return session !== undefined && session.state !== STATES.DORMANT;
    }).length;
  }

  function remoteAddSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    if (msg.repos) return { error: 'A workspace session cannot run in a Coder environment. Pick a single repository.' };
    if (msg.runInPlace === true) return { error: 'A session in a Coder environment always gets its own checkout, so it cannot run in this folder.' };
    return null;
  }

  async function createRemoteAddedSession(msg: AddSessionRequest, ws: ControlSocket, environmentName: string): Promise<void> {
    const refusal = remoteAddSessionRefusal(msg);
    if (refusal) {
      refuseAddSession(msg, ws, refusal);
      return;
    }
    if (!coderEnv || !remoteRepoGit) {
      refuseAddSession(msg, ws, { error: 'Coder environments are unavailable on this host' });
      return;
    }
    const source = await remoteRepoSource(path.resolve((msg.path || '').trim()));
    if (!source.ok) {
      refuseAddSession(msg, ws, { error: source.error });
      return;
    }
    const { repoRemoteUrl, baseBranch } = source;
    const id = generateProjectId();
    const reserved = await coderEnv.reserve({
      projectId: id,
      environmentName,
      branch: `glimmervoid/session/${sanitizeWorktreeName(id)}`,
      liveCount: liveWorkspaceCount(environmentName),
    });
    if (!reserved.ok) {
      refuseAddSession(msg, ws, { error: reserved.reason });
      return;
    }
    const project = createAddedSession(msg, ws, { id, environment: reserved.mapping });
    if (!project) return;
    void coderEnv.provision({ projectId: id, mapping: reserved.mapping, repoRemoteUrl, baseBranch }).then((provisioned) => {
      if (!provisioned.ok) console.warn(`[control] Coder provision failed for ${project.name}: ${provisioned.reason}`);
    });
  }

  function isShellRequest(msg: AddSessionRequest): boolean {
    return typeof msg.agent === 'string' && msg.agent.trim() === SHELL_AGENT_ID;
  }

  function withShellDefaults(msg: AddSessionRequest): AddSessionRequest {
    if (!isShellRequest(msg)) return msg;
    return { ...msg, path: (msg.path || '').trim() || os.homedir() };
  }

  function shellAddSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    if (!isShellRequest(msg)) return null;
    if (typeof msg.environment === 'string' && msg.environment.trim()) return { error: 'A shell session runs on this machine, so it cannot run in a Coder environment.' };
    if (msg.repos) return { error: 'A shell session runs in one folder, so it cannot span a workspace.' };
    return null;
  }

  function addSessionRefusal(msg: AddSessionRequest): AddSessionRefusal | null {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();
    if (!name || (!projectPath && !msg.repos)) return { error: 'Name and path are required' };
    if (!SESSION_NAME_PATTERN.test(name)) return { error: SESSION_NAME_RULE_TEXT };
    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';
    if (requestedAgent && !isKnownAgentId(requestedAgent)) return { error: `Unknown agent "${requestedAgent}"` };
    const missingRepo = msg.repos?.find((repoPath) => !isExistingDirectory(repoPath));
    if (missingRepo) return { error: missingFolderError(missingRepo) };
    if (msg.repos) return null;
    if (!isExistingDirectory(projectPath)) return { error: missingFolderError(projectPath) };
    return null;
  }

  function refuseAddSession(msg: AddSessionRequest, ws: ControlSocket, refusal: AddSessionRefusal): void {
    console.warn(`[control] add-session refused: name=${sanitizeOneLine(msg.name, CLIENT_LOG_TEXT_MAX_CHARS)} path=${sanitizeOneLine(msg.path, CLIENT_LOG_TEXT_MAX_CHARS)}: ${refusal.error}`);
    if (msg.requestId) {
      replyTo(ws, msg, 'add-session-result', { ok: false, ...refusal });
      return;
    }
    sendError(ws, refusal.error);
  }

  function handleStartSession(msg: ClientMessageOf<'start-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) return;
    if (agentSessions.get(sess.id) === sess) {
      sendError(ws, 'This session is started by the agent that spawned it', { id: sess.id });
      return;
    }
    if (sess.state !== STATES.DORMANT) return;
    sess.start();
  }

  type RemovalRefusal = { ok: false; error: string; canDiscardWork?: boolean; keptPaths?: KeptWorkPath[] };
  type SessionRemoval = { ok: true } | RemovalRefusal;

  const lastRemovalRefusalBySessionId = new Map<string, string>();

  function refuseRemoval(error: string, keptPaths?: KeptWorkPath[]): RemovalRefusal {
    return keptPaths ? { ok: false, error, canDiscardWork: true, keptPaths } : { ok: false, error, canDiscardWork: true };
  }

  function keptWorkRefusal(sess: Session, firstKept: KeptWorkPath, otherKeptCount: number, keptPaths: KeptWorkPath[]): RemovalRefusal {
    const more = otherKeptCount > 0 ? ` and ${otherKeptCount} more` : '';
    return refuseRemoval(`"${sess.name}" has work not saved in ${firstKept.path} (${firstKept.reason})${more}. Removing it deletes that work.`, keptPaths);
  }

  async function findLocalRemovalRefusal(sess: Session, confirmedKeptPaths: ReadonlySet<string>): Promise<RemovalRefusal | null> {
    if (!sess.isWorkspace && await sess.hasUnmergedWork()) {
      return refuseRemoval(`"${sess.name}" has uncommitted changes or commits not merged into its base branch. Removing it deletes them.`);
    }
    const keptPaths = sess.isWorkspace ? await sess.findWorkspaceKeptWork() : [];
    const [firstUnconfirmedKept, ...otherUnconfirmedKept] = keptPaths.filter((kept) => !confirmedKeptPaths.has(kept.path));
    if (firstUnconfirmedKept) return keptWorkRefusal(sess, firstUnconfirmedKept, otherUnconfirmedKept.length, keptPaths);
    if (sess.state === STATES.RUNNING) return refuseRemoval(`"${sess.name}" is working. Removing it stops the agent mid-task.`);
    if (sess.state === STATES.WAITING) return refuseRemoval(`"${sess.name}" is waiting for your input. Removing it stops the agent mid-task.`);
    return null;
  }

  async function removeSession(msg: ClientMessageOf<'remove-session'>): Promise<SessionRemoval> {
    const sess = findSession(msg);
    if (!sess) return { ok: false, error: 'Session not found' };
    const isDiscardingWork = msg.discardWork === true;
    const isDiscardingWorkspaceWork = sess.isWorkspace && isDiscardingWork;
    if (isDiscardingWorkspaceWork) sess.killSession();

    const refusal = await findLocalRemovalRefusal(sess, new Set(isDiscardingWorkspaceWork ? msg.confirmedKeptPaths ?? [] : []));
    const isRefusalConfirmed = isDiscardingWork && refusal?.error === lastRemovalRefusalBySessionId.get(sess.id);
    if (refusal && !isRefusalConfirmed) {
      lastRemovalRefusalBySessionId.set(sess.id, refusal.error);
      return refusal;
    }

    if (agentSessions.get(sess.id) === sess) {
      if (isDiscardingWork) markChildWorktreeDiscard?.(sess.id);
      lastRemovalRefusalBySessionId.delete(sess.id);
      sess.destroy();
      console.log(`[control] Removed spawned session via UI: ${sess.name}`);
      return { ok: true };
    }

    const hasRemoteWorkspace = config.projects.some((project) => project.id === sess.id && project.environment);
    if (hasRemoteWorkspace && coderEnv) {
      sess.killSession();
      const settlement = await coderEnv.settleRemoval({ projectId: sess.id, discardRemoteWork: isDiscardingWork });
      if (!settlement.ok && settlement.canDiscardRemoteWork) return refuseRemoval(`${settlement.reason}. Removing "${sess.name}" deletes its Coder workspace and that work with it.`);
      if (!settlement.ok) return { ok: false, error: settlement.reason, canDiscardWork: false };
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.id !== sess.id);
    });
    if (!freshConfig) return { ok: false, error: `Could not save the removal of session "${sess.name}"` };
    if (isDiscardingWorkspaceWork) sess.confirmWorkspaceWorkDiscard();
    lastRemovalRefusalBySessionId.delete(sess.id);
    applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${sess.name}`);
    return { ok: true };
  }

  async function handleRemoveSession(msg: ClientMessageOf<'remove-session'>, ws: ControlSocket): Promise<void> {
    const removal = await removeSession(msg);
    if (msg.requestId) {
      replyTo(ws, msg, 'remove-session-result', removal.ok ? { ok: true, error: null } : removal);
      return;
    }
    if (!removal.ok) sendError(ws, removal.error);
  }

  function handleRenameSession(msg: ClientMessageOf<'rename-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    const newName = (msg.newName || '').trim();

    if (!sess || !newName) {
      sendError(ws, 'That session no longer exists or the new name was empty. Reload the page, then rename again with a name.');
      return;
    }

    if (sess.ephemeral) { sendError(ws, 'Glimmervoid manages this session itself, so it cannot be renamed.', { id: sess.id }); return; }

    if (!SESSION_NAME_PATTERN.test(newName)) {
      sendError(ws, `${SESSION_NAME_RULE_TEXT}. Pick another name.`, { id: sess.id });
      return;
    }

    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        sendError(ws, `A session named "${newName}" already exists. Pick another name.`, { id: sess.id });
        return;
      }
    }

    if (sess.name === newName) return;

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (project) project.name = newName;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleGetWorkspaceRepos(msg: ClientMessageOf<'get-workspace-repos'>, ws: ControlSocket): void {
    const project = findConfiguredProject(msg.id);
    if (!project?.repos) {
      replyTo(ws, msg, 'workspace-repos', { id: msg.id, ok: false, repos: [], error: 'This session is not a workspace' });
      return;
    }
    replyTo(ws, msg, 'workspace-repos', { id: msg.id, ok: true, repos: project.repos, error: null });
  }

  async function findDroppedMemberWithUncommittedWork(workspaceFolder: string, droppedRepoPaths: string[]): Promise<string | null> {
    for (const repoPath of droppedRepoPaths) {
      const memberName = path.basename(path.resolve(repoPath));
      const memberDir = path.join(workspaceFolder, memberName);
      const memberExists = await fs.promises.stat(memberDir).then(() => true, () => false);
      if (!memberExists) continue;
      const memberStatus = await runGit(['--no-optional-locks', 'status', '--porcelain'], { cwd: memberDir });
      if (!memberStatus.ok) throw memberStatus.error;
      if (memberStatus.out !== '') return memberName;
    }
    return null;
  }

  async function handleSetWorkspaceRepos(msg: ClientMessageOf<'set-workspace-repos'>, ws: ControlSocket): Promise<void> {
    const reply = (error: string | null) => replyTo(ws, msg, 'set-workspace-repos-result', { id: msg.id, ok: error === null, error });
    const project = findConfiguredProject(msg.id);
    const session = sessions.get(msg.id);
    if (!project?.repos || !session) {
      reply('This session is not a workspace');
      return;
    }
    const missingRepo = msg.repos.find((repoPath) => !isExistingDirectory(repoPath));
    if (missingRepo) {
      reply(missingFolderError(missingRepo));
      return;
    }
    const planned = planWorkspaceMembers({ folder: project.path, sessionId: project.id, repoPaths: msg.repos });
    if (!planned.ok) {
      reply(planned.error);
      return;
    }
    const nextRepos = planned.plan.members.map((member) => member.repoPath);
    try {
      const dirtyMemberName = await findDroppedMemberWithUncommittedWork(project.path, listDroppedRepoPaths(project.repos, nextRepos));
      if (dirtyMemberName) {
        reply(`${dirtyMemberName} has uncommitted changes. Commit or discard them before removing it from the workspace.`);
        return;
      }
    } catch (error) {
      reply(`Could not check the workspace for uncommitted changes: ${errorMessage(error)}`);
      return;
    }
    const freshConfig = configStore.save((cfg) => {
      const configured = cfg.projects.find((entry) => entry.id === project.id);
      if (!configured) return ABORT_CONFIG_SAVE;
      configured.repos = nextRepos;
      return undefined;
    });
    if (!freshConfig) {
      reply(`Could not save session "${project.name}"`);
      return;
    }
    applyConfigReload(freshConfig);
    console.log(`[control] Workspace repositories updated via UI: ${project.name} (${nextRepos.length} repos)`);
    reply(null);
  }

  function handleSetSessionTitle(msg: ClientMessageOf<'set-session-title'>, ws: ControlSocket): void {
    const session = findSession(msg);
    const parsedTitle = TaskTitle.safeParse(msg.title);
    if (!session) {
      sendError(ws, SESSION_GONE_TEXT);
      return;
    }
    if (!parsedTitle.success) {
      sendError(ws, `The task was not set: it must be at most ${TASK_TITLE_MAX_LENGTH} characters with no control characters. Shorten it and set it again.`, { id: session.id });
      return;
    }
    if (session.ephemeral) {
      sendError(ws, 'Glimmervoid manages this session itself, so it cannot have a custom task.', { id: session.id });
      return;
    }
    const freshConfig = configStore.save(config => {
      const project = config.projects.find(project => project.id === session.id);
      if (!project) return;
      if (!parsedTitle.data) {
        delete project.customTitle;
        return;
      }
      project.customTitle = parsedTitle.data;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function handleLinkSessionPr(msg: ClientMessageOf<'link-session-pr'>, ws: ControlSocket): void {
    const session = findSession(msg);
    if (!session) {
      sendError(ws, 'Session not found', { id: msg.id });
      return;
    }
    const link = manualPrLink(msg.key, (typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null)?.prs ?? [], Date.now());
    if (!link) {
      sendError(ws, `Not a GitHub pull request: ${msg.key}`, { id: msg.id });
      return;
    }
    session.linkPrManually(link);
  }

  function handleUnlinkSessionPr(msg: ClientMessageOf<'unlink-session-pr'>, ws: ControlSocket): void {
    const session = findSession(msg);
    if (!session) {
      sendError(ws, 'Session not found', { id: msg.id });
      return;
    }
    session.unlinkPr(msg.key);
  }

  async function handleListConversations(msg: ClientMessageOf<'list-conversations'>, ws: ControlSocket): Promise<void> {
    const sess = findSession(msg);
    if (!sess) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: msg.id || null, conversations: [], error: 'Session not found' }));
      return;
    }
    let conversations: unknown[] = [];
    try {
      conversations = await listRepoConversations({
        repoPath: sess.path,
        projectsDir: conversationProjectsDir,
        git: conversationGit,
        fsMod: conversationFs,
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'conversations', requestId: msg.requestId || null, id: sess.id, conversations: [], error: errorMessage(err) }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'conversations',
      requestId: msg.requestId || null,
      id: sess.id,
      current: sess.resumeSessionId || null,
      conversations,
    }));
  }

  function resumeConversationRefusal(sess: Session, conversationId: string | null): string | null {
    if (sess.ephemeral) return 'This session cannot resume a conversation';
    if (conversationId && !RESUME_ID_RE.test(conversationId)) return 'Invalid conversation id';
    return null;
  }

  function persistResumeConversation(sessionId: string, conversationId: string | null): void {
    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sessionId);
      if (!project) return;
      if (conversationId) project.resumeSessionId = conversationId;
      else delete project.resumeSessionId;
    });
    if (freshConfig) applyConfigReload(freshConfig);
  }

  function requestedConversationId(conversationId: unknown): string | null {
    const trimmed = typeof conversationId === 'string' ? conversationId.trim() : '';
    return trimmed || null;
  }

  function handleResumeConversation(msg: ClientMessageOf<'resume-conversation'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
    if (!sess) { sendError(ws, 'Session not found', { requestId }); return; }
    const conversationId = requestedConversationId(msg.conversationId);
    const refusal = resumeConversationRefusal(sess, conversationId);
    if (refusal) { sendError(ws, refusal, { requestId }); return; }

    persistResumeConversation(sess.id, conversationId);

    const live = sessions.get(sess.id) || sess;
    live.setResumeConversation(conversationId);

    ws.send(JSON.stringify({ type: 'resume-conversation-ack', requestId, id: live.id, resumeSessionId: conversationId, ok: true }));
    console.log(`[control] resume-conversation: id=${live.id} -> ${conversationId || '(cleared)'}`);
  }

  function handleGetSettings(msg: ClientMessageOf<'get-settings'>, ws: ControlSocket): void {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
    void agentConnect?.refresh();
  }

  const AGENT_CONNECT_UNAVAILABLE = 'Agent sign-in is not available on this server.';

  async function handleGetAgentLogins(msg: ClientMessageOf<'get-agent-logins'>, ws: ControlSocket): Promise<void> {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    replyTo(ws, msg, 'agent-logins', { logins: await agentConnect.refresh() });
  }

  async function handleStartRemoteSetup(msg: ClientMessageOf<'start-remote-setup'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'start-remote-setup-result', { ok: false, error: null, ...payload });
    if (!remoteSetup) { reply({ error: 'Remote host setup is not available on this server.' }); return; }
    const login = agentConnect?.logins().find((status) => status.agent === msg.agent);
    if (login?.state !== 'signed-in') { reply({ error: `Sign in to ${msg.agent} before starting the remote setup session.` }); return; }
    const outcome = await remoteSetup.start(msg.agent);
    if (!outcome.ok) { reply({ error: outcome.error }); return; }
    reply({ ok: true, sessionId: outcome.sessionId, sessionName: outcome.sessionName });
  }

  async function handleAgentConnect(msg: ClientMessageOf<'agent-connect'>, ws: ControlSocket): Promise<void> {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    const outcome = msg.action === 'start' ? await agentConnect.start(msg.agent) : agentConnect.cancel(msg.agent);
    replyTo(ws, msg, 'agent-logins', { logins: agentConnect.logins(), error: outcome.ok ? undefined : outcome.error });
  }

  function handleAgentConnectCode(msg: ClientMessageOf<'agent-connect-code'>, ws: ControlSocket): void {
    if (!agentConnect) {
      replyTo(ws, msg, 'agent-logins', { logins: [], error: AGENT_CONNECT_UNAVAILABLE });
      return;
    }
    const outcome = agentConnect.submitCode(msg.agent, msg.code);
    replyTo(ws, msg, 'agent-logins', { logins: agentConnect.logins(), error: outcome.ok ? undefined : outcome.error });
  }

  function handlePing(msg: ClientMessageOf<'ping'>, ws: ControlSocket): void {
    if (!msg.requestId) return;
    ws.send(JSON.stringify({ type: 'pong', requestId: msg.requestId }));
  }

  function handleUpdateSettings(msg: ClientMessageOf<'update-settings'>, ws: ControlSocket): void {
    const parsedSettings = ConfigUpdate.safeParse(msg.settings || {});
    if (!parsedSettings.success) {
      sendError(ws, configIssueMessage(parsedSettings.error), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    const s = parsedSettings.data;

    const incoming: Record<string, unknown> = s;

    if (s.repoRoots) s.repoRoots = s.repoRoots.map((root) => expandTilde(root, process.env, os.homedir()));
    const invalidPaths = (s.repoRoots || []).filter(root => !isExistingDirectory(root));
    if (invalidPaths.length > 0) {
      sendError(ws, `Repository roots must be existing directories: ${invalidPaths.join(', ')}`, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const blocks = incomingSettingsBlocks(incoming);
    const blockError = incomingSettingsBlocksError(blocks);
    if (blockError) {
      sendError(ws, blockError, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const workflowsUpdate = s.workflows;
    const workflowsMerge = workflowsUpdate ? mergeWorkflowsUpdateOverStored(config.workflows, workflowsUpdate) : null;
    if (workflowsMerge && !workflowsMerge.ok) {
      sendError(ws, workflowsMerge.error, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }

    const inSaveWorkflowsFailure: { error: string | null } = { error: null };
    const skippedPermissionsByDefault = machineSkipsPermissionsByDefault(config);
    const freshConfig = configStore.save(cfg => {
      for (const key of RUNTIME_CONFIG_SCALAR_KEYS) {
        if (incoming[key] == null) continue;
        if (typeof incoming[key] === 'boolean' && configStore.isUnchosenLaunchDefault(cfg, key, incoming[key])) continue;
        cfg[key] = incoming[key];
      }
      if (s.repoRoots != null) cfg.repoRoots = s.repoRoots;
      for (const [key, block] of blocks) cfg[key] = mergeSettingsBlock(cfg[key], block, settingsBlockSpecFor(key));
      if (!workflowsUpdate) return undefined;
      const storedWorkflowsMerge = mergeWorkflowsUpdateOverStored(cfg.workflows, workflowsUpdate);
      if (!storedWorkflowsMerge.ok) {
        inSaveWorkflowsFailure.error = storedWorkflowsMerge.error;
        return ABORT_CONFIG_SAVE;
      }
      cfg.workflows = storedWorkflowsMerge.workflows;
      return undefined;
    });
    if (inSaveWorkflowsFailure.error !== null) {
      sendError(ws, inSaveWorkflowsFailure.error, { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    if (!freshConfig) {
      sendError(ws, settingsNotSavedText(configStore.lastSaveFailureReason()), { type: 'settings-error', requestId: msg.requestId || null });
      return;
    }
    applySettingsReload(freshConfig);
    if (machineSkipsPermissionsByDefault(freshConfig) !== skippedPermissionsByDefault) applyConfigReload(freshConfig);
    const updatedSettings = buildSettingsPayload();

    ws.send(JSON.stringify({
      type: 'settings-updated',
      requestId: msg.requestId || null,
      settings: updatedSettings,
    }));
    broadcastControl({
      type: 'settings-updated',
      settings: updatedSettings,
    });
    console.log('[control] Settings updated via UI');
  }

  function handleListAgents(msg: ClientMessageOf<'list-agents'>, ws: ControlSocket): void {
    if (msg.rescan) resetCommandCache();
    const agents = listAgentIds().map((id) => {
      const { label, resolvable } = describeAgentResolvability(id);
      return { id, label, resolvable };
    });
    ws.send(JSON.stringify({
      type: 'agents-listed',
      requestId: msg.requestId || null,
      agents,
    }));
  }

  async function handleScanRepoRoots(msg: ClientMessageOf<'scan-repo-roots'>, ws: ControlSocket): Promise<void> {
    const directories = scanRepoRoots(config.repoRoots);
    const suggestions = msg.includeSuggestions ? await suggestRepoRoots({ homeDir: os.homedir(), configuredRoots: config.repoRoots || [] }) : undefined;
    ws.send(JSON.stringify({
      type: 'repo-roots-scanned',
      requestId: msg.requestId || null,
      directories,
      suggestions,
    }));
  }

  function captureOperatorAction<Surface extends OperatorSurface>(surface: Surface, action: OperatorActionOf<Surface>): void {
    deps.telemetry?.capture?.('operator_action', { surface, action });
  }

  function noteFeatureHintReport(report: DashboardTelemetryReport): void {
    if (!featureHints) return;
    if (report.event === 'view_shown') {
      void featureHints.noteViewShown(report.properties.view);
      return;
    }
    if (report.event !== 'operator_action' || report.properties.surface !== 'hints' || !report.properties.feature) return;
    if (report.properties.action === 'open') void featureHints.settle(report.properties.feature, 'opened');
    if (report.properties.action === 'dismiss') void featureHints.settle(report.properties.feature, 'dismissed');
  }

  function captureDashboardTelemetry(msg: ClientMessageOf<'dashboard-telemetry'>): void {
    const report = DashboardTelemetryReport.safeParse(msg);
    if (!report.success) return;
    noteFeatureHintReport(report.data);
    if (report.data.event === 'header_error_shown') {
      const { source, message } = report.data.properties;
      deps.telemetry?.capture?.('header_error_shown', { source, message: showHomeAsTilde(message, os.homedir()) });
      return;
    }
    deps.telemetry?.capture?.(report.data.event, report.data.properties);
  }

  async function handleGetRadarReport(msg: ClientMessageOf<'get-radar-report'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction('radar', 'report');
    const result = await readPosthogReport(msg.issueId, { reportDir: posthogReportsDir || undefined });
    ws.send(JSON.stringify({
      type: 'radar-report',
      requestId: msg.requestId || null,
      ...result,
    }));
  }

  function findPosthogIssue(projectId: unknown, issueId: unknown) {
    const status = typeof getRadarStatus === 'function' ? getRadarStatus() : null;
    const projects = Array.isArray(status?.projects) ? status.projects : [];
    for (const project of projects) {
      if (String(project.projectId) !== String(projectId)) continue;
      const issues = Array.isArray(project.issues) ? project.issues : [];
      const issue = issues.find((row: { issueId?: unknown }) => String(row?.issueId) === String(issueId));
      if (issue) return { issue, projectName: project.name, host: project.host };
    }
    return null;
  }

  function replyTo(ws: ControlSocket, msg: ControlRequest, type: string, payload: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, requestId: msg.requestId || null, ...payload }));
  }

  function isExistingDirectory(candidate: string): boolean {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  function listSiblingRepoDirs(): { name: string; path: string }[] {
    const entries: { name: string; path: string }[] = [];
    for (const parent of radarLaneCore.projectParentDirs(config.projects)) {
      try {
        for (const dirent of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
          entries.push({ name: dirent.name, path: path.join(parent, dirent.name) });
        }
      } catch (err) {

        if (isMissingFileError(err)) continue;
        console.warn(`[control] posthog auto-create: cannot read ${parent}: ${errorCode(err) || errorMessage(err)}`);
      }
    }
    return entries;
  }

  function createProjectSession({ id = generateProjectId(), name, path: projectPath, repos, baseBranch, agent, dangerouslySkipPermissions, saneYolo, requireExistingPath, environment, runSettings }: { id?: string; name: string; path: string; repos?: string[]; baseBranch?: string; agent?: ProjectEntry['agent']; dangerouslySkipPermissions?: boolean; saneYolo?: boolean; requireExistingPath?: boolean; environment?: ProjectEntry['environment']; runSettings?: Partial<ProjectEntry> }): { ok: true; project: ProjectEntry } | { ok: false; error: string } {
    const uniqueName = nextSuggestedName(name, liveSessionNames());
    let resolvedPath = path.resolve(projectPath);
    let workspaceRepos: string[] | undefined;
    if (repos) {
      const firstRepo = repos[0];
      if (!firstRepo) return { ok: false, error: 'A workspace needs at least two repositories' };
      const worktreeRoot = config.worktreeRoot || path.join(path.dirname(path.resolve(firstRepo)), '.glimmervoid-worktrees');
      const planned = planWorkspace({ worktreeRoot, sessionName: uniqueName, sessionId: id, repoPaths: repos });
      if (!planned.ok) return { ok: false, error: planned.error };
      resolvedPath = planned.plan.folder;
      workspaceRepos = planned.plan.members.map((member) => member.repoPath);
    }
    if (requireExistingPath && !fs.existsSync(resolvedPath)) return { ok: false, error: missingFolderError(projectPath) };
    const project: ProjectEntry = { ...runSettings, id, name: uniqueName, path: resolvedPath };
    if (workspaceRepos) project.repos = workspaceRepos;
    if (baseBranch) project.baseBranch = baseBranch;
    if (typeof dangerouslySkipPermissions === 'boolean') project.dangerouslySkipPermissions = dangerouslySkipPermissions;
    if (saneYolo) project.saneYolo = true;
    if (agent) project.agent = agent;
    if (environment) project.environment = environment;
    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (!freshConfig) return { ok: false, error: `Could not save session "${uniqueName}"` };
    applyConfigReload(freshConfig);
    return { ok: true, project };
  }

  function autoCreatePosthogProject(projectId: unknown, posthogProjectName: unknown): ProjectEntry | null {
    const projectMap = config.posthog?.projectMap;
    const mappedEntry = projectMap && typeof projectMap === 'object'
      ? (projectMap as Record<string, unknown>)[String(projectId)]
      : undefined;
    const mapped = String(mappedEntry ?? '').trim();
    const mappedDir = radarLaneCore.isAbsolutePathish(mapped) && isExistingDirectory(mapped) ? mapped : null;
    const match = mappedDir ? null : radarLaneCore.pickDirectoryForProjectName(posthogProjectName, listSiblingRepoDirs());
    const repoDir = mappedDir || (match && isExistingDirectory(match.path) ? match.path : null);
    if (!repoDir) return null;

    const resolvedPath = path.resolve(repoDir);
    const projectOnRepo = config.projects.find((project) => !project.repos && path.resolve(project.path) === resolvedPath);
    if (projectOnRepo) return projectOnRepo;
    const name = radarLaneCore.sanitizeSessionName(path.basename(resolvedPath))
      || radarLaneCore.sanitizeSessionName(posthogProjectName);
    if (!name) return null;
    const created = createProjectSession({ name, path: resolvedPath, agent: undefined });
    if (!created.ok) return null;
    console.log(`[control] posthog-open-session auto-created session: ${created.project.name} (${resolvedPath})`);
    return created.project;
  }

  function liveSessionNames(): string[] {
    return [...sessions.values(), ...agentSessions.values()].map((session) => session.name);
  }

  function findConfiguredProject(projectId: unknown): ProjectEntry | null {
    if (typeof projectId !== 'string') return null;
    return config.projects.find((project) => project.id === projectId) ?? null;
  }

  const issueOpenQueue = createKeyedSerialQueue();

  async function handleListGithubTeams(request: ClientMessageOf<'list-github-teams'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: { viewer: string | null; teams: GithubTeam[]; error: string | null }) => replyTo(ws, request, 'github-teams-listed', payload);
    const viewerRead = await requestViewer('priority');
    if (viewerRead.isRateLimited) { reply({ viewer: null, teams: [], error: githubStoreRateLimitedError(viewerRead.waitMs, 'your GitHub login') }); return; }
    if (!viewerRead.value) { reply({ viewer: null, teams: [], error: null }); return; }
    const teamsRead = await requestViewerTeams('priority');
    if (teamsRead.isRateLimited) { reply({ viewer: viewerRead.value, teams: [], error: githubStoreRateLimitedError(teamsRead.waitMs, 'your GitHub teams') }); return; }
    if (!teamsRead.value) { reply({ viewer: viewerRead.value, teams: [], error: 'GitHub did not list your teams.' }); return; }
    reply({ viewer: viewerRead.value, teams: teamsRead.value, error: null });
  }

  async function handleIssueDetail(request: ClientMessageOf<'issue-detail'>, ws: ControlSocket): Promise<void> {
    try {
      const issueRead = await requestIssue(request.issueNumber, request.repo, 'priority');
      if (issueRead.isRateLimited) {
        replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: githubStoreRateLimitedError(issueRead.waitMs, 'the issue') });
        return;
      }
      const viewed = issueRead.value;
      if (!viewed.ok || !viewed.issue) {
        replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: viewed.error || 'Issue not found.' });
        return;
      }
      replyTo(ws, request, 'issue-detail-result', { ok: true, body: viewed.issue.body, error: null });
    } catch (error: unknown) {
      replyTo(ws, request, 'issue-detail-result', { ok: false, body: null, error: errorMessage(error) });
    }
  }

  async function handleOpenIssueSession(msg: ClientMessageOf<'open-issue-session'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-issue-session-result', { ok: false, error: null, ...payload });
    const project = findConfiguredProject(msg.projectId);
    if (!project) { reply({ error: 'Project not found' }); return; }
    captureOperatorAction('issues', 'open-session');
    const issueNumber = msg.issueNumber ?? 0;
    const repo = msg.repo;
    try {
      if (!issueProjectRepos) { reply({ error: 'Issues polling is not running.' }); return; }
      const projectRepos = await issueProjectRepos(msg.projectId);
      if (!projectRepos.some((projectRepo) => projectRepo.toLowerCase() === repo.toLowerCase())) {
        reply({ error: `Repository ${repo} does not belong to project "${project.name}"` });
        return;
      }
      const issueKey = `${repo}#${issueNumber}`;
      const linkedSessionId = await issues?.getLinkedSessionId?.(issueKey);
      const linkedSession = linkedSessionId ? sessions.get(linkedSessionId) : null;
      if (linkedSession) {
        reply({ ok: true, sessionId: linkedSession.id, sessionName: linkedSession.name, existing: true });
        return;
      }
      const issueRead = await requestIssue(issueNumber, repo, 'priority');
      if (issueRead.isRateLimited) { reply({ error: githubStoreRateLimitedError(issueRead.waitMs, 'the issue') }); return; }
      const viewed = issueRead.value;
      if (!viewed.ok) { reply({ error: `Could not read GitHub issue #${issueNumber}: ${viewed.error}` }); return; }
      const issue = viewed.issue;
      if (!issue) { reply({ error: `Open issue #${issueNumber} was not found` }); return; }
      const sessionName = deriveIssueSessionName(issue);
      const created = createProjectSession({
        name: sessionName,
        path: project.path,
        agent: project.agent,
        dangerouslySkipPermissions: project.dangerouslySkipPermissions,
      });
      if (!created.ok) { reply({ error: created.error }); return; }
      const session = sessions.get(created.project.id);
      if (!session) { reply({ error: `Session "${sessionName}" is not loaded` }); return; }
      const prompt = buildGithubIssuePrompt({ issue, repoSlug: repo });
      const pasted = session.pasteTextWhenReady(prompt);
      if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
      await issues?.linkSession?.(issueKey, session.id);
      reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
      console.log(`[control] open-issue-session: issue=${repo}#${issueNumber} -> session=${session.name}`);
    } catch (error) {
      reply({ error: `Could not open GitHub issue session: ${errorMessage(error)}` });
    }
  }

  const prSessionOpenQueue = createKeyedSerialQueue();

  function sessionLinkedToPr(pullRequestKey: string): Session | null {
    const comparableKey = pullRequestKey.toLowerCase();
    for (const [, session] of sessions) {
      if (session.linkedPrs.some((link) => prKey(link.repo, link.number).toLowerCase() === comparableKey)) return session;
    }
    return null;
  }

  async function handleOpenTeamReviewSession(msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-team-review-session-result', { ok: false, error: null, key: msg.key, ...payload });
    captureOperatorAction('reviews', 'open-session');
    try {
      const linkedSession = sessionLinkedToPr(msg.key);
      if (linkedSession) {
        reply({ ok: true, sessionId: linkedSession.id, sessionName: linkedSession.name, existing: true });
        return;
      }
      if (!teamReview?.preparePrSession) { reply({ error: 'Team review is not running' }); return; }
      const singleRepoProjects = config.projects.filter((project) => !project.repos);
      const checkout = await teamReview.preparePrSession(msg.key);
      if (!checkout.ok) { reply({ error: checkout.error }); return; }
      const sourceProject = checkout.isConfiguredProject ? singleRepoProjects.find((project) => project.path === checkout.checkoutPath) : undefined;
      const created = createProjectSession({
        name: prSessionName(checkout.repo, checkout.detail.number, checkout.detail.title),
        path: checkout.checkoutPath,
        baseBranch: checkout.baseBranch,
        agent: sourceProject?.agent,
        dangerouslySkipPermissions: false,
      });
      if (!created.ok) { reply({ error: created.error }); return; }
      const session = sessions.get(created.project.id);
      if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
      const link = manualPrLink(msg.key, (typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null)?.prs ?? [], Date.now());
      if (link) session.linkPrManually(link);
      const pasted = session.pasteTextWhenReady(prSessionPrompt({ repo: checkout.repo, detail: checkout.detail, draft: checkout.draft }));
      if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
      reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
      console.log(`[control] open-team-review-session: pr=${msg.key} -> session=${session.name}`);
    } catch (error) {
      reply({ error: `Could not open a session for ${msg.key}: ${errorMessage(error)}` });
    }
  }

  function handleRadarOpenSession(msg: ClientMessageOf<'radar-open-session'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-open-session-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'open-session');
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const project = radarLaneCore.resolveIssueProject(config.posthog, config.projects, ref.projectId)
      || autoCreatePosthogProject(ref.projectId, found.projectName);
    if (!project) {
      reply({ error: 'No Glimmervoid session is mapped to this PostHog project (set posthog.projectMap)' });
      return;
    }
    const sess = project.id ? sessions.get(project.id) : undefined;
    if (!sess) { reply({ error: `Session "${project.name}" is not loaded` }); return; }
    const prompt = radarLaneCore.buildIssueSessionPrompt({
      issue: found.issue,
      projectName: found.projectName,
      host: found.host,
      url: found.issue.url,
    });
    const res = sess.pasteTextWhenReady(prompt);
    if (!res.ok) { reply({ error: `Could not write to "${sess.name}" (${res.reason})` }); return; }
    sess.noteOperatorDraft();
    reply({ ok: true, sessionId: sess.id, sessionName: sess.name, pending: res.deferred === true });
    console.log(`[control] posthog-open-session: issue=${ref.issueId} -> session=${sess.name}`);
  }

  async function handleRadarIssueAction(msg: ClientMessageOf<'radar-issue-action'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-issue-action-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateIssueRef(msg);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    const found = findPosthogIssue(ref.projectId, ref.issueId);
    if (!found) { reply({ error: 'That issue is not in the latest PostHog poll' }); return; }
    const decision = radarLaneCore.decideIssueAction(msg.action);
    if (!decision.ok) { reply({ error: decision.error }); return; }
    captureOperatorAction('radar', decision.status === 'resolved' ? 'resolve' : 'suppress');
    if (!posthogSetIssueStatus) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await posthogSetIssueStatus({
      projectId: ref.projectId, issueId: ref.issueId, action: String(msg.action),
    });
    reply({ ok: res.ok === true, error: res.error || null, status: res.status || null });
  }

  async function handleTeamReviewAction(msg: ClientMessageOf<'team-review-action'>, ws: ControlSocket): Promise<void> {
    const requestedKey = typeof msg.key === 'string' ? msg.key : '';
    const reply = (outcome: TeamReviewActionOutcome) => replyTo(ws, msg, 'team-review-action-result', { key: requestedKey, ...outcome });
    const parsed = TeamReviewActionRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', parsed.data.action);
    if (!teamReview?.isRunning()) { reply({ ok: false, error: 'Team review is not running' }); return; }
    reply(await teamReview.submitAction(parsed.data));
  }

  async function handleCommunityAction(msg: ClientMessageOf<'community-action'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<CommunityActionResult, 'key'>) => replyTo(ws, msg, 'community-action-result', { key: msg.key, ...outcome });
    const parsed = CommunityActionRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('community', parsed.data.action);
    if (!community) { reply({ ok: false, error: 'The community lane is not running' }); return; }
    reply(await community.submitAction(parsed.data));
  }

  function handleOpenCommunitySession(msg: ClientMessageOf<'open-community-session'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'open-community-session-result', { ok: false, error: null, key: msg.key, ...payload });
    captureOperatorAction('community', 'open-session');
    if (!community) { reply({ error: 'The community lane is not running' }); return; }
    const seeded = community.sessionPromptFor(msg.key);
    if (!seeded.ok) { reply({ error: seeded.error }); return; }
    const project = config.projects.find((candidate) => candidate.id === msg.projectId && !candidate.repos);
    if (!project) { reply({ error: 'Pick a single-repository session to start from' }); return; }
    const created = createProjectSession({
      name: radarLaneCore.sanitizeSessionName(`Community ${seeded.title}`) ?? 'Community question',
      path: project.path,
      agent: project.agent,
      dangerouslySkipPermissions: false,
    });
    if (!created.ok) { reply({ error: created.error }); return; }
    const session = sessions.get(created.project.id);
    if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
    const pasted = session.pasteTextWhenReady(seeded.prompt);
    if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
    reply({ ok: true, sessionId: session.id, sessionName: session.name, pending: pasted.deferred === true });
    console.log(`[control] open-community-session: item=${msg.key} -> session=${session.name}`);
  }

  async function handleGithubPollingRefresh(msg: ClientMessageOf<'github-polling-refresh'>, ws: ControlSocket): Promise<void> {
    captureOperatorAction(msg.lane === 'issues' ? 'issues' : 'reviews', 'refresh');
    const lane = { 'my-prs': myPrs, 'team-review': teamReview, issues }[msg.lane];
    if (!lane?.refresh) {
      replyTo(ws, msg, 'github-polling-refresh-result', { ok: false, error: 'Reviews polling is not running.' });
      return;
    }
    const refreshOutcome = await lane.refresh();
    replyTo(ws, msg, 'github-polling-refresh-result', {
      ...refreshOutcome,
      ...(githubStore ? { freshness: githubStore.getFreshness() } : {}),
    });
  }

  async function handleMyPrMerge(msg: ClientMessageOf<'my-pr-merge'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'merge');
    if (!myPrs) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.mergePr(parsed.data));
  }

  async function handleMyPrKeepMergeable(msg: ClientMessageOf<'my-pr-keep-mergeable'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrKeepMergeableResult, 'key'>) => replyTo(ws, msg, 'my-pr-keep-mergeable-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrKeepMergeableRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'keep-mergeable');
    if (!myPrs?.setKeepMergeable) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setKeepMergeable(parsed.data));
  }

  async function handleMyPrMergeWhenReady(msg: ClientMessageOf<'my-pr-merge-when-ready'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeWhenReadyResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-when-ready-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeWhenReadyRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    captureOperatorAction('reviews', 'merge-when-ready');
    if (!myPrs?.setMergeWhenReady) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setMergeWhenReady(parsed.data));
  }

  async function handleBenchmarkAction(msg: ClientMessageOf<'benchmark-action'>, ws: ControlSocket): Promise<void> {
    const parsed = BenchmarkActionRequest.safeParse(msg);
    if (!parsed.success) {
      replyTo(ws, msg, 'benchmark-action-result', { suiteId: String(msg.suiteId ?? ''), action: msg.action, ok: false, error: configIssueMessage(parsed.error) });
      return;
    }
    if (!benchmarks) {
      replyTo(ws, msg, 'benchmark-action-result', { ...parsed.data, ok: false, error: 'Benchmarks are not running' });
      return;
    }
    replyTo(ws, msg, 'benchmark-action-result', await benchmarks.submitAction(parsed.data));
  }

  async function handleTelegramTest(msg: ClientMessageOf<'telegram-test'>, ws: ControlSocket): Promise<void> {
    if (!telegramDelivery) {
      replyTo(ws, msg, 'telegram-test-result', { ok: false, error: 'Telegram is not running on this server.', telegramDelivery: null });
      return;
    }
    const sendResult = await telegramDelivery.sendTest();
    replyTo(ws, msg, 'telegram-test-result', { ok: sendResult.ok, error: sendResult.error, telegramDelivery: telegramDelivery.status() });
  }

  async function handleRadarArchiveInvestigation(msg: ClientMessageOf<'radar-archive-investigation'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-archive-investigation-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'archive-investigation');
    if (!radarArchiveInvestigation) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await radarArchiveInvestigation({ id: ref.id });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  async function handleRadarApproveFix(msg: ClientMessageOf<'radar-approve-fix'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-approve-fix-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'approve-fix');
    if (!radarFixes) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const pending = radarFixes.pendingFixFor(ref.id);
    if (!pending) { reply({ error: 'That investigation has no fix waiting for approval' }); return; }
    const created = createProjectSession({
      name: `Radar fix ${radarLaneCore.sanitizeSessionName(pending.record.projectName)} #${pending.record.issueId}`,
      path: pending.fix.repoPath,
      baseBranch: pending.fix.branch,
      requireExistingPath: true,
    });
    if (!created.ok) { reply({ error: created.error }); return; }
    const session = sessions.get(created.project.id);
    if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
    const pasted = session.pasteTextWhenReady(radarLaneCore.approvedFixSessionPrompt(pending));
    if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
    const settled = await radarFixes.settlePendingFix(ref.id, { releaseBranch: false });
    if (!settled.ok) console.warn(`[control] radar-approve-fix: ${settled.error}`);
    reply({ ok: true, sessionId: session.id, sessionName: session.name });
    console.log(`[control] radar-approve-fix: investigation=${ref.id} -> session=${session.name}`);
  }

  async function handleRadarDismissFix(msg: ClientMessageOf<'radar-dismiss-fix'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-dismiss-fix-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    captureOperatorAction('radar', 'dismiss-fix');
    if (!radarFixes) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await radarFixes.settlePendingFix(ref.id, { releaseBranch: true });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  async function handleRequestUsageReport(msg: ClientMessageOf<'request-usage-report'>, ws: ControlSocket): Promise<void> {
    if (!requestUsageReport) {
      ws.send(JSON.stringify({ type: 'usage-report', requestId: msg.requestId || null, error: 'Usage tracking is not running' }));
      return;
    }
    const requestedDays = typeof msg.days === 'number' ? msg.days : Number.NaN;
    const days = Number.isInteger(requestedDays) && requestedDays > 0 && requestedDays <= USAGE_REPORT_MAX_DAYS ? requestedDays : undefined;
    const report = await requestUsageReport({ days, force: msg.force === true, requestId: msg.requestId || null });
    ws.send(JSON.stringify(report));
  }

  function handleShutdown(): void {
    console.log('[control] Shutdown requested via UI');
    broadcastControl({ type: 'shutting-down' });
    setTimeout(() => {
      if (requestShutdown) requestShutdown();
    }, 200);
  }

  function builtinHooksReport() {
    const hookTools: ResolvedHookTool[] = [];
    const saneYoloPath = config.saneYolo !== false ? resolvePackageBin('cc-safety-net', 'cc-safety-net') : null;
    if (saneYoloPath) hookTools.push({ id: 'saneYolo', binPath: saneYoloPath });
    return describeBuiltinHooks({
      detectScheduledWakeups: config.detectScheduledWakeups !== false,
      hookTools,
      planReview: config.planReview?.enabled !== false,
      holdsQuestionsForParent: true,
    });
  }

  function hooksReportProjects(): { id: string; name: string; agent: string }[] {
    return (config.projects || [])
      .filter((project): project is ProjectEntry & { id: string; name: string } => (
        typeof project?.id === 'string' && typeof project?.name === 'string'
      ))
      .map((project) => ({ id: project.id, name: project.name, agent: typeof project.agent === 'string' ? project.agent : DEFAULT_AGENT_ID }));
  }

  async function answerWhiteboard(ws: ControlSocket, msg: ControlRequest, command: (port: WhiteboardPort['handleOperator']) => Promise<Record<string, unknown>>): Promise<void> {
    if (!whiteboards) {
      replyTo(ws, msg, 'whiteboard-result', { ok: false, error: 'Whiteboards are not available on this server.' });
      return;
    }
    replyTo(ws, msg, 'whiteboard-result', { ...await command(whiteboards.handleOperator) });
  }

  function handleRequestHooksReport(msg: ClientMessageOf<'request-hooks-report'>, ws: ControlSocket): void {
    replyTo(ws, msg, 'hooks-report', {
      ts: Date.now(),
      hooks: readStoredHooks(config.hooks),
      builtin: builtinHooksReport(),
      events: HOOK_EVENT_CATALOG,
      projects: hooksReportProjects(),

      limits: { maxTimeoutSec: HOOK_MAX_TIMEOUT_SEC },
      error: null,
    });
  }

  function handleSaveHook(msg: ClientMessageOf<'save-hook'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'save-hook-result', { ok: false, error: null, ...payload });
    const input = msg.hook && typeof msg.hook === 'object' ? msg.hook : {};
    const requestedId = typeof input.id === 'string' ? input.id : '';
    if (requestedId && !HOOK_ID_RE.test(requestedId)) { reply({ error: 'hook id is invalid' }); return; }
    const id = requestedId || crypto.randomUUID();

    const stored = requestedId ? readStoredHooks(config.hooks).find((hook) => hook.id === requestedId) : null;
    if (requestedId && !stored) { reply({ error: 'Unknown hook' }); return; }

    const knownProjectIds = new Set(hooksReportProjects().map((project) => project.id));
    for (const projectId of stored?.projects || []) knownProjectIds.add(projectId);
    const normalized = normalizeHook(input, { id, knownProjectIds });
    if (!normalized.ok) { reply({ error: normalized.error }); return; }

    const freshConfig = configStore.save((cfg) => {
      cfg.hooks = upsertHook(rawStoredHooks(cfg.hooks), normalized.hook);
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, hook: normalized.hook });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] save-hook: ${normalized.hook.name} (${normalized.hook.event})`);
  }

  function handleDeleteHook(msg: ClientMessageOf<'delete-hook'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'delete-hook-result', { ok: false, error: null, ...payload });
    const id = typeof msg.id === 'string' ? msg.id : '';

    if (!rawStoredHooks(config.hooks).some((hook) => hook && hook.id === id)) { reply({ error: 'Unknown hook' }); return; }
    const freshConfig = configStore.save((cfg) => {
      const remaining = removeHook(rawStoredHooks(cfg.hooks), id);

      if (remaining.length === 0) delete cfg.hooks;
      if (remaining.length > 0) cfg.hooks = remaining;
    });
    if (!freshConfig) { reply({ error: 'Could not write config.json' }); return; }
    reply({ ok: true, id });
    applyConfigReload(freshConfig);
    broadcastControl({ type: 'hooks-updated', count: readStoredHooks(freshConfig.hooks).length });
    console.log(`[control] delete-hook: ${id}`);
  }

  async function handleUpdateCheck(_msg: ClientMessageOf<'update-check'>, ws: ControlSocket): Promise<void> {
    if (!checkNow) {
      sendError(ws, '[update-check-unavailable] Update checking is unavailable.', { scope: 'update' });
      return;
    }
    await checkNow();
  }

  async function handleUpdateApply(_msg: ClientMessageOf<'update-apply'>, ws: ControlSocket): Promise<void> {
    if (!applyUpdate) {
      sendError(ws, '[update-apply-unavailable] Update application is unavailable.', { scope: 'update' });
      return;
    }
    const outcome = await applyUpdate();
    if (outcome.ok) return;
    sendError(ws, `[${outcome.reason || 'update-refused'}] ${outcome.message}`, { scope: 'update' });
  }

  function handleRestart(_msg: ClientMessageOf<'restart-server'>): void {
    noteRestartRequested?.();
    console.log('[control] Restart requested via UI');
    broadcastControl({ type: 'restarting' });
    setTimeout(() => {
      if (requestRestart) requestRestart();
    }, 200);
  }

  const handlers = {
    'add-session':      handleAddSession,
    'quick-session':    handleQuickSession,
    'list-conversations': handleListConversations,
    'resume-conversation': handleResumeConversation,
    'remove-session':   handleRemoveSession,
    'rename-session':   handleRenameSession,
    'get-workspace-repos': handleGetWorkspaceRepos,
    'set-workspace-repos': handleSetWorkspaceRepos,
    'set-session-title': handleSetSessionTitle,
    'link-session-pr':  handleLinkSessionPr,
    'unlink-session-pr': handleUnlinkSessionPr,
    'ping':             handlePing,
    'get-settings':     handleGetSettings,
    'get-agent-logins': handleGetAgentLogins,
    'agent-connect':    handleAgentConnect,
    'start-remote-setup': handleStartRemoteSetup,
    'agent-connect-code': handleAgentConnectCode,
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'list-agents':      handleListAgents,
    'list-github-teams': handleListGithubTeams,
    'get-radar-report': handleGetRadarReport,
    'radar-open-session': handleRadarOpenSession,
    'issue-detail': handleIssueDetail,
    'open-team-review-session': (msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket) => prSessionOpenQueue.run(msg.key.toLowerCase(), () => handleOpenTeamReviewSession(msg, ws)),
    'open-issue-session': (msg: ClientMessageOf<'open-issue-session'>, ws: ControlSocket) => issueOpenQueue.run(`${msg.repo.toLowerCase()}#${msg.issueNumber}`, () => handleOpenIssueSession(msg, ws)),
    'radar-issue-action': handleRadarIssueAction,
    'radar-archive-investigation': handleRadarArchiveInvestigation,
    'radar-approve-fix': handleRadarApproveFix,
    'radar-dismiss-fix': handleRadarDismissFix,
    'telegram-test': handleTelegramTest,
    'team-review-action': handleTeamReviewAction,
    'community-action': handleCommunityAction,
    'open-community-session': handleOpenCommunitySession,
    'my-pr-merge': handleMyPrMerge,
    'my-pr-keep-mergeable': handleMyPrKeepMergeable,
    'my-pr-merge-when-ready': handleMyPrMergeWhenReady,
    'github-polling-refresh': handleGithubPollingRefresh,
    'benchmark-action': handleBenchmarkAction,
    'request-usage-report': handleRequestUsageReport,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'whiteboard-create': (msg: ClientMessageOf<'whiteboard-create'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.create(msg.title)),
    'whiteboard-op': (msg: ClientMessageOf<'whiteboard-op'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.put(msg.boardId, msg.ops)),
    'whiteboard-delete': (msg: ClientMessageOf<'whiteboard-delete'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.remove(msg.boardId)),
    'whiteboard-get': (msg: ClientMessageOf<'whiteboard-get'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.get(msg.boardId)),
    'whiteboard-connect': (msg: ClientMessageOf<'whiteboard-connect'>, ws: ControlSocket) => answerWhiteboard(ws, msg, async (port) => {
      if (!findSession({ id: msg.sessionId })) return { ok: false, error: 'That session is no longer on the dashboard.' };
      return port.connect(msg.boardId, msg.sessionId);
    }),
    'whiteboard-disconnect': (msg: ClientMessageOf<'whiteboard-disconnect'>, ws: ControlSocket) => answerWhiteboard(ws, msg, (port) => port.disconnect(msg.boardId, msg.sessionId)),
    'whiteboard-nudge': (msg: ClientMessageOf<'whiteboard-nudge'>, ws: ControlSocket) => answerWhiteboard(ws, msg, async (port) => {
      const session = findSession({ id: msg.sessionId });
      if (!session) return { ok: false, error: 'That session is no longer on the dashboard.' };
      const nudgeLine = port.nudgeLine(msg.boardId);
      if (!nudgeLine) return { ok: false, error: 'That board was deleted.' };
      if (session.hasPendingPaste()) return { ok: false, error: 'That session already has a prompt waiting to be pasted, so nothing was sent.' };
      const pasted = session.pasteTextWhenReady(nudgeLine, { submit: true });
      if (!pasted.ok) return { ok: false, error: 'That session has no live terminal, so nothing was sent.' };
      return { ok: true, error: null };
    }),
    'delete-hook': handleDeleteHook,
    'kill':             (msg: ClientMessageOf<'kill'>) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    handleStartSession,
    'restart':          (msg: ClientMessageOf<'restart'>, ws: ControlSocket) => restartSession(msg, ws, (s, options) => s.restart(options)),
    'force-restart':    (msg: ClientMessageOf<'force-restart'>, ws: ControlSocket) => restartSession(msg, ws, (s, options) => s.forceRestart(options)),
    'dismiss':          (msg: ClientMessageOf<'dismiss'>) => {
      const session = findSession(msg);
      if (!session) return;
      if (msg.expectedState !== undefined && session.state !== msg.expectedState) return;
      session.dismiss();
    },

    'merge-session':              async (msg: ClientMessageOf<'merge-session'>, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeWorktree()); },

    'finish-session':             (msg: ClientMessageOf<'finish-session'>) => { const s = findSession(msg); if (s) s.finishAndMerge(); },

    'merge-continue-session':     async (msg: ClientMessageOf<'merge-continue-session'>, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeAndContinue({ force: msg.force === true })); },
    'discard-session-worktree':   (msg: ClientMessageOf<'discard-session-worktree'>) => { const s = findSession(msg); if (s) s.discardWorktree(); },

    'resolve-session-merge':      (msg: ClientMessageOf<'resolve-session-merge'>) => { const s = findSession(msg); if (s) s.pasteMergePrompt(); },
    'request-session-diff':       async (msg: ClientMessageOf<'request-session-diff'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;

      try {
        const diff = await s.getDiff();
        ws.send(JSON.stringify({ ...diff, type: 'session-diff', id: s.id }));
      } catch (error) {
        console.warn(`[control] request-session-diff failed: id=${s.id}: ${errorMessage(error)}`);
        ws.send(JSON.stringify({ type: 'session-diff-error', id: s.id, message: firstGitErrorLine(error) }));
      }
    },

    'watch-session-changes':      (msg: ClientMessageOf<'watch-session-changes'>, ws: ControlSocket) => changesWatch.request(ws, msg.id),

    'request-change-map':         async (msg: ClientMessageOf<'request-change-map'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const map = await changeMaps.build(s).catch((error: unknown): ChangeMap => {
        console.warn(`[control] request-change-map build failed: id=${s.id}: ${errorMessage(error)}`);
        return {
          sessionId: s.id, sig: null, generatedAt: Date.now(), repos: [],
          error: `Change map could not be built: ${errorMessage(error)}`,
        };
      });
      ws.send(JSON.stringify({ type: 'change-map', id: s.id, map }));
    },

    'request-branch-sync':        async (msg: ClientMessageOf<'request-branch-sync'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.getBranchSync();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },

    'resync-branch':               async (msg: ClientMessageOf<'resync-branch'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.resyncBranch();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    'debug-state':      (msg: ClientMessageOf<'debug-state'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) { sendError(ws, SESSION_GONE_TEXT); return; }
      ws.send(JSON.stringify({ type: 'debug-state-response', id: s.id, payload: s.getDebugState() }));
    },
    'session-trace':    async (message: ClientMessageOf<'session-trace'>, ws: ControlSocket) => {
      const requestedSessionId = message.id;
      const session = findSession(message);
      if (!session) return sendError(ws, 'Session not found', { id: requestedSessionId, requestId: message.requestId });
      if (!readTracePage) return sendError(ws, 'Session trace is not enabled', { id: session.id, requestId: message.requestId });
      const endingAt = message.endingAt === 'tail' || typeof message.endingAt === 'number' ? message.endingAt : undefined;
      try {
        const page = await readTracePage(session.id, { after: message.after ?? 0, ...(endingAt !== undefined ? { endingAt } : {}) });
        ws.send(JSON.stringify({ type: 'session-trace-response', id: session.id, ...(message.requestId ? { requestId: message.requestId } : {}), ...page }));
      } catch (error) {
        sendError(ws, `Session trace read failed: ${errorMessage(error)}`, { id: session.id, requestId: message.requestId });
      }
    },
    'session-plan':     async (message: ClientMessageOf<'session-plan'>, ws: ControlSocket) => {
      const requestedSessionId = String(message.id || '');
      if (!readPlanRevision) return sendError(ws, 'Plan review is not enabled', { id: requestedSessionId, scope: 'plan' });
      const agentId = typeof message.agentId === 'string' ? message.agentId : null;
      const revision = typeof message.revision === 'number' ? message.revision : null;
      const draft = message.draft === true;
      try {
        const result = await readPlanRevision(requestedSessionId, { agentId, revision, draft });
        if (!result) return sendError(ws, 'Plan revision not found', { id: requestedSessionId, scope: 'plan' });
        ws.send(JSON.stringify({ type: 'session-plan-response', id: requestedSessionId, ...result }));
      } catch (error) {
        sendError(ws, `Plan read failed: ${errorMessage(error)}`, { id: requestedSessionId, scope: 'plan' });
      }
    },
    'plan-decision':    (message: ClientMessageOf<'plan-decision'>, ws: ControlSocket) => {
      const requestedSessionId = String(message.id || '');
      const refuse = (reason: string) => sendError(ws, reason, { id: requestedSessionId, scope: 'plan-decision' });
      if (!decidePlanReview) return refuse('Plan review is not enabled');
      const session = findSession(message);
      if (!session) return refuse('Session not found');
      const parsed = PlanDecision.safeParse({ ...message, id: session.id });
      if (!parsed.success) return refuse('Plan decision refused by the schema');
      const refusal = decidePlanReview(session.id, parsed.data);
      if (!refusal) return;
      ws.send(JSON.stringify({
        type: 'session-error',
        id: session.id,
        scope: 'plan-decision',
        session: session.name,
        message: refusal,
      }));
    },
    'session-doc-read': async (message: ClientMessageOf<'session-doc-read'>, ws: ControlSocket) => {
      const reply = { type: 'session-doc-response', requestId: message.requestId ?? null, id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) return ws.send(JSON.stringify({ ...reply, ok: false, error: 'Session not found' }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await sessionDocs.read(session, message.path) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Read failed: ${errorMessage(error)}` }));
      }
    },
    'session-coherence-journal': async (message: ClientMessageOf<'session-coherence-journal'>, ws: ControlSocket) => {
      const reply = { type: 'session-coherence-journal-response', requestId: message.requestId ?? null, id: message.id };
      const session = findSession(message);
      if (!coherenceFeed || !session) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: 'Session not found' }));
      const journal = await coherenceFeed.readJournal(session);
      if (!journal.ok) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: journal.error }));
      ws.send(JSON.stringify({ ...reply, ok: true, entries: journal.entries }));
    },
    'session-setup': async (message: ClientMessageOf<'session-setup'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) return replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'Session not found' });
      const transcriptPath = session.transcriptPath;
      if (session.agentId !== 'claude-code' || !transcriptPath) return replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'No Claude Code transcript for this session yet' });
      try {
        const setup = await readSessionSetup(transcriptPath);
        replyTo(ws, message, 'session-setup-response', { id: message.id, ok: true, setup });
      } catch {
        replyTo(ws, message, 'session-setup-response', { id: message.id, ok: false, error: 'Could not read the Claude Code transcript for this session' });
      }
    },
    'session-doc-save': async (message: ClientMessageOf<'session-doc-save'>, ws: ControlSocket) => {
      const reply = { type: 'session-doc-save-result', requestId: message.requestId ?? null, id: message.id, path: message.path };
      const session = findSession(message);
      if (!sessionDocs || !session) return ws.send(JSON.stringify({ ...reply, ok: false, error: 'Session not found' }));
      try {
        ws.send(JSON.stringify({ ...reply, ...await sessionDocs.save(session, message.path, message.text, message.baseHash) }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, error: `Save failed: ${errorMessage(error)}` }));
      }
    },
    'shutdown':         handleShutdown,
    'restart-server':   handleRestart,
    'update-check':     handleUpdateCheck,
    'update-apply':     handleUpdateApply,
    'focus-change':     (msg: ClientMessageOf<'focus-change'>, ws: ControlSocket) => { if (handleClientFocus) handleClientFocus(ws, !!msg.focused); },
    'client-error':     (msg: ClientMessageOf<'client-error'>) => {
      if (typeof msg.name !== 'string' || typeof msg.stack !== 'string') return;
      deps.telemetry?.captureClientError({ name: msg.name, stack: msg.stack });
    },
    'client-log':       (msg: ClientMessageOf<'client-log'>) => {
      console.warn(`[dashboard] ${sanitizeOneLine(msg.scope, CLIENT_LOG_SCOPE_MAX_CHARS)}: ${sanitizeOneLine(msg.text, CLIENT_LOG_TEXT_MAX_CHARS)}`);
    },
    'dashboard-telemetry': captureDashboardTelemetry,
    'request-telemetry-deletion': async (msg: ClientMessageOf<'request-telemetry-deletion'>, ws: ControlSocket) => {
      const ok = await deps.telemetry?.requestDataDeletion?.() ?? false;
      ws.send(JSON.stringify({ type: 'telemetry-deletion-result', requestId: msg.requestId || null, ok }));
    },
    'request-health-snapshot': (_msg: ClientMessageOf<'request-health-snapshot'>, ws: ControlSocket) => {
      if (!buildHealthSnapshot) return;
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    },
  };

  const handlerTable: { [Type in ClientMessage['type']]?: ControlHandler<Type> } = handlers;

  function dispatchControlRequest<Type extends ClientMessage['type']>(request: { [Variant in ClientMessage['type']]: ClientMessageOf<Variant> }[Type], ws: ControlSocket) {
    const handler = handlerTable[request.type];
    if (handler) return handler(request, ws);
    return undefined;
  }
  controlWss.on('connection', (socket: WebSocket, req) => {
    const ws = socket as ControlSocket;
    ws.send(JSON.stringify(buildSnapshot()));

    ws.send(JSON.stringify({ type: 'client-trust', trust: normalizeClientTrust(ws.glimmervoidTrust) }));
    if (buildHealthSnapshot) {
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    }

    const update = typeof getUpdateStatus === 'function' ? getUpdateStatus() : null;
    if (update) ws.send(JSON.stringify({ type: 'update-status', ...update }));

    const updateJournal = typeof getUpdateJournal === 'function' ? getUpdateJournal() : null;
    if (updateJournal) ws.send(JSON.stringify({ type: 'update-progress', journal: updateJournal }));

    const postTurnLeftoversNotice = getPostTurnLeftoversNotice?.() ?? null;
    if (postTurnLeftoversNotice) ws.send(JSON.stringify(postTurnLeftoversNotice));
    const featureHintMessage = featureHints?.pendingHintMessage() ?? null;
    if (featureHintMessage) ws.send(JSON.stringify(featureHintMessage));
    recheckPostTurnLeftovers?.();

    const radarStatus = typeof getRadarStatus === 'function' ? getRadarStatus() : null;
    if (radarStatus) {
      ws.send(JSON.stringify(radarStatus));
    }

    const teamReviewStatus = typeof getTeamReviewStatus === 'function' ? getTeamReviewStatus() : null;
    if (githubStore) ws.send(JSON.stringify(githubStore.snapshotMessage()));
    if (teamReviewStatus) ws.send(JSON.stringify(teamReviewStatus));
    const communityStatus = getCommunityStatus?.() ?? null;
    if (communityStatus) ws.send(JSON.stringify(communityStatus));
    const myPrsStatus = typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null;
    if (myPrsStatus) ws.send(JSON.stringify(toMyPrsWireStatus(myPrsStatus)));
    const issuesStatus = getIssuesStatus?.();
    if (issuesStatus) ws.send(JSON.stringify(issuesStatus));
    const benchmarkStatus = typeof getBenchmarkStatus === 'function' ? getBenchmarkStatus() : null;
    if (benchmarkStatus) ws.send(JSON.stringify(benchmarkStatus));

    const usageSessions = typeof getUsageSessions === 'function' ? getUsageSessions() : null;
    if (usageSessions) {
      ws.send(JSON.stringify(usageSessions));
    }
    const usageReport = typeof getUsageReport === 'function' ? getUsageReport() : null;
    if (usageReport) {
      ws.send(JSON.stringify(usageReport));
    }

    const planLimitsMessages = typeof getPlanLimits === 'function' ? getPlanLimits() : [];
    for (const planLimits of planLimitsMessages) {
      if (planLimits) ws.send(JSON.stringify(planLimits));
    }

    const since = parseSinceParam(req?.url);
    if (controlReplayLog && since !== null) {
      const { entries, evicted } = controlReplayLog.entriesSince(since);
      for (const entry of entries) ws.send(JSON.stringify(entry));
      if (evicted) console.log(`[control] replay cursor since=${since} is stale; some transient broadcasts were dropped`);
    }

    ws.on('message', (raw) => {
      let msg: Record<string, unknown> | null = null;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        console.warn('[control] Dropped malformed JSON message');
        return;
      }

      const parsedMessage = ClientMessage.safeParse(msg);
      if (!parsedMessage.success) {
        const message = configIssueMessage(parsedMessage.error);
        console.warn(`[control] Dropped invalid client message: ${message}`);
        const reply = requestValidationErrorReply(msg, message);
        if (reply) ws.send(JSON.stringify(reply));
        return;
      }
      const request: ControlRequest = parsedMessage.data;
      if (!Object.hasOwn(handlers, request.type)) return;

      const result = dispatchControlRequest(request, ws);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          console.warn(`[control] ${request.type} handler failed: ${errorMessage(err)}`);
          deps.telemetry?.captureException(err, { handled: true });
        });
      }
      return undefined;
    });
  });

  function removeExitedSession(id: string): void {
    void removeSession({ type: 'remove-session', id }).then((removal) => {
      if (removal.ok) return;
      const sess = sessions.get(id);
      if (removal.canDiscardWork && sess) {
        broadcastControl({ type: 'session-close-confirm', id, mergeStatus: sess.mergeStatus });
        return;
      }
      console.warn(`[control] Could not remove session ${id} after its agent quit: ${removal.error}`);
    });
  }

  return { buildSnapshot, removeExitedSession };
}

export {
  registerControlHandlers,
};
export type { BenchmarkControl, CommunityActionControl, ControlHandlerDeps, MyPrMergeControl, RadarFixControl, TeamReviewActionControl };
