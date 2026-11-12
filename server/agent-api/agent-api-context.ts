import type { Session } from '../../session/sessions.ts';
import type { AgentApiVerb, AgentPacksRequest, AgentSettingsReply, AgentSettingsRequest } from '../../shared/contracts/session.ts';
import type { MyPrsSnapshot } from '../../shared/contracts/my-prs.ts';
import type { TeamReviewStatus } from '../../shared/contracts/team-review.ts';
import type { GlimmervoidConfig, ProjectEntry } from '../config-store.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import type { AgentReplyOf, AgentRequestOf, ChildEndCause } from '../core/agent-api-core.ts';
import type { AgentChannel, ChannelSide } from '../core/child-channel-core.ts';
import type { RecordLane, SpawnGate } from '../lanes/ephemeral-session.ts';
import type { SessionSpawnOverrides } from '../session/session-factory.ts';
import type { SessionDocsPort } from '../session/session-docs-wiring.ts';
import type { MemoryAdmission } from '../spawn-gate.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import type { SecretsBroker } from '../secrets/secrets-broker.ts';
import type { RaceLauncher } from '../race/race-launch.ts';
import type { RaceWiring } from '../race/race-wiring.ts';
import type { WhyLookup } from '../why-lookup.ts';
import type { ReviewPort } from '../review/review-wiring.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from '../../shared/timer-deps.ts';

const AGENT_LANE_TAG = 'agent-spawn';

type MakeSession = (
  project: ProjectEntry,
  config: GlimmervoidConfig,
  overrides?: SessionSpawnOverrides,
) => Session;

type ReviewRequestReply = { ok: true; key: string; status: 'queued' | 'running' } | { ok: false; error: string };

interface AgentOperatorStatePort {
  requestReview(reference: { repo: string; number: number }): Promise<ReviewRequestReply>;
  teamReviewStatus(): TeamReviewStatus;
  myPrsStatus(): MyPrsSnapshot | null;
  readSettings(request: AgentSettingsRequest): AgentSettingsReply;
  readPacks(request: AgentPacksRequest): Promise<{ text: string; hasProblem: boolean }>;
}

interface AgentApiWiringOptions {
  config: GlimmervoidConfig;
  agentSessions: Map<string, Session>;
  listAllSessions: () => Session[];
  listBoardSessions: () => Session[];
  makeSession: MakeSession;
  wireSessionEvents: (session: Session) => void;
  closeSessionDataClients: (id: string) => void;
  broadcastControl: (message: ControlMessageRecord) => void;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  sessionDocs: SessionDocsPort;
  memoryAdmission?: Pick<MemoryAdmission, 'describeShortfallNow'> | null;
  operatorState?: AgentOperatorStatePort | null;
  whiteboards?: Pick<WhiteboardPort, 'handleAgent'> | null;
  lookupWhy?: ((request: { target: string; cwd: string }) => Promise<WhyLookup>) | null;
  settleSessionCoherence?: (id: string) => Promise<void>;
  secrets?: Pick<SecretsBroker, 'need'> | null;
  races?: Pick<RaceWiring, 'status' | 'judge' | 'contestantDiffText'> | null;
  startRace?: RaceLauncher['start'] | null;
  reviewComments?: Pick<ReviewPort, 'read' | 'reply' | 'resolve'> | null;
  repoClones?: Pick<GitWorkspaceInstance, 'originUrl' | 'cloneRepository'> | null;
  wakesFilePath?: string | null;
  logger?: Pick<Console, 'warn'>;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  now?: () => number;
}

interface ChannelLink {
  parent: Session;
  child: Session;
  lastChildMessage: string | null;
  waitingStopNoteText: string | null;
  hasParentRead: boolean;
  pendingWakeSides: Set<ChannelSide>;
  retryTimersBySide: Map<ChannelSide, TimerHandle>;
}

interface SessionWakeBudget {
  lastOperatorInputAt: number;
  wakesSinceOperatorInput: number;
  isOperatorFlagged: boolean;
}

type AgentVerbHandlers = { readonly [V in AgentApiVerb]: (session: Session, request: AgentRequestOf<V>) => AgentReplyOf<V> | Promise<AgentReplyOf<V>> };

interface AgentApiCollections {
  channelsByChildId: Map<string, AgentChannel>;
  linksByChildId: Map<string, ChannelLink>;
  parentsWithChannelCleanup: WeakSet<Session>;
  sessionsWithOperatorWatch: WeakSet<Session>;
  wakeBudgetBySession: WeakMap<Session, SessionWakeBudget>;
  childIdsToDiscard: Set<string>;
  endCauseByChildId: Map<string, ChildEndCause>;
}

type AgentApiRuntime = Required<AgentApiWiringOptions> & AgentApiCollections;

export { AGENT_LANE_TAG };
export type { AgentApiRuntime, AgentApiWiringOptions, AgentVerbHandlers, ChannelLink, SessionWakeBudget };
