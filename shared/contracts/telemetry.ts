import { z } from 'zod';
import { BUILTIN_AGENT_IDS } from './config.ts';
import { DASHBOARD_VIEWS, InstallFailureKind, NoticeId, NoticeTone, ONBOARDING_STEP_STATES, ONBOARDING_STEPS, OPERATOR_ACTIONS_BY_SURFACE, OPERATOR_SURFACES, TELEMETRY_TEXT_MAX_CHARS } from './control-messages.ts';
import type { OperatorAction, OperatorSurface } from './control-messages.ts';
import { DashboardReconnectedProperties } from './control/control-fields.ts';
import { SESSION_COMMANDS } from './session.ts';
import { PROBE_CREDENTIALS, WATCHER_LANE_IDS, WorkosUserId } from './watcher-link.ts';

const TELEMETRY_ADAPTERS = Object.freeze([...BUILTIN_AGENT_IDS, 'custom'] as const);
const SESSION_END_CAUSES = Object.freeze(['removed', 'replaced', 'server_stopped'] as const);
const SESSION_EXIT_KINDS = Object.freeze(['clean', 'error', 'signal', 'no_output', ...SESSION_END_CAUSES] as const);
export const DEPENDENCY_INSTALL_TOOLS = Object.freeze(['npm', 'pnpm'] as const);
const DEPENDENCY_INSTALL_FAILURE_CAUSES = Object.freeze(['tool-missing', 'timed-out', 'refused-argument', 'trust-downgrade', 'outdated-lockfile', 'unreadable-lockfile', 'registry-refused', 'network', 'other'] as const);
const TEAM_REVIEW_SETTLED_OUTCOMES = Object.freeze(['approve', 'comment', 'request-changes', 'approve-only', 'discarded', 'restored'] as const);
const TEAM_REVIEW_POST_REFUSAL_REASONS = Object.freeze([
  'unknown-action', 'not-postable', 'comments-already-posted', 'empty-comment', 'rate-limited',
  'head-unreadable', 'head-moved', 'diff-unreadable', 'misplaced-comments', 'github-refused',
] as const);
const RADAR_VERDICTS = Object.freeze(['ROOT_CAUSE', 'FIXED', 'NEEDS_HUMAN', 'TRANSIENT', 'ERROR'] as const);
const RADAR_JOB_MODES = Object.freeze(['investigate', 'fix'] as const);
const RADAR_ERROR_REASONS = Object.freeze(['agent-reported', 'no-result', 'invalid-result', 'timed-out', 'no-verdict', 'crashed', 'aborted', 'empty-fix', 'handoff-failed'] as const);
const RADAR_HANDOFF_STEPS = Object.freeze(['commit-fix', 'read-diff', 'count-commits'] as const);
const WATCHER_TELEMETRY_LANES = Object.freeze([...WATCHER_LANE_IDS, 'other'] as const);
const WATCHER_FAILURE_KINDS = Object.freeze(['no_credential', 'unauthorized', 'forbidden', 'not_found', 'rate_limited', 'server_error', 'graphql_error', 'unreachable', 'other'] as const);
export type WatcherTelemetryLane = (typeof WATCHER_TELEMETRY_LANES)[number];
export type WatcherFailureKind = (typeof WATCHER_FAILURE_KINDS)[number];
export interface WatcherRollup {
  probeCount: number;
  coveredProbeCount: number;
  nudgeCount: number;
}
const OPERATOR_ACTIONS = Object.freeze([...new Set(Object.values(OPERATOR_ACTIONS_BY_SURFACE).flat())] as [OperatorAction, ...OperatorAction[]]);

export const MAX_EXCEPTION_FRAMES = 64;
export const MAX_TEXT_LENGTH = TELEMETRY_TEXT_MAX_CHARS;
export const MAX_AI_PROVIDER_LENGTH = 64;
export const MAX_AI_MODEL_LENGTH = 128;

const nonNegativeInteger = z.number().int().nonnegative();
const boundedText = z.string().max(MAX_TEXT_LENGTH);

export const PersonProperties = z.object({
  $unset: z.tuple([z.literal('claude_account_hash'), z.literal('codex_user_hash')]),
  $set_once: z.object({ first_app_version: boundedText, first_os_platform: boundedText, first_install_flavor: boundedText }).strict(),
}).strict();

const GITHUB_SOURCES = Object.freeze(['gh', 'connection', 'none'] as const);

export const SetupSnapshot = z.object({
  github_source: z.enum(GITHUB_SOURCES),
  agent_account_count: nonNegativeInteger,
  agents_with_accounts: z.array(z.enum(TELEMETRY_ADAPTERS)).max(TELEMETRY_ADAPTERS.length),
  telegram_configured: z.boolean(),
  pack_count: nonNegativeInteger,
  session_sandbox: z.boolean(),
}).strict();

const AppStartedProperties = z.object({
  is_first_start: z.boolean(),
  ...PersonProperties.partial().shape,
  ...SetupSnapshot.partial().shape,
}).strict();

const AppActiveProperties = z.object({
  active_session_count: nonNegativeInteger,
  watcher_probe_count: nonNegativeInteger.optional(),
  watcher_covered_probe_count: nonNegativeInteger.optional(),
  watcher_nudge_count: nonNegativeInteger.optional(),
  max_loop_lag_p99_ms: nonNegativeInteger.optional(),
  ...PersonProperties.partial().shape,
  ...SetupSnapshot.partial().shape,
}).strict();

const DataDeletionRequestedProperties = z.object({}).strict();

const CloudAccountLinkProperties = z.object({ $set: z.object({ cloud_account: WorkosUserId }).strict() }).strict();

export const BOARD_OPEN_STEPS = Object.freeze(['heads ready', 'saved layout tried', 'saved layout read', 'saved layout missed', 'saved layout queued', 'saved routes and warnings read', 'tiles built from saved layout', 'layout world built', 'tile index built', 'store pages read', 'board record built', 'tiles answered', 'tiles sent'] as const);
export type BoardOpenStep = (typeof BOARD_OPEN_STEPS)[number];

const BoardOpenedProperties = z.object({
  total_ms: nonNegativeInteger,
  tile_count: nonNegativeInteger,
  saved_layout_hit: z.boolean(),
  slowest_step: z.enum(BOARD_OPEN_STEPS),
  slowest_step_ms: nonNegativeInteger,
  heap_mb: nonNegativeInteger,
}).strict();

const BackgroundWorkOutlivedLimitProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
  kind: z.enum(['subagent', 'shell']),
  minutes_past_limit: nonNegativeInteger,
}).strict();

const DependencyInstallFailedProperties = z.object({
  tool: z.enum(DEPENDENCY_INSTALL_TOOLS),
  tool_major: nonNegativeInteger.nullable(),
  cause: z.enum(DEPENDENCY_INSTALL_FAILURE_CAUSES),
}).strict();

const IdleStopRequestedProperties = z.object({
  outcome: z.enum(['stopping', 'no-adapter', 'failed']),
  sessions_with_expired_work: nonNegativeInteger,
  expired_subagent_count: nonNegativeInteger,
  expired_shell_count: nonNegativeInteger,
}).strict();

const VaultSecretAnsweredProperties = z.object({
  delivered_count: nonNegativeInteger,
  pending_count: nonNegativeInteger,
  denied_count: nonNegativeInteger,
  no_source_count: nonNegativeInteger,
  failed_count: nonNegativeInteger,
}).strict();

const watcherLane = z.enum(WATCHER_TELEMETRY_LANES);
const probeCredential = z.enum(PROBE_CREDENTIALS);

const WatcherProbeFailingProperties = z.object({
  lane: watcherLane,
  credential: probeCredential,
  failure_kind: z.enum(WATCHER_FAILURE_KINDS),
}).strict();

const WatcherProbeRecoveredProperties = z.object({
  lane: watcherLane,
  credential: probeCredential,
  failing_seconds: nonNegativeInteger,
}).strict();

const WatcherNudgeReceivedProperties = z.object({
  lane: watcherLane,
  kind: z.enum(['changed', 'recovered']),
}).strict();

const SessionStartedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
}).strict();

const SessionEndedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
  exit_kind: z.enum(SESSION_EXIT_KINDS),
  duration_seconds: nonNegativeInteger,
}).strict();

const CommandHintProperties = z.object({
  command: z.enum(SESSION_COMMANDS),
  adapter: z.enum(TELEMETRY_ADAPTERS),
}).strict();

const ViewShownProperties = z.object({
  view: z.enum(DASHBOARD_VIEWS),
}).strict();

function isActionOfSurface({ surface, action }: { surface: OperatorSurface; action: OperatorAction }): boolean {
  const surfaceActions: readonly OperatorAction[] = OPERATOR_ACTIONS_BY_SURFACE[surface];
  return surfaceActions.includes(action);
}

const OperatorActionProperties = z.object({
  surface: z.enum(OPERATOR_SURFACES),
  action: z.enum(OPERATOR_ACTIONS),
}).strict()
  .refine(isActionOfSurface, { message: 'action does not belong to its surface' });

const NoticeShownProperties = z.object({
  notice: NoticeId,
  tone: NoticeTone.optional(),
  source: boundedText.optional(),
  kind: InstallFailureKind.optional(),
}).strict();

const OnboardingStepProperties = z.object({
  step: z.enum(ONBOARDING_STEPS),
  state: z.enum(ONBOARDING_STEP_STATES),
}).strict();

const TeamReviewDraftedProperties = z.object({
  inline_comment_count: nonNegativeInteger,
}).strict();

const TeamReviewSettledProperties = z.object({
  duration_ms: nonNegativeInteger,
  outcome: z.enum(TEAM_REVIEW_SETTLED_OUTCOMES),
  drafted_comment_count: nonNegativeInteger,
  posted_comment_count: nonNegativeInteger,
}).strict();

const TeamReviewPostRefusedProperties = z.object({
  duration_ms: nonNegativeInteger,
  reason: z.enum(TEAM_REVIEW_POST_REFUSAL_REASONS),
}).strict();

const RadarInvestigationFinishedProperties = z.object({
  verdict: z.enum(RADAR_VERDICTS),
  mode: z.enum(RADAR_JOB_MODES),
  error_reason: z.enum(RADAR_ERROR_REASONS).optional(),
}).strict();

const RadarFixHandoffFailedProperties = z.object({
  step: z.enum(RADAR_HANDOFF_STEPS),
}).strict();


export const DashboardTelemetryReport = z.discriminatedUnion('event', [
  z.object({ event: z.literal('dashboard_reconnected'), properties: DashboardReconnectedProperties }),
  z.object({ event: z.literal('view_shown'), properties: ViewShownProperties }),
  z.object({ event: z.literal('operator_action'), properties: OperatorActionProperties }),
  z.object({ event: z.literal('onboarding_step'), properties: OnboardingStepProperties }),
  z.object({ event: z.literal('notice_shown'), properties: NoticeShownProperties }),
]);
export type DashboardTelemetryReport = z.infer<typeof DashboardTelemetryReport>;

export const ExceptionFrame = z.object({
  platform: z.enum(['node:javascript', 'web:javascript']),
  function: boundedText,
  filename: boundedText,
  lineno: nonNegativeInteger,
  colno: nonNegativeInteger,
  in_app: z.boolean(),
}).strict();

export const ExceptionProperties = z.object({
  $exception_list: z.array(z.object({
    type: boundedText,
    value: boundedText,
    mechanism: z.object({
      handled: z.boolean(),
      synthetic: z.boolean(),
      type: z.literal('generic'),
    }).strict(),
    stacktrace: z.object({
      type: z.literal('raw'),
      frames: z.array(ExceptionFrame).max(MAX_EXCEPTION_FRAMES),
    }).strict(),
  }).strict()).length(1),
  $exception_level: z.enum(['error', 'fatal']),
}).strict();

export const AiGenerationProperties = z.object({
  $ai_trace_id: z.string().regex(/^[0-9a-f]{64}$/),
  $ai_provider: z.string().max(MAX_AI_PROVIDER_LENGTH),
  $ai_model: z.string().max(MAX_AI_MODEL_LENGTH),
  $ai_input_tokens: nonNegativeInteger,
  $ai_output_tokens: nonNegativeInteger,
  $ai_cache_read_input_tokens: nonNegativeInteger.optional(),
  $ai_cache_creation_input_tokens: nonNegativeInteger.optional(),
  $ai_total_cost_usd: z.number().finite().nonnegative().optional(),
  agent_adapter: z.enum(TELEMETRY_ADAPTERS),
}).strict();

export const TELEMETRY_EVENT_SCHEMAS = Object.freeze({
  app_started: AppStartedProperties,
  app_active: AppActiveProperties,
  session_started: SessionStartedProperties,
  session_ended: SessionEndedProperties,
  $exception: ExceptionProperties,
  $ai_generation: AiGenerationProperties,
  command_hint_shown: CommandHintProperties,
  command_hint_followed: CommandHintProperties,
  view_shown: ViewShownProperties,
  operator_action: OperatorActionProperties,
  onboarding_step: OnboardingStepProperties,
  notice_shown: NoticeShownProperties,
  dashboard_reconnected: DashboardReconnectedProperties,
  board_opened: BoardOpenedProperties,
  team_review_drafted: TeamReviewDraftedProperties,
  team_review_settled: TeamReviewSettledProperties,
  team_review_post_refused: TeamReviewPostRefusedProperties,
  radar_investigation_finished: RadarInvestigationFinishedProperties,
  radar_fix_handoff_failed: RadarFixHandoffFailedProperties,
  data_deletion_requested: DataDeletionRequestedProperties,
  $set: CloudAccountLinkProperties,
  watcher_probe_failing: WatcherProbeFailingProperties,
  watcher_probe_recovered: WatcherProbeRecoveredProperties,
  watcher_nudge_received: WatcherNudgeReceivedProperties,
  vault_secret_answered: VaultSecretAnsweredProperties,
  background_work_outlived_limit: BackgroundWorkOutlivedLimitProperties,
  dependency_install_failed: DependencyInstallFailedProperties,
  idle_stop_requested: IdleStopRequestedProperties,
});

export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_SCHEMAS;
export type TelemetryEventProperties<EventName extends TelemetryEventName> = z.infer<(typeof TELEMETRY_EVENT_SCHEMAS)[EventName]>;

export const TELEMETRY_EVENTS: readonly { name: TelemetryEventName; description: string }[] = Object.freeze([
  { name: 'app_started', description: 'The server started listening, and whether this is the first start, with no Glimmervoid config file yet. Also sets the person properties: the first version, platform and install flavor seen. Also carries the setup: how GitHub is reached (gh, a connection made in Settings, or neither), how many agent accounts were added beyond the login each agent already has and for which kinds of agent, whether Telegram is set up, how many packs are listed and whether the session sandbox is on. Never a login, account name or path.' },
  { name: 'app_active', description: 'Once a day while the server runs, with how many sessions are live, how many probes the watcher was handed and how many of them it covers, how many watcher nudges arrived since the last one, and the worst one-minute event loop delay (99th percentile, in milliseconds) the server saw since the last one, and the same person properties and setup as app_started.' },
  { name: 'session_started', description: 'A session spawned, with which kind of agent (any custom agent counts as `custom`).' },
  { name: 'session_ended', description: 'A session ended: how it exited, or that it was removed, replaced by a settings change or stopped with the server, and how long it ran, in whole seconds.' },
  { name: '$exception', description: 'An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start.' },
  { name: '$ai_generation', description: 'Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output.' },
  { name: 'command_hint_shown', description: 'An agent was handed a one-time line naming a Glimmervoid command when its tool call made the command fit, with which command and which kind of agent. Never the tool call.' },
  { name: 'command_hint_followed', description: 'An agent ran a Glimmervoid command it had been handed a one-time line about earlier in the same conversation, with which command and which kind of agent.' },
  { name: 'view_shown', description: 'A dashboard tab opened, on desktop or phone, with which tab. Sent on every open.' },
  { name: 'operator_action', description: 'An action taken in the Usage, Radar or Reviews tab, the first-run checklist or the GitHub star card: which surface and which action, from a fixed list. Never which repository, pull request, issue or session it was taken on.' },
  { name: 'onboarding_step', description: 'The first-run checklist moved a step to current or done, with which step. Sent once per change while the page is open.' },
  { name: 'notice_shown', description: 'A notice the dashboard showed under its header: which notice (an error or warning, an available update, old reports left in a repository, or the telemetry notice), whether it was an error or a warning, which part of the dashboard raised it and, for a dependency install warning, the failure kind: tool-missing, failed or timed-out. Never the notice text. Each distinct notice is sent once per page load.' },
  { name: 'dashboard_reconnected', description: 'The dashboard got its connection back after losing or replacing it: what started it (a long hide, a resume, a frozen page, a late or missed heartbeat, a slow handshake, a closed connection or a cloud machine waking), how long until connected, how long the handshake that won took and how many it took, whether the dashboard is on this machine, a tailnet or another host, how long the tab was hidden, and whether a cloud machine was waking. Never the host name or URL.' },
  { name: 'board_opened', description: 'The server opened a whiteboard for the dashboard: how long it took in all, how many tiles it sent, whether a saved layout let it skip laying the board out, which step was slowest and how long that took, and the server memory in use. Never the board, its id or its contents.' },
  { name: 'team_review_drafted', description: 'A team review draft became ready, with how many inline comments it drafted.' },
  { name: 'team_review_settled', description: 'A team review draft was posted (approve, comment or approve-only), discarded, or restored from discarded (which undoes that discard), with how many inline comments were drafted and how many were posted, plus the total action duration in milliseconds.' },
  { name: 'team_review_post_refused', description: 'Posting a team review was refused, with a reason from a fixed list and the total action duration in milliseconds. Never the error text.' },
  { name: 'radar_investigation_finished', description: 'A Radar investigation or fix run finished, with its verdict and mode, plus a reason from a fixed list when it ended in ERROR. Never the summary text.' },
  { name: 'radar_fix_handoff_failed', description: 'Committing or checking a Radar fix branch failed, with which step failed. Never the branch or the error text.' },
  { name: '$set', description: 'Only on a Glimmervoid Cloud server, each time its owner signs in at the doorman: sets cloud_account, the owner\'s Glimmervoid Cloud account id (the WorkOS user id the doorman verified), on this install\'s profile, so usage can be counted per account. The install keeps its own profile, so Delete my data still erases only this install. A self-hosted install never sends it; it is tagged only from the account page after you choose Link to my Glimmervoid account and confirm.' },
  { name: 'data_deletion_requested', description: 'Delete my data was confirmed in Settings > Privacy, with no properties. Sent under the old install id even when telemetry is off, unless the maintainers stopped all sending, and then the install id is replaced. PostHog deletes the person and every event under that id on receipt.' },
  { name: 'watcher_probe_failing', description: 'A watcher probe started failing: which lane and which kind of read credential it uses, and a failure kind from a fixed list. Never the URL, repository, token or error text.' },
  { name: 'watcher_probe_recovered', description: 'A failing watcher probe answered again: which lane and kind of read credential, and how long it was failing, in whole seconds.' },
  { name: 'watcher_nudge_received', description: 'The watcher told a lane its answer changed or recovered: which lane and which of the two. Never the probe, URL or repository.' },
  { name: 'vault_secret_answered', description: 'An agent asked for secrets by name and got its answer: how many names came back delivered, pending, denied, no source chosen or failed. Never the names, values or project.' },
  { name: 'background_work_outlived_limit', description: 'A subagent or background shell finished after the 30 or 60 minute limit past which Glimmervoid stops counting it as working, with which kind of agent, which kind of work and how many whole minutes past the limit. Never the task or its output.' },
  { name: 'dependency_install_failed', description: 'Installing a new worktree\'s dependencies failed in one folder: which tool (npm or pnpm), its major version when Glimmervoid could read it, and the cause, one of tool-missing, timed-out, refused-argument, trust-downgrade, outdated-lockfile, unreadable-lockfile, registry-refused (the registry answered 4xx, such as a missing package or refused login), network or other. Never the folder, the repository, package names or the install output.' },
  { name: 'idle_stop_requested', description: 'The server asked to put its host to sleep after 20 awake minutes with no agent working, with the answer (stopping, no host to stop, or failed) and how many sessions, subagents and background shells were still unfinished past their limit at that moment.' },
]);

export const TELEMETRY_BASE_PROPERTY_KEYS = Object.freeze([
  'app_version', 'os_platform', 'node_major', 'install_flavor', 'is_bundled', 'is_dev_install',
] as const);

export const TELEMETRY_OPTIONAL_BASE_PROPERTY_KEYS = Object.freeze(['$release_id'] as const);

export const TELEMETRY_KILL_SWITCH_FLAG = 'telemetry-enabled';

export const FeatureFlagsResponse = z.object({
  flags: z.object({
    [TELEMETRY_KILL_SWITCH_FLAG]: z.object({ enabled: z.boolean() }).passthrough().optional(),
  }).passthrough(),
  errorsWhileComputingFlags: z.boolean().optional(),
}).passthrough();

export const PendingCrashReport = z.object({
  timestamp: z.string(),
  properties: ExceptionProperties,
}).strict();

export const TelemetryState = z.object({
  installId: z.uuid(),
  noticeShownAt: z.string().nullable().optional(),
  remoteDisabled: z.boolean().optional(),
});

export type ExceptionFrame = z.infer<typeof ExceptionFrame>;
export type PersonProperties = z.infer<typeof PersonProperties>;
export type SetupSnapshot = z.infer<typeof SetupSnapshot>;
export type GithubSourceKind = (typeof GITHUB_SOURCES)[number];
export type ExceptionProperties = z.infer<typeof ExceptionProperties>;
export type AiGenerationProperties = z.infer<typeof AiGenerationProperties>;
export type TeamReviewSettledOutcome = (typeof TEAM_REVIEW_SETTLED_OUTCOMES)[number];
export type TeamReviewPostRefusalReason = (typeof TEAM_REVIEW_POST_REFUSAL_REASONS)[number];
export type RadarErrorReason = (typeof RADAR_ERROR_REASONS)[number];
export type RadarHandoffStep = (typeof RADAR_HANDOFF_STEPS)[number];
export type TelemetryAdapter = (typeof TELEMETRY_ADAPTERS)[number];
export type SessionExitKind = (typeof SESSION_EXIT_KINDS)[number];
export type SessionEndCause = (typeof SESSION_END_CAUSES)[number];
export type TelemetryState = z.infer<typeof TelemetryState>;
export type PendingCrashReport = z.infer<typeof PendingCrashReport>;
