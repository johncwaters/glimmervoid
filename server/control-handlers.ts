import type fs from 'node:fs';
import type { WebSocket, WebSocketServer } from 'ws';
import { ClientMessage, configIssueMessage, type ClientMessageOf, type ServerMessageOf } from '../shared/contracts/index.ts';
import type { IssuesStatus } from '../shared/contracts/issues.ts';
import type { GithubPollingRefreshResult, GithubPrsFreshness } from '../shared/contracts/github-polling.ts';
import type { GithubPrsFrame } from '../shared/contracts/github-prs.ts';
import type { PlanDecision } from '../shared/contracts/plan-review.ts';
import type { UpdateJournal } from '../shared/contracts/update-journal.ts';
import type { TeamReviewActionRequest, TeamReviewActionResult, TeamReviewStatus } from '../shared/contracts/team-review.ts';
import type { CommunityActionRequest, CommunityActionResult } from '../shared/contracts/community.ts';
import type { BenchmarkActionRequest, BenchmarkActionResult, BenchmarkStatus } from '../shared/contracts/benchmark.ts';
import type { MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsSnapshot } from '../shared/contracts/my-prs.ts';
import { errorMessage } from '../shared/text.ts';
import type { Session } from '../session/sessions.ts';
import type { ControlSocket } from './backend/backend-websockets.ts';
import type { UpdateStatus } from './backend/backend-update.ts';
import type { ConfigStore, GlimmervoidConfig, ProjectEntry } from './config-store.ts';
import type { ControlMessageRecord, ReplayLog } from './core/control-replay-core.ts';
import type { TelegramDeliveryControl } from './core/telegram-delivery-core.ts';
import { normalizeClientTrust } from './core/request-trust.ts';
import type * as radarLaneCore from './radar/core/radar-lane-core.ts';
import type { PrSessionCheckout } from './github/team-review-wiring.ts';
import type { GithubLaneStore } from './github/github-store-wiring.ts';
import type { FeatureHintsWiring } from './feature-hints-wiring.ts';
import type { UpdateApplyOutcome } from './update-apply.ts';
import type { PlanReadRequest, PlanReadResult } from './plan-review-wiring.ts';
import type { SessionDocsPort } from './session/session-docs-wiring.ts';
import type { WhiteboardPort } from './whiteboard/whiteboard-wiring.ts';
import type { CoherenceSessionFeed } from './coherence/coherence-session-feed.ts';
import type { TracePage, TracePageRequest } from './trace-wiring.ts';
import type { ChangeMapService } from './change-map/change-map-wiring.ts';
import type { Telemetry } from './telemetry.ts';
import type { createCoderEnvWiring } from './coder/coder-env-wiring.ts';
import type { createAgentConnect } from './agent-login/agent-connect.ts';
import type { RemoteSetupAgent, RemoteSetupOutcome } from './remote-setup-wiring.ts';
import type { GitWorkspaceInstance } from './git/git-workspace.ts';
import { createControlContext } from './control/control-context.ts';
import { mergeHandlerGroups, validationErrorReply } from './control/core/control-dispatch-core.ts';
import { createCommunityHandlers } from './control/handlers/community-handlers.ts';
import { createGithubHandlers } from './control/handlers/github-handlers.ts';
import { createInspectHandlers } from './control/handlers/inspect-handlers.ts';
import { createLaneHandlers } from './control/handlers/lane-handlers.ts';
import { createRadarHandlers } from './control/handlers/radar-handlers.ts';
import { createServerHandlers } from './control/handlers/server-handlers.ts';
import { createSessionHandlers } from './control/handlers/session-handlers.ts';
import { createSettingsHandlers } from './control/handlers/settings-handlers.ts';
import { createWhiteboardHandlers } from './control/handlers/whiteboard-handlers.ts';
import { createWorktreeHandlers } from './control/handlers/worktree-handlers.ts';

type ControlRequest = ClientMessage;

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
  changeMaps?: ChangeMapService;
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
  acknowledgeSeenAlert?: ((sessionId: string) => void) | null;
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
  issues?: { refresh: () => Promise<GithubPollingRefreshResult>; getLinkedSessionId?: (issueKey: string) => Promise<string | null>; linkSession?: (issueKey: string, sessionId: string) => Promise<void>; setIssueState?: (change: { repo: string; number: number; state: 'closed' | 'open' }) => Promise<{ ok: boolean; err: string }> } | null;
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
  const { serverBuild = () => null, controlReplayLog = null } = deps;
  const context = createControlContext(deps);
  const session = createSessionHandlers(context, deps);
  const github = createGithubHandlers(context, deps);
  const merged = mergeHandlerGroups([
    createServerHandlers(context, deps),
    createRadarHandlers(context, deps),
    github,
    createCommunityHandlers(context, deps),
    { handlers: {}, connectFrames: github.lateConnectFrames },
    createLaneHandlers(context, deps),
    session,
    createWorktreeHandlers(context, deps),
    createSettingsHandlers(context, deps),
    createWhiteboardHandlers(context, deps),
    createInspectHandlers(context, deps),
  ]);

  function buildSnapshot() {
    const list: unknown[] = [];
    for (const [, sess] of context.sessions) {
      list.push(sess.toSnapshot());
    }
    for (const [, sess] of context.agentSessions) {
      list.push(sess.toSnapshot());
    }

    return {
      type: 'snapshot', sessions: list, serverBuild: serverBuild(),
    };
  }

  function dispatchControlRequest<Type extends ClientMessage['type']>(request: { [Variant in ClientMessage['type']]: ClientMessageOf<Variant> }[Type], ws: ControlSocket) {
    const handler = merged.handlers[request.type];
    if (handler) return handler(request, ws);
    return undefined;
  }

  controlWss.on('connection', (socket: WebSocket, req) => {
    const ws = socket as ControlSocket;
    ws.send(JSON.stringify(buildSnapshot()));

    ws.send(JSON.stringify({ type: 'client-trust', trust: normalizeClientTrust(ws.glimmervoidTrust) }));
    for (const step of merged.connectSteps) {
      for (const frame of step.connectFrames?.() ?? []) ws.send(JSON.stringify(frame));
      step.afterConnect?.();
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
        const reply = validationErrorReply(merged, msg, message);
        if (reply) ws.send(JSON.stringify(reply));
        return;
      }
      const request: ControlRequest = parsedMessage.data;
      if (!Object.hasOwn(merged.handlers, request.type)) return;

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

  return { buildSnapshot, removeExitedSession: session.removeExitedSession };
}

export {
  registerControlHandlers,
};
export type { BenchmarkControl, CommunityActionControl, ControlHandlerDeps, MyPrMergeControl, RadarFixControl, TeamReviewActionControl };
