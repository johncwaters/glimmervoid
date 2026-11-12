import { z } from 'zod';
import { sessionId, loose } from './control/control-fields.ts';
import { sessionClientVariants, sessionServerVariants } from './control/session-messages.ts';
import { worktreeClientVariants, worktreeServerVariants } from './control/worktree-messages.ts';
import { inspectClientVariants, inspectServerVariants } from './control/inspect-messages.ts';
import { settingsClientVariants, settingsServerVariants } from './control/settings-messages.ts';
import { githubClientVariants, githubServerVariants } from './control/github-messages.ts';
import { radarClientVariants, radarServerVariants } from './control/radar-messages.ts';
import { communityClientVariants, communityServerVariants } from './control/community-messages.ts';
import { laneClientVariants, laneServerVariants } from './control/lane-messages.ts';
import { whiteboardClientVariants, whiteboardServerVariants } from './control/whiteboard-messages.ts';
import { raceClientVariants, raceServerVariants } from './control/race-messages.ts';
import { systemClientVariants, systemServerVariants } from './control/system-messages.ts';
import { packClientVariants, packServerVariants } from './control/pack-messages.ts';
import { reviewClientVariants, reviewServerVariants } from './control/review-messages.ts';

export {
  CHANGES_POLL_INTERVAL_MS,
  CHANGES_WATCH_LEASE_MS,
  KeptWorkPath,
  GithubTeam,
  pullRequestKeyFromReference,
  CustomAgentSummaryRow,
  CoderEnvironmentOffers,
  PlanLimitsVendor,
  ConnectableAgent,
  AgentLoginStatus,
  AgentLoginStatuses,
  TelegramDeliveryStatus,
  SessionCardFields,
  NotifyAlertGroup,
  SessionStatusFields,
  CONTROL_FRAME_ENVELOPE_BYTES,
  CONTROL_FRAME_MAX_BYTES,
  UpdateApplyRefusal,
  BINARY_SWITCH_FLAVORS,
  InstallFlavor,
  STANDALONE_BINARY_PATH,
  UpdateStatus,
  CLIENT_ERROR_NAME_MAX_CHARS,
  CLIENT_ERROR_STACK_MAX_CHARS,
  ClientErrorReport,
  CLIENT_LOG_SCOPE_MAX_CHARS,
  CLIENT_LOG_TEXT_MAX_CHARS,
  TELEMETRY_TEXT_MAX_CHARS,
  BoardGraphicsResetProperties,
  InstallFailureKind,
  InstallDetail,
  DASHBOARD_VIEWS,
  OPERATOR_ACTIONS_BY_SURFACE,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_STATES,
  OPERATOR_SURFACES,
} from './control/control-fields.ts';
export type { CoderEnvironmentOffer, OnboardingStepReport, OperatorSurface, OperatorAction, OperatorActionOf } from './control/control-fields.ts';

const idOnlyClientTypes = [
  'kill', 'start-session',
  'resolve-session-merge', 'request-session-diff', 'request-change-map', 'request-branch-sync', 'resync-branch', 'debug-state',
] as const;

function idOnlyClientVariant<const Type extends string>(type: Type) {
  return loose(type, { id: sessionId, force: z.unknown().optional() });
}

const idOnlyClientVariants = idOnlyClientTypes.map(idOnlyClientVariant) as {
  [Type in typeof idOnlyClientTypes[number]]: ReturnType<typeof idOnlyClientVariant<Type>>;
}[typeof idOnlyClientTypes[number]][];

const clientVariants = [
  ...sessionClientVariants,
  ...worktreeClientVariants,
  ...inspectClientVariants,
  ...settingsClientVariants,
  ...githubClientVariants,
  ...radarClientVariants,
  ...communityClientVariants,
  ...laneClientVariants,
  ...whiteboardClientVariants,
  ...raceClientVariants,
  ...systemClientVariants,
  ...packClientVariants,
  ...reviewClientVariants,
  ...idOnlyClientVariants,
] as const;

export const ClientMessage = z.discriminatedUnion('type', clientVariants);

const serverVariants = [
  ...sessionServerVariants,
  ...worktreeServerVariants,
  ...inspectServerVariants,
  ...settingsServerVariants,
  ...githubServerVariants,
  ...radarServerVariants,
  ...communityServerVariants,
  ...laneServerVariants,
  ...whiteboardServerVariants,
  ...raceServerVariants,
  ...systemServerVariants,
  ...packServerVariants,
  ...reviewServerVariants,
] as const;

export const ServerMessage = z.discriminatedUnion('type', serverVariants);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ClientMessageOf<Type extends ClientMessage['type']> = Extract<ClientMessage, { type: Type }>;
export type ServerMessageOf<Type extends ServerMessage['type']> = Extract<ServerMessage, { type: Type }>;
