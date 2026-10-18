import type { IssuesStatus } from '../shared/contracts/issues.ts';
import { createKeyedSerialQueue } from './spawn-gate.ts';
import { FACTORY_ERROR_MAX_CHARS, FactoryControlRequest } from '../shared/contracts/factory.ts';
import type { FactoryControlResult, FactoryQueueIntentRequest, FactoryQueueIntentResult, FactoryState } from '../shared/contracts/factory.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import type { GithubPollingRefreshResult } from '../shared/contracts/github-polling.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessage, RUNTIME_CONFIG_SCALAR_KEYS, ConfigUpdate, configIssueMessage,
  type ClientMessageOf, type ServerMessageOf,
} from '../shared/contracts/index.ts';
import { TASK_TITLE_MAX_LENGTH, TaskTitle } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import { claudeProjectsDir, listRepoConversations } from '../session/core/conversation-history.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlSocket } from './backend/backend-websockets.ts';
import { glimmervoidHomeDir, ABORT_CONFIG_SAVE } from './config-store.ts';
import type { ConfigStore, GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord, ReplayLog } from './core/control-replay-core.ts';
import { normalizeClientTrust } from './core/request-trust.ts';
import { mergeSettingsBlock, settingsBlockSpecFor, validateSettingsBlock } from './core/settings-block-core.ts';
import { readPosthogReport } from './radar/radar-report.ts';
import { willSessionRunGuarded } from './session/session-factory.ts';
import * as radarLaneCore from './radar/core/radar-lane-core.ts';
import { formatDiffAnnotationMessage } from './core/diff-annotations-core.ts';
import { buildGithubIssuePrompt, deriveIssueSessionName } from './github/core/github-issues-core.ts';
import { machineSkipsPermissionsByDefault } from './session/core/session-registry-core.ts';
import { prKey, prSessionName, prSessionPrompt } from './github/core/team-review-core.ts';
import type { PrSessionCheckout } from './github/team-review-wiring.ts';
import { mergeWorkflowsUpdateOverStored } from './core/workflows-core.ts';
import { createPrGh } from './github/pr-gh.ts';
import type { PrGh } from './github/pr-gh.ts';
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
import { getRtkPath } from './rtk-resolver.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';
import type { ChangeMap } from '../shared/contracts/change-map.ts';
import { TeamReviewActionRequest } from '../shared/contracts/team-review.ts';
import { BenchmarkActionRequest } from '../shared/contracts/benchmark.ts';
import type { BenchmarkActionResult, BenchmarkStatus } from '../shared/contracts/benchmark.ts';
import type { TeamReviewActionResult, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import { LinkedPr, MyPrKeepMergeableRequest, MyPrMergeRequest, MyPrMergeWhenReadyRequest } from '../shared/contracts/my-prs.ts';
import type { MyPrKeepMergeableResult, MyPrMergeResult, MyPrMergeWhenReadyResult, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import type { UpdateStatus } from './backend/backend-update.ts';
import type { UpdateApplyOutcome } from './update-apply.ts';
import type { PlanReadRequest, PlanReadResult } from './plan-review-wiring.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { CoherenceSessionFeed } from './coherence/coherence-session-feed.ts';
import type { CoherenceAdopt } from './coherence/coherence-adopt.ts';
import { judgeCoherenceAdoptRequest } from './coherence/core/coherence-adopt-core.ts';
import { CoherenceAdoptError } from '../shared/contracts/coherence.ts';
import type { TracePage, TracePageRequest } from './trace-wiring.ts';
import { createChangeMapService } from './change-map/change-map-wiring.ts';
import type { ChangeMapNarrator } from './change-map/change-map-wiring.ts';
import type { Telemetry } from './telemetry.ts';
import { errorCode, errorMessage, isMissingFileError } from '../shared/text.ts';
import { isRecord } from '../shared/coerce.ts';

type ControlRequest = ClientMessage;
type ControlHandler<Type extends ClientMessage['type']> = (msg: ClientMessageOf<Type>, ws: ControlSocket) => unknown;

interface RadarLaneStatus {
  projects?: unknown;
  [key: string]: unknown;
}

type TeamReviewActionOutcome = Omit<TeamReviewActionResult, 'key'>;

interface TeamReviewActionControl {
  refresh?: () => Promise<GithubPollingRefreshResult>;
  isRunning(): boolean;
  submitAction(request: TeamReviewActionRequest): Promise<TeamReviewActionOutcome>;
  preparePrSession?(key: string, projectPaths: readonly string[]): Promise<PrSessionCheckout>;
}

interface MyPrMergeControl {
  refresh?: () => Promise<GithubPollingRefreshResult>;
  mergePr(request: MyPrMergeRequest): Promise<Omit<MyPrMergeResult, 'key'>>;
  setKeepMergeable?: (request: MyPrKeepMergeableRequest) => Promise<Omit<MyPrKeepMergeableResult, 'key'>>;
  setMergeWhenReady?: (request: MyPrMergeWhenReadyRequest) => Promise<Omit<MyPrMergeWhenReadyResult, 'key'>>;
}

interface FactoryControl {
  queueIntent(request: FactoryQueueIntentRequest): Promise<FactoryQueueIntentResult>;
  control(request: FactoryControlRequest): Promise<FactoryControlResult>;
}

interface BenchmarkControl {
  getStatus(): BenchmarkStatus;
  submitAction(request: BenchmarkActionRequest): Promise<BenchmarkActionResult>;
}

interface ControlHandlerDeps {
  sessions: Map<string, Session>;
  agentSessions?: Map<string, Session>;

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
  getTeamReviewStatus?: (() => TeamReviewStatus | null) | null;
  getMyPrsStatus?: (() => MyPrsStatus | null) | null;
  getIssuesStatus?: (() => IssuesStatus | null) | null;
  issues?: { refresh: () => Promise<GithubPollingRefreshResult>; getLinkedSessionId?: (issueKey: string) => Promise<string | null>; linkSession?: (issueKey: string, sessionId: string) => Promise<void> } | null;
  teamReview?: TeamReviewActionControl | null;
  myPrs?: MyPrMergeControl | null;
  getFactoryState?: (() => FactoryState | null) | null;
  getBenchmarkStatus?: (() => BenchmarkStatus | null) | null;
  benchmarks?: BenchmarkControl | null;
  factory?: FactoryControl | null;
  createGithubClient?: (cwd: string) => Pick<PrGh, 'viewIssue'>;
  issueProjectRepos?: ((projectId: string) => Promise<string[]>) | null;
  serverBuild?: () => string | null;
  getUsageSessions?: (() => unknown) | null;
  getUsageReport?: (() => unknown) | null;
  requestUsageReport?: ((args: { days?: number; force?: boolean; requestId?: string | null }) => Promise<unknown>) | null;
  getPlanLimits?: (() => unknown) | null;
  changeMapNarrator?: ChangeMapNarrator | null;
  controlReplayLog?: ReplayLog | null;
  getRtkInstallStatus?: () => Record<string, unknown> | null;
  resolveRtkPath?: () => string | null;
  conversationFs?: typeof fs;
  conversationGit?: (args: string[], cwd: string) => Promise<string>;
  conversationProjectsDir?: string;
  readTracePage?: ((glimmervoidSessionId: string, request: TracePageRequest) => Promise<TracePage>) | null;
  readPlanRevision?: ((sessionId: string, request: PlanReadRequest) => Promise<PlanReadResult | null>) | null;
  decidePlanReview?: ((sessionId: string, decision: PlanDecision) => string | null) | null;
  sessionDocs?: SessionDocsPort | null;
  coherenceFeed?: Pick<CoherenceSessionFeed, 'readJournal'> | null;
  coherenceAdopt?: Pick<CoherenceAdopt, 'adopt'> | null;
  telemetry?: Pick<Telemetry, 'captureException' | 'captureClientError'> | null;
}

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

const SETTINGS_NOT_SAVED_MESSAGE = 'Settings were not saved: the config file could not be read, validated or written. The server log names the cause.';
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

function manualPrLink(pullRequestKey: string, myPrsStatus: MyPrsStatus | null, nowMs: number): LinkedPr | null {
  const separatorIndex = pullRequestKey.lastIndexOf('#');
  const repo = pullRequestKey.slice(0, separatorIndex);
  const number = Number(pullRequestKey.slice(separatorIndex + 1));
  const comparableKey = pullRequestKey.toLowerCase();
  const knownPr = myPrsStatus?.prs.find((pr) => pr.key.toLowerCase() === comparableKey);
  const canonicalPr = knownPr ?? { repo, number, url: `https://github.com/${repo}/pull/${number}` };
  const parsed = LinkedPr.safeParse({ repo: canonicalPr.repo, number: canonicalPr.number, url: canonicalPr.url, source: 'manual', linkedAt: nowMs });
  return parsed.success ? parsed.data : null;
}

function myPrMergeKey(msg: Record<string, unknown> | null | undefined): string {
  return typeof msg?.repo === 'string' && typeof msg.number === 'number' ? prKey(msg.repo, msg.number) : '';
}

function requestValidationErrorReply(msg: Record<string, unknown> | null | undefined, message: string): Record<string, unknown> | null {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  const builders: Record<string, () => Record<string, unknown>> = {
    'list-conversations': () => ({ type: 'conversations', requestId, id: typeof msg?.id === 'string' ? msg.id : null, conversations: [], error: message }),
    'resume-conversation': () => ({ type: 'resume-conversation-ack', id: typeof msg?.id === 'string' ? msg.id : undefined, ok: false, error: message }),
    'ping': () => ({ type: 'pong', requestId, error: message }),
    'get-settings': () => ({ type: 'settings-error', requestId, message }),
    'update-settings': () => ({ type: 'settings-error', requestId, message }),
    'scan-repo-roots': () => ({ type: 'repo-roots-scanned', requestId, directories: [], error: message }),
    'list-agents': () => ({ type: 'agents-listed', requestId, agents: [], error: message }),
    'get-radar-report': () => ({ type: 'radar-report', requestId, ok: false, found: false, issueId: null, error: message }),
    'radar-open-session': () => ({ type: 'radar-open-session-result', requestId, ok: false, error: message }),
    'issue-detail': () => ({ type: 'issue-detail-result', requestId, ok: false, body: null, error: message }),
    'open-issue-session': () => ({ type: 'open-issue-session-result', requestId, ok: false, error: message }),
    'open-team-review-session': () => ({ type: 'open-team-review-session-result', requestId, ok: false, error: message }),
    'radar-issue-action': () => ({ type: 'radar-issue-action-result', requestId, ok: false, error: message }),
    'radar-archive-investigation': () => ({ type: 'radar-archive-investigation-result', requestId, ok: false, error: message }),
    'team-review-action': () => ({ type: 'team-review-action-result', requestId, key: typeof msg?.key === 'string' ? msg.key : '', ok: false, error: message }),
    'github-polling-refresh': () => ({ type: 'github-polling-refresh-result', requestId, ok: false, error: message }),
    'my-pr-merge': () => ({ type: 'my-pr-merge-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-keep-mergeable': () => ({ type: 'my-pr-keep-mergeable-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'my-pr-merge-when-ready': () => ({ type: 'my-pr-merge-when-ready-result', requestId, key: myPrMergeKey(msg), ok: false, error: message }),
    'factory-queue-intent': () => ({ type: 'factory-queue-intent-result', requestId, projectId: typeof msg?.projectId === 'string' ? msg.projectId.slice(0, 128) : '', ok: false, error: message.slice(0, FACTORY_ERROR_MAX_CHARS) }),
    'factory-control': () => ({ type: 'factory-control-result', requestId, projectId: typeof msg?.projectId === 'string' ? msg.projectId.slice(0, 128) : '', action: FactoryControlRequest.shape.action.safeParse(msg?.action).data ?? 'pause', ok: false, error: message.slice(0, FACTORY_ERROR_MAX_CHARS) }),
    'benchmark-action': () => ({ type: 'benchmark-action-result', requestId, suiteId: typeof msg?.suiteId === 'string' ? msg.suiteId : '', action: typeof msg?.action === 'string' ? msg.action : 'run', ok: false, error: message }),
    'request-usage-report': () => ({ type: 'usage-report', requestId, error: message }),
    'request-hooks-report': () => ({ type: 'hooks-report', requestId, error: message }),
    'save-hook': () => ({ type: 'save-hook-result', requestId, ok: false, error: message }),
    'delete-hook': () => ({ type: 'delete-hook-result', requestId, ok: false, error: message }),
    'send-diff-annotations': () => ({ type: 'send-diff-annotations-result', requestId, ok: false, error: message }),
    'session-doc-read': () => ({ type: 'session-doc-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-doc-save': () => ({ type: 'session-doc-save-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, error: message }),
    'session-coherence-journal': () => ({ type: 'session-coherence-journal-response', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, entries: [], error: message }),
    'project-coherence-adopt': () => {
      const verdict = judgeCoherenceAdoptRequest(msg);
      return { type: 'project-coherence-adopt-response', requestId, projectId: typeof msg?.projectId === 'string' ? msg.projectId.slice(0, 128) : '', ok: false, error: verdict.ok ? CoherenceAdoptError.enum.invalidRequest : verdict.error };
    },
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
  if (genericErrorRequests.has(requestType)) return { type: 'error', message };
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
    checkNow = null,
    applyUpdate = null,
    noteRestartRequested = null,

    getRadarStatus,
    posthogReportsDir = null,

    posthogSetIssueStatus = null,
    radarArchiveInvestigation = null,
    getTeamReviewStatus = null,
    getMyPrsStatus = null,
    getIssuesStatus = null,
    issues = null,
    teamReview = null,
    myPrs = null,
    getBenchmarkStatus = null,
    getFactoryState = null,
    benchmarks = null,
    factory = null,

    createGithubClient = createPrGh,
    issueProjectRepos = null,

    serverBuild = () => null,

    getUsageSessions = null,
    getUsageReport = null,
    requestUsageReport = null,
    getPlanLimits = null,

    controlReplayLog = null,

    getRtkInstallStatus = (): Record<string, unknown> | null => null,

    resolveRtkPath = () => getRtkPath(),
    conversationFs = fs,
    conversationGit = runGitForConversationHistory,
    conversationProjectsDir = claudeProjectsDir(process.env, os.homedir()),
    readTracePage = null,
    readPlanRevision = null,
    decidePlanReview = null,
    sessionDocs = null,
    coherenceFeed = null,
    coherenceAdopt = null,
    changeMapNarrator = null,
  } = deps;

  const changeMaps = createChangeMapService({
    sessions,
    narrator: changeMapNarrator,
    onNarrationSettled: (sessionId) => {
      broadcastChangeMap(sessionId).catch((error: unknown) => {
        console.warn(`[control] change-map broadcast failed: id=${sessionId}: ${errorMessage(error)}`);
      });
    },
  });

  async function broadcastChangeMap(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    broadcastControl({ type: 'change-map', id: session.id, map: await changeMaps.build(session, { mayStartNarration: false }) });
  }

  function buildSettingsPayload() {
    return buildSettingsPayloadFrom({ configStore, rtkInstallStatus: getRtkInstallStatus() });
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

  const SESSION_NAME_RE = /^[a-zA-Z0-9_\-. ()]{1,64}$/;

  function handleAddSession(msg: ClientMessageOf<'add-session'>, ws: ControlSocket): void {
    const name = (msg.name || '').trim();
    const projectPath = (msg.path || '').trim();
    const repos = msg.repos;

    if (!name || (!projectPath && !repos)) {
      sendError(ws, 'Name and path are required');
      return;
    }

    if (!SESSION_NAME_RE.test(name)) {
      sendError(ws, 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)');
      return;
    }

    const requestedAgent = typeof msg.agent === 'string' ? msg.agent.trim() : '';
    if (requestedAgent && !isKnownAgentId(requestedAgent)) {
      sendError(ws, `Unknown agent "${requestedAgent}"`);
      return;
    }

    const skipPerms = typeof msg.dangerouslySkipPermissions === 'boolean'
      ? msg.dangerouslySkipPermissions
      : machineSkipsPermissionsByDefault(config);
    if (repos) {
      for (const repoPath of repos) {
        if (isExistingDirectory(repoPath)) continue;
        sendError(ws, missingFolderError(repoPath));
        return;
      }
    }
    const created = createProjectSession({
      name,
      path: projectPath,
      repos,
      agent: requestedAgent && requestedAgent !== DEFAULT_AGENT_ID ? requestedAgent : undefined,
      dangerouslySkipPermissions: skipPerms,
      unguarded: msg.unguarded === true,
      requireExistingPath: !repos,
    });
    if (!created.ok) {
      sendError(ws, created.error);
      return;
    }
    console.log(`[control] Added session via UI: ${name}${skipPerms ? ' (skip permissions)' : ' (permission prompts)'}`);
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

  function handleRemoveSession(msg: ClientMessageOf<'remove-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) {
      sendError(ws, 'Session not found');
      return;
    }

    if (agentSessions.get(sess.id) === sess) {
      sess.destroy();
      console.log(`[control] Removed spawned session via UI: ${sess.name}`);
      return;
    }

    const freshConfig = configStore.save(cfg => {
      cfg.projects = cfg.projects.filter(p => p.id !== sess.id);
    });
    if (freshConfig) applyConfigReload(freshConfig);
    console.log(`[control] Removed session via UI: ${sess.name}`);
  }

  function handleRenameSession(msg: ClientMessageOf<'rename-session'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    const newName = (msg.newName || '').trim();

    if (!sess || !newName) {
      sendError(ws, 'Session and new name are required');
      return;
    }

    if (sess.ephemeral) { sendError(ws, 'This session cannot be renamed'); return; }

    if (!SESSION_NAME_RE.test(newName)) {
      sendError(ws, 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)');
      return;
    }

    for (const [, other] of sessions) {
      if (other !== sess && other.name === newName) {
        sendError(ws, `Session "${newName}" already exists`);
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
    if (!session || !parsedTitle.success) {
      sendError(ws, `Session and a task of at most ${TASK_TITLE_MAX_LENGTH} characters without control characters are required`);
      return;
    }
    if (session.ephemeral) {
      sendError(ws, 'This session cannot have a custom task');
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
    const link = manualPrLink(msg.key, typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null, Date.now());
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

  function handleResumeConversation(msg: ClientMessageOf<'resume-conversation'>, ws: ControlSocket): void {
    const sess = findSession(msg);
    if (!sess) { sendError(ws, 'Session not found'); return; }
    if (sess.ephemeral) { sendError(ws, 'This session cannot resume a conversation'); return; }
    const raw = typeof msg.conversationId === 'string' ? msg.conversationId.trim() : '';
    const conversationId = raw || null;
    if (conversationId && !RESUME_ID_RE.test(conversationId)) {
      sendError(ws, 'Invalid conversation id');
      return;
    }

    const freshConfig = configStore.save(cfg => {
      const project = cfg.projects.find(p => p.id === sess.id);
      if (!project) return;
      if (conversationId) project.resumeSessionId = conversationId;
      else delete project.resumeSessionId;
    });
    if (freshConfig) applyConfigReload(freshConfig);

    const live = sessions.get(sess.id) || sess;
    live.setResumeConversation(conversationId);

    ws.send(JSON.stringify({ type: 'resume-conversation-ack', id: live.id, resumeSessionId: conversationId, ok: true }));
    console.log(`[control] resume-conversation: id=${live.id} -> ${conversationId || '(cleared)'}`);
  }

  function handleGetSettings(msg: ClientMessageOf<'get-settings'>, ws: ControlSocket): void {
    ws.send(JSON.stringify({
      type: 'settings',
      requestId: msg.requestId || null,
      settings: buildSettingsPayload()
    }));
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
      sendError(ws, SETTINGS_NOT_SAVED_MESSAGE, { type: 'settings-error', requestId: msg.requestId || null });
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

  async function handleGetRadarReport(msg: ClientMessageOf<'get-radar-report'>, ws: ControlSocket): Promise<void> {
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

  function createProjectSession({ name, path: projectPath, repos, baseBranch, agent, dangerouslySkipPermissions, unguarded, requireExistingPath }: { name: string; path: string; repos?: string[]; baseBranch?: string; agent?: ProjectEntry['agent']; dangerouslySkipPermissions?: boolean; unguarded?: boolean; requireExistingPath?: boolean }): { ok: true; project: ProjectEntry } | { ok: false; error: string } {
    for (const [, session] of sessions) {
      if (session.name !== name) continue;
      return { ok: false, error: `Session "${name}" already exists` };
    }
    const id = generateProjectId();
    let resolvedPath = path.resolve(projectPath);
    let workspaceRepos: string[] | undefined;
    if (repos) {
      const firstRepo = repos[0];
      if (!firstRepo) return { ok: false, error: 'A workspace needs at least two repositories' };
      const worktreeRoot = config.worktreeRoot || path.join(path.dirname(path.resolve(firstRepo)), '.glimmervoid-worktrees');
      const planned = planWorkspace({ worktreeRoot, sessionName: name, sessionId: id, repoPaths: repos });
      if (!planned.ok) return { ok: false, error: planned.error };
      resolvedPath = planned.plan.folder;
      workspaceRepos = planned.plan.members.map((member) => member.repoPath);
    }
    if (requireExistingPath && !fs.existsSync(resolvedPath)) return { ok: false, error: missingFolderError(projectPath) };
    const project: ProjectEntry = { id, name, path: resolvedPath };
    if (workspaceRepos) project.repos = workspaceRepos;
    if (baseBranch) project.baseBranch = baseBranch;
    if (typeof dangerouslySkipPermissions === 'boolean') project.dangerouslySkipPermissions = dangerouslySkipPermissions;
    if (unguarded) project.unguarded = true;
    if (agent) project.agent = agent;
    const freshConfig = configStore.save(cfg => {
      cfg.projects.push(project);
    });
    if (!freshConfig) return { ok: false, error: `Could not save session "${name}"` };
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
    const name = radarLaneCore.sanitizeSessionName(path.basename(resolvedPath))
      || radarLaneCore.sanitizeSessionName(posthogProjectName);
    if (!name) return null;
    const created = createProjectSession({ name, path: resolvedPath, agent: undefined });
    if (!created.ok) return null;
    console.log(`[control] posthog-open-session auto-created session: ${name} (${resolvedPath})`);
    return created.project;
  }

  function findConfiguredProject(projectId: unknown): ProjectEntry | null {
    if (typeof projectId !== 'string') return null;
    return config.projects.find((project) => project.id === projectId) ?? null;
  }

  function canRestoreGuardrails(session: Session): boolean {
    if (!session.isGuardrailsReleased) return false;
    const project = findConfiguredProject(session.id);
    if (!project) return false;
    return willSessionRunGuarded({ ...project, unguarded: false }, config, null);
  }

  const issueOpenQueue = createKeyedSerialQueue();

  async function handleIssueDetail(request: ClientMessageOf<'issue-detail'>, ws: ControlSocket): Promise<void> {
    try {
      const viewed = await createGithubClient(glimmervoidHomeDir()).viewIssue(request.issueNumber, request.repo);
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
      const viewed = await createGithubClient(path.resolve(project.path)).viewIssue(issueNumber, repo);
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
    try {
      const linkedSession = sessionLinkedToPr(msg.key);
      if (linkedSession) {
        reply({ ok: true, sessionId: linkedSession.id, sessionName: linkedSession.name, existing: true });
        return;
      }
      if (!teamReview?.preparePrSession) { reply({ error: 'Team review is not running' }); return; }
      const singleRepoProjects = config.projects.filter((project) => !project.repos);
      const checkout = await teamReview.preparePrSession(msg.key, singleRepoProjects.map((project) => project.path));
      if (!checkout.ok) { reply({ error: checkout.error }); return; }
      const sourceProject = checkout.isConfiguredProject ? singleRepoProjects.find((project) => project.path === checkout.checkoutPath) : undefined;
      const isPrSessionGuarded = willSessionRunGuarded({ path: checkout.checkoutPath, agent: sourceProject?.agent }, config, null);
      const created = createProjectSession({
        name: prSessionName(checkout.repo, checkout.detail.number, checkout.detail.title),
        path: checkout.checkoutPath,
        baseBranch: checkout.baseBranch,
        agent: sourceProject?.agent,
        dangerouslySkipPermissions: isPrSessionGuarded ? sourceProject?.dangerouslySkipPermissions : false,
      });
      if (!created.ok) { reply({ error: created.error }); return; }
      const session = sessions.get(created.project.id);
      if (!session) { reply({ error: `Session "${created.project.name}" is not loaded` }); return; }
      const link = manualPrLink(msg.key, typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null, Date.now());
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
    if (!teamReview?.isRunning()) { reply({ ok: false, error: 'Team review is not running' }); return; }
    reply(await teamReview.submitAction(parsed.data));
  }

  async function handleGithubPollingRefresh(msg: ClientMessageOf<'github-polling-refresh'>, ws: ControlSocket): Promise<void> {
    const lane = { 'my-prs': myPrs, 'team-review': teamReview, issues }[msg.lane];
    if (!lane?.refresh) {
      replyTo(ws, msg, 'github-polling-refresh-result', { ok: false, error: 'Reviews polling is not running.' });
      return;
    }
    replyTo(ws, msg, 'github-polling-refresh-result', await lane.refresh());
  }

  async function handleMyPrMerge(msg: ClientMessageOf<'my-pr-merge'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    if (!myPrs) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.mergePr(parsed.data));
  }

  async function handleMyPrKeepMergeable(msg: ClientMessageOf<'my-pr-keep-mergeable'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrKeepMergeableResult, 'key'>) => replyTo(ws, msg, 'my-pr-keep-mergeable-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrKeepMergeableRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    if (!myPrs?.setKeepMergeable) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setKeepMergeable(parsed.data));
  }

  async function handleMyPrMergeWhenReady(msg: ClientMessageOf<'my-pr-merge-when-ready'>, ws: ControlSocket): Promise<void> {
    const reply = (outcome: Omit<MyPrMergeWhenReadyResult, 'key'>) => replyTo(ws, msg, 'my-pr-merge-when-ready-result', { key: myPrMergeKey(msg), ...outcome });
    const parsed = MyPrMergeWhenReadyRequest.safeParse(msg);
    if (!parsed.success) { reply({ ok: false, error: configIssueMessage(parsed.error) }); return; }
    if (!myPrs?.setMergeWhenReady) { reply({ ok: false, error: 'My pull requests is not running' }); return; }
    reply(await myPrs.setMergeWhenReady(parsed.data));
  }

  function factoryRequestError(projectId: string): string | null {
    if (!config.projects?.some((project) => project.id === projectId)) return 'Unknown factory project';
    if (!factory || config.factory?.enabled !== true) return 'Factory is not running';
    return null;
  }

  async function handleFactoryQueueIntent(msg: ClientMessageOf<'factory-queue-intent'>, ws: ControlSocket): Promise<void> {
    const error = factoryRequestError(msg.projectId);
    if (error || !factory) {
      replyTo(ws, msg, 'factory-queue-intent-result', { projectId: msg.projectId, ok: false, error });
      return;
    }
    replyTo(ws, msg, 'factory-queue-intent-result', await factory.queueIntent(msg));
  }

  async function handleFactoryControl(msg: ClientMessageOf<'factory-control'>, ws: ControlSocket): Promise<void> {
    const parsed = FactoryControlRequest.safeParse(msg);
    if (!parsed.success) {
      replyTo(ws, msg, 'factory-control-result', { projectId: msg.projectId, action: msg.action, ok: false, error: configIssueMessage(parsed.error).slice(0, FACTORY_ERROR_MAX_CHARS) });
      return;
    }
    const error = factoryRequestError(msg.projectId);
    if (error || !factory) {
      replyTo(ws, msg, 'factory-control-result', { projectId: msg.projectId, action: msg.action, ok: false, error });
      return;
    }
    replyTo(ws, msg, 'factory-control-result', await factory.control(parsed.data));
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

  async function handleRadarArchiveInvestigation(msg: ClientMessageOf<'radar-archive-investigation'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'radar-archive-investigation-result', { ok: false, error: null, ...payload });
    const ref = radarLaneCore.validateInvestigationId(msg.id);
    if (!ref.ok) { reply({ error: ref.error }); return; }
    if (!radarArchiveInvestigation) { reply({ error: 'PostHog monitoring is not running' }); return; }
    const res = await radarArchiveInvestigation({ id: ref.id });
    reply({ ok: res.ok === true, error: res.error || null });
  }

  function handleSendDiffAnnotations(msg: ClientMessageOf<'send-diff-annotations'>, ws: ControlSocket): void {
    const reply = (payload: Record<string, unknown>) => replyTo(ws, msg, 'send-diff-annotations-result', { ok: false, error: null, ...payload });
    const session = findSession(msg);
    if (!session) { reply({ error: 'Session not found' }); return; }
    const text = formatDiffAnnotationMessage(msg.annotations ?? []);
    if (!text) { reply({ error: 'No review notes to send' }); return; }
    const pasted = session.pasteTextWhenReady(text);
    if (!pasted.ok) { reply({ error: `Could not write to "${session.name}" (${pasted.reason})` }); return; }
    reply({ ok: true, pending: pasted.deferred === true });
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
    const rtkPath = config.rtk ? resolveRtkPath() : null;
    if (rtkPath) hookTools.push({ id: 'rtk', binPath: rtkPath });
    const saneYoloPath = config.saneYolo !== false ? resolvePackageBin('cc-safety-net', 'cc-safety-net') : null;
    if (saneYoloPath) hookTools.push({ id: 'saneYolo', binPath: saneYoloPath });
    return describeBuiltinHooks({
      detectScheduledWakeups: config.detectScheduledWakeups !== false,
      hookTools,
      planReview: config.planReview?.enabled !== false,
      conversationApprovals: config.conversationView === true,
    });
  }

  function hooksReportProjects(): { id: string; name: string; agent: string }[] {
    return (config.projects || [])
      .filter((project): project is ProjectEntry & { id: string; name: string } => (
        typeof project?.id === 'string' && typeof project?.name === 'string'
      ))
      .map((project) => ({ id: project.id, name: project.name, agent: typeof project.agent === 'string' ? project.agent : DEFAULT_AGENT_ID }));
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
      sendError(ws, '[update-check-unavailable] Update checking is unavailable.');
      return;
    }
    await checkNow();
  }

  async function handleUpdateApply(_msg: ClientMessageOf<'update-apply'>, ws: ControlSocket): Promise<void> {
    if (!applyUpdate) {
      sendError(ws, '[update-apply-unavailable] Update application is unavailable.');
      return;
    }
    const outcome = await applyUpdate();
    if (outcome.ok) return;
    sendError(ws, `[${outcome.reason || 'update-refused'}] ${outcome.message}`);
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
    'update-settings':  handleUpdateSettings,
    'scan-repo-roots':  handleScanRepoRoots,
    'list-agents':      handleListAgents,
    'get-radar-report': handleGetRadarReport,
    'radar-open-session': handleRadarOpenSession,
    'issue-detail': handleIssueDetail,
    'open-team-review-session': (msg: ClientMessageOf<'open-team-review-session'>, ws: ControlSocket) => prSessionOpenQueue.run(msg.key.toLowerCase(), () => handleOpenTeamReviewSession(msg, ws)),
    'open-issue-session': (msg: ClientMessageOf<'open-issue-session'>, ws: ControlSocket) => issueOpenQueue.run(`${msg.repo.toLowerCase()}#${msg.issueNumber}`, () => handleOpenIssueSession(msg, ws)),
    'radar-issue-action': handleRadarIssueAction,
    'radar-archive-investigation': handleRadarArchiveInvestigation,
    'team-review-action': handleTeamReviewAction,
    'my-pr-merge': handleMyPrMerge,
    'my-pr-keep-mergeable': handleMyPrKeepMergeable,
    'my-pr-merge-when-ready': handleMyPrMergeWhenReady,
    'github-polling-refresh': handleGithubPollingRefresh,
    'benchmark-action': handleBenchmarkAction,
    'factory-queue-intent': handleFactoryQueueIntent,
    'factory-control': handleFactoryControl,
    'request-usage-report': handleRequestUsageReport,
    'request-hooks-report': handleRequestHooksReport,
    'save-hook': handleSaveHook,
    'delete-hook': handleDeleteHook,
    'send-diff-annotations': handleSendDiffAnnotations,
    'kill':             (msg: ClientMessageOf<'kill'>) => { const s = findSession(msg); if (s) s.killSession(); },
    'start-session':    handleStartSession,
    'restart':          (msg: ClientMessageOf<'restart'>) => { const s = findSession(msg); if (s) s.restart({ fresh: msg.fresh === true }); },
    'force-restart':    (msg: ClientMessageOf<'force-restart'>) => { const s = findSession(msg); if (s) s.forceRestart({ fresh: msg.fresh === true }); },
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
        const { committed, uncommitted, hasCommits } = await s.getDiff();
        ws.send(JSON.stringify({ type: 'session-diff', id: s.id, committed, uncommitted, hasCommits }));
      } catch (error) {
        console.warn(`[control] request-session-diff failed: id=${s.id}: ${errorMessage(error)}`);
        ws.send(JSON.stringify({ type: 'session-diff-error', id: s.id, message: firstGitErrorLine(error) }));
      }
    },

    'request-change-map':         async (msg: ClientMessageOf<'request-change-map'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const map = await changeMaps.build(s).catch((error: unknown): ChangeMap => {
        console.warn(`[control] request-change-map build failed: id=${s.id}: ${errorMessage(error)}`);
        return {
          sessionId: s.id, sig: null, generatedAt: Date.now(), repos: [], narrative: null, narratorState: 'disabled',
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
      if (!s) { sendError(ws, 'Session not found'); return; }
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
    'conversation-approval': (message: ClientMessageOf<'conversation-approval'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) return sendError(ws, 'Session not found', { id: message.id, scope: 'conversation-approval' });
      if (session.answerConversationApproval(message.requestId, message.decision, message.answers)) return;
      sendError(ws, 'That approval is no longer pending', { id: session.id, scope: 'conversation-approval' });
    },
    'set-session-conversation-view': (message: ClientMessageOf<'set-session-conversation-view'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) return sendError(ws, 'Session not found', { id: message.id, scope: 'conversation-view' });
      if (session.ephemeral) return sendError(ws, 'This session cannot use the conversation view', { id: session.id, scope: 'conversation-view' });
      if (message.isOn && session.isConversationBridgeRefused()) return sendError(ws, 'This Codex session is guarded or bypasses hook trust, so it can only use the terminal.', { id: session.id, scope: 'conversation-view' });
      const freshConfig = configStore.save((config) => {
        const project = config.projects.find((candidate) => candidate.id === session.id);
        if (!project) return;
        if (!message.isOn) {
          delete project.conversationView;
          return;
        }
        project.conversationView = true;
      });
      if (freshConfig) applyConfigReload(freshConfig);
      session.announceConversationView();
    },
    'set-session-guardrails': (message: ClientMessageOf<'set-session-guardrails'>, ws: ControlSocket) => {
      const session = findSession(message);
      if (!session) return sendError(ws, 'Session not found', { id: message.id, scope: 'guardrails' });
      if (session.ephemeral) return sendError(ws, 'This session cannot change its guardrails', { id: session.id, scope: 'guardrails' });
      if (message.isOn && !session.isGuarded && !canRestoreGuardrails(session)) return sendError(ws, 'Guardrails cannot cover this session, so restoring them would only restart it', { id: session.id, scope: 'guardrails' });
      const freshConfig = configStore.save((config) => {
        const project = config.projects.find((candidate) => candidate.id === session.id);
        if (!project) return ABORT_CONFIG_SAVE;
        if (message.isOn) {
          delete project.unguarded;
          return undefined;
        }
        project.unguarded = true;
        return undefined;
      });
      if (!freshConfig) return sendError(ws, `Could not save session "${session.name}"`, { id: session.id, scope: 'guardrails' });
      applyConfigReload(freshConfig);
      console.log(`[control] Guardrails ${message.isOn ? 'restored' : 'released'} via UI: ${session.name}`);
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
    'project-coherence-adopt': async (message: ClientMessageOf<'project-coherence-adopt'>, ws: ControlSocket) => {
      if (!coherenceAdopt) return replyTo(ws, message, 'project-coherence-adopt-response', { projectId: message.projectId, ok: false, error: CoherenceAdoptError.enum.failed });
      replyTo(ws, message, 'project-coherence-adopt-response', await coherenceAdopt.adopt(message));
    },
    'session-coherence-journal': async (message: ClientMessageOf<'session-coherence-journal'>, ws: ControlSocket) => {
      const reply = { type: 'session-coherence-journal-response', requestId: message.requestId ?? null, id: message.id };
      const session = findSession(message);
      if (!coherenceFeed || !session) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: 'Session not found' }));
      const journal = await coherenceFeed.readJournal(session);
      if (!journal.ok) return ws.send(JSON.stringify({ ...reply, ok: false, entries: [], error: journal.error }));
      ws.send(JSON.stringify({ ...reply, ok: true, entries: journal.entries }));
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
    recheckPostTurnLeftovers?.();

    const radarStatus = typeof getRadarStatus === 'function' ? getRadarStatus() : null;
    if (radarStatus) {
      ws.send(JSON.stringify(radarStatus));
    }

    const teamReviewStatus = typeof getTeamReviewStatus === 'function' ? getTeamReviewStatus() : null;
    if (teamReviewStatus) ws.send(JSON.stringify(teamReviewStatus));
    const myPrsStatus = typeof getMyPrsStatus === 'function' ? getMyPrsStatus() : null;
    if (myPrsStatus) ws.send(JSON.stringify(myPrsStatus));
    const issuesStatus = getIssuesStatus?.();
    if (issuesStatus) ws.send(JSON.stringify(issuesStatus));
    const benchmarkStatus = typeof getBenchmarkStatus === 'function' ? getBenchmarkStatus() : null;
    if (benchmarkStatus) ws.send(JSON.stringify(benchmarkStatus));
    const factoryState = getFactoryState?.() ?? null;
    if (factoryState) ws.send(JSON.stringify(factoryState));

    const usageSessions = typeof getUsageSessions === 'function' ? getUsageSessions() : null;
    if (usageSessions) {
      ws.send(JSON.stringify(usageSessions));
    }
    const usageReport = typeof getUsageReport === 'function' ? getUsageReport() : null;
    if (usageReport) {
      ws.send(JSON.stringify(usageReport));
    }

    const planLimits = typeof getPlanLimits === 'function' ? getPlanLimits() : null;
    if (planLimits) {
      ws.send(JSON.stringify(planLimits));
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

  return { buildSnapshot };
}

export {
  registerControlHandlers,
};
export type { FactoryControl, BenchmarkControl, ControlHandlerDeps, MyPrMergeControl, TeamReviewActionControl };
