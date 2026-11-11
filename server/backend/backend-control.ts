import type { GithubLaneStore } from '../github/github-store-wiring.ts';
import type { IssuesStatus } from '../../shared/contracts/issues.ts';
import type { GithubPollingRefreshResult, GithubPrsFreshness } from '../../shared/contracts/github-polling.ts';
import type { GithubPrsFrame } from '../../shared/contracts/github-prs.ts';
import type { WebSocket } from 'ws';
import type { Session } from '../../session/sessions.ts';
import type { ControlBroadcast, ControlConnectionHandler } from './backend-websockets.ts';
import type { ConfigStore, GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import { registerControlHandlers } from '../control-handlers.ts';
import type { RaceLauncher } from '../race/race-launch.ts';
import type { CommunityActionControl, ControlHandlerDeps, MyPrMergeControl, RadarFixControl, TeamReviewActionControl } from '../control-handlers.ts';
import type { ReplayLog } from '../core/control-replay-core.ts';
import type { TelegramDeliveryControl } from '../core/telegram-delivery-core.ts';
import type { TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { MyPrsSnapshot } from '../../shared/contracts/my-prs.ts';
import type { UpdateJournal } from '../../shared/contracts/update-journal.ts';
import type { PlanLimitsVendor, ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { UpdateApplyOutcome } from '../update-apply.ts';
import type { UpdateStatus } from './backend-update.ts';
import type { TerminalColors } from '../../session/core/terminal-color-query.ts';
import type { TracePage, TracePageRequest } from '../trace-wiring.ts';
import type { Telemetry } from '../telemetry.ts';
import { errorMessage } from '../../shared/text.ts';
import type { SessionDocsPort } from '../session/session-docs-wiring.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import type { ReviewPort } from '../review/review-wiring.ts';
import type { CoherenceSessionFeed } from '../coherence/coherence-session-feed.ts';
import type { ChangeMapService } from '../change-map/change-map-wiring.ts';
import type { SecretsBroker } from '../secrets/secrets-broker.ts';

interface SnapshotLane {
  snapshotMessage: () => Record<string, unknown>;
}

interface LaneReader {
  githubStore: { snapshotMessage: () => GithubPrsFrame; getFreshness: () => GithubPrsFreshness; laneStore: Pick<GithubLaneStore, 'requestIssue' | 'requestViewer' | 'requestViewerTeams'> };
  coderEnv: NonNullable<ControlHandlerDeps['coderEnv']>;
  gitWorkspace: NonNullable<ControlHandlerDeps['remoteRepoGit']>;
  starHint: NonNullable<ControlHandlerDeps['starHint']>;
  prFlows: NonNullable<ControlHandlerDeps['prFlows']>;
  packStore: NonNullable<ControlHandlerDeps['packs']>;
  packData: NonNullable<ControlHandlerDeps['packData']>;
  races: NonNullable<ControlHandlerDeps['races']>;
}

interface RadarControl extends RadarFixControl {
  getStatus: () => Record<string, unknown> | null;
  setIssueStatus: (args: { projectId: string; issueId: string; action: string }) => Promise<Record<string, unknown>>;
  archiveInvestigation: (args: { id: string }) => Promise<Record<string, unknown>>;
}

interface CommunityControl extends CommunityActionControl {
  getStatus: () => Record<string, unknown> | null;
}

interface TeamReviewControl extends TeamReviewActionControl {
  getStatus: () => TeamReviewStatus | null;
}

interface UsageControl {
  getSessionsMessage: () => Record<string, unknown> | null;
  getCachedReport: () => Record<string, unknown> | null;
  requestReport: (args: { days?: number; force?: boolean; requestId?: string | null }) => Promise<Record<string, unknown>>;
  getPlanLimitsMessage: (vendor?: PlanLimitsVendor) => Record<string, unknown> | null;
}

interface BackendControlDependencies {
  onControlConnection: (handleConnection: ControlConnectionHandler) => void;
  sessions: Map<string, Session>;
  agentSessions: Map<string, Session>;
  markChildWorktreeDiscard: (childId: string) => void;
  config: GlimmervoidConfig;
  configStore: ConfigStore;
  broadcastControl: ControlBroadcast;
  controlReplayLog: ReplayLog;
  agentConnect: NonNullable<ControlHandlerDeps['agentConnect']>;
  remoteSetup: NonNullable<ControlHandlerDeps['remoteSetup']>;
  hostLinks: NonNullable<ControlHandlerDeps['hostLinks']>;
  telegramDelivery: TelegramDeliveryControl;
  generateProjectId: () => string;
  makeSession: (project: ProjectEntry, config: GlimmervoidConfig) => Session;
  wireSessionEvents: (session: Session) => void;
  applyConfigReload: (config: GlimmervoidConfig) => void;
  applySettingsReload: (config: GlimmervoidConfig) => void;
  requestShutdown: () => unknown;
  requestRestart: () => unknown;
  acknowledgeSeenAlert: (sessionId: string) => void;
  setTerminalColors: (colors: TerminalColors) => void;
  buildHealthSnapshot: () => Record<string, unknown>;
  getUpdateStatus: () => UpdateStatus | null;
  getUpdateJournal: () => UpdateJournal;
  getPostTurnLeftoversNotice: () => ServerMessageOf<'post-turn-leftovers'> | null;
  recheckPostTurnLeftovers: () => void;
  checkNow: () => Promise<UpdateStatus>;
  applyUpdate: () => Promise<UpdateApplyOutcome>;
  noteRestartRequested: () => void;
  laneAssembly: LaneReader;
  posthog: RadarControl;
  teamReview: TeamReviewControl;
  community: CommunityControl;
  myPrs: MyPrMergeControl & { getStatus: () => MyPrsSnapshot };
  issues: { getStatus: () => IssuesStatus; refresh: () => Promise<GithubPollingRefreshResult>; projectRepoSlugs: (projectId: string) => Promise<string[]>; getLinkedSessionId: (issueKey: string) => Promise<string | null>; linkSession: (issueKey: string, sessionId: string) => Promise<void>; setIssueState: (change: { repo: string; number: number; state: 'closed' | 'open' }) => Promise<{ ok: boolean; err: string }> };
  usage: UsageControl;
  readTracePage: ((glimmervoidSessionId: string, request: TracePageRequest) => Promise<TracePage>) | null;
  sessionDocs: SessionDocsPort;
  secrets: SecretsBroker;
  whiteboards: Pick<WhiteboardPort, 'handleOperator' | 'snapshotMessage' | 'tiles'>;
  reviews: ReviewPort;
  changeMaps: ChangeMapService;
  coherenceFeed: CoherenceSessionFeed;
  serverBuild: () => string;
  telemetry: Pick<Telemetry, 'capture' | 'captureException' | 'captureClientError' | 'requestDataDeletion'>;
  logger: Pick<Console, 'warn'>;
}

function createBackendControl(dependencies: BackendControlDependencies): { removeExitedSession: (id: string) => void; raceLauncher: RaceLauncher } {
  const {
    onControlConnection,
    sessions,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    laneAssembly,
    posthog,
    teamReview,
    community,
    myPrs,
    issues,
    usage,
    logger,
  } = dependencies;

  const controlHandlers = registerControlHandlers(onControlConnection, {
    sessions,
    agentSessions: dependencies.agentSessions,
    markChildWorktreeDiscard: dependencies.markChildWorktreeDiscard,
    config,
    configStore,
    broadcastControl,
    controlReplayLog,
    telegramDelivery: dependencies.telegramDelivery,
    generateProjectId: dependencies.generateProjectId,
    makeSession: dependencies.makeSession,
    wireSessionEvents: dependencies.wireSessionEvents,
    applyConfigReload: dependencies.applyConfigReload,
    applySettingsReload: dependencies.applySettingsReload,
    requestShutdown: dependencies.requestShutdown,
    requestRestart: dependencies.requestRestart,
    acknowledgeSeenAlert: dependencies.acknowledgeSeenAlert,
    setTerminalColors: dependencies.setTerminalColors,
    buildHealthSnapshot: dependencies.buildHealthSnapshot,
    getUpdateStatus: dependencies.getUpdateStatus,
    getUpdateJournal: dependencies.getUpdateJournal,
    getPostTurnLeftoversNotice: dependencies.getPostTurnLeftoversNotice,
    starHint: laneAssembly.starHint,
    recheckPostTurnLeftovers: dependencies.recheckPostTurnLeftovers,
    checkNow: dependencies.checkNow,
    applyUpdate: dependencies.applyUpdate,
    noteRestartRequested: dependencies.noteRestartRequested,
    getRadarStatus: () => posthog.getStatus(),
    posthogSetIssueStatus: (args) => posthog.setIssueStatus(args),
    radarArchiveInvestigation: (args) => posthog.archiveInvestigation(args),
    radarFixes: posthog,
    getTeamReviewStatus: () => teamReview.getStatus(),
    getCommunityStatus: () => community.getStatus(),
    getMyPrsStatus: () => myPrs.getStatus(),
    getIssuesStatus: () => issues.getStatus(),
    issueProjectRepos: (projectId) => issues.projectRepoSlugs(projectId),
    teamReview,
    community,
    myPrs,
    prFlows: laneAssembly.prFlows,
    packs: laneAssembly.packStore,
    packData: laneAssembly.packData,
    races: laneAssembly.races,
    issues,
    githubStore: laneAssembly.githubStore,
    requestIssue: laneAssembly.githubStore.laneStore.requestIssue,
    requestViewer: laneAssembly.githubStore.laneStore.requestViewer,
    requestViewerTeams: laneAssembly.githubStore.laneStore.requestViewerTeams,
    serverBuild: dependencies.serverBuild,
    telemetry: dependencies.telemetry,
    getUsageSessions: () => usage.getSessionsMessage(),
    getUsageReport: () => usage.getCachedReport(),
    requestUsageReport: (args) => usage.requestReport(args),
    getPlanLimits: () => [usage.getPlanLimitsMessage('claude'), usage.getPlanLimitsMessage('codex'), usage.getPlanLimitsMessage('kimi')],
    readTracePage: dependencies.readTracePage,
    sessionDocs: dependencies.sessionDocs,
    secrets: dependencies.secrets,
    whiteboards: dependencies.whiteboards,
    reviews: dependencies.reviews,
    changeMaps: dependencies.changeMaps,
    coherenceFeed: dependencies.coherenceFeed,
    coderEnv: laneAssembly.coderEnv,
    remoteRepoGit: laneAssembly.gitWorkspace,
    agentConnect: dependencies.agentConnect,
    remoteSetup: dependencies.remoteSetup,
    hostLinks: dependencies.hostLinks,
  });

  const sendLaneSnapshotOnConnect = (
    laneName: string,
    readLane: () => SnapshotLane | null,
  ): void => {
    onControlConnection((socket: WebSocket) => {
      if (socket.readyState !== 1) return;
      const lane = readLane();
      if (!lane) return;
      try {
        socket.send(JSON.stringify(lane.snapshotMessage()));
      } catch (sendError) {
        logger.warn(`[${laneName}] connect-time snapshot send failed: ${errorMessage(sendError)}`);
      }
    });
  };

  sendLaneSnapshotOnConnect('session-docs', () => dependencies.sessionDocs);
  sendLaneSnapshotOnConnect('secret-requests', () => ({ snapshotMessage: () => ({ type: 'secret-requests-snapshot', requests: dependencies.secrets.requestsSnapshot(), newItemsVault: dependencies.secrets.newItemsVault() }) }));
  sendLaneSnapshotOnConnect('secret-approvals', () => ({ snapshotMessage: () => ({ type: 'secret-approvals', projects: dependencies.secrets.approvalRows() }) }));
  sendLaneSnapshotOnConnect('coherence-feed', () => dependencies.coherenceFeed);
  sendLaneSnapshotOnConnect('whiteboards', () => dependencies.whiteboards);

  return { removeExitedSession: controlHandlers.removeExitedSession, raceLauncher: controlHandlers.raceLauncher };
}

export { createBackendControl };
