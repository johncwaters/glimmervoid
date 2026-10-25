import { z } from 'zod';
import { BUILTIN_AGENT_IDS } from './config.ts';
import { DASHBOARD_VIEWS, ONBOARDING_STEP_STATES, ONBOARDING_STEPS, OPERATOR_ACTIONS_BY_SURFACE, OPERATOR_SURFACES } from './control-messages.ts';
import type { OperatorAction, OperatorSurface } from './control-messages.ts';

const TELEMETRY_ADAPTERS = Object.freeze([...BUILTIN_AGENT_IDS, 'custom'] as const);
const SESSION_END_CAUSES = Object.freeze(['removed', 'replaced', 'server_stopped'] as const);
const SESSION_EXIT_KINDS = Object.freeze(['clean', 'error', 'signal', 'no_output', ...SESSION_END_CAUSES] as const);
const TEAM_REVIEW_SETTLED_OUTCOMES = Object.freeze(['approve', 'comment', 'approve-only', 'discarded'] as const);
const TEAM_REVIEW_POST_REFUSAL_REASONS = Object.freeze([
  'unknown-action', 'not-postable', 'comments-already-posted', 'empty-comment', 'rate-limited',
  'head-unreadable', 'head-moved', 'diff-unreadable', 'misplaced-comments', 'github-refused',
] as const);
const RADAR_VERDICTS = Object.freeze(['ROOT_CAUSE', 'FIXED', 'NEEDS_HUMAN', 'TRANSIENT', 'ERROR'] as const);
const RADAR_JOB_MODES = Object.freeze(['investigate', 'fix'] as const);
const RADAR_ERROR_REASONS = Object.freeze(['agent-reported', 'no-result', 'invalid-result', 'timed-out', 'no-verdict', 'crashed', 'aborted', 'empty-fix', 'handoff-failed'] as const);
const RADAR_HANDOFF_STEPS = Object.freeze(['read-diff', 'count-commits', 'push-branch', 'resolve-repo', 'open-pr'] as const);
const OPERATOR_ACTIONS = Object.freeze([...new Set(Object.values(OPERATOR_ACTIONS_BY_SURFACE).flat())] as [OperatorAction, ...OperatorAction[]]);

export const MAX_EXCEPTION_FRAMES = 64;
export const MAX_TEXT_LENGTH = 512;
export const MAX_AI_PROVIDER_LENGTH = 64;
export const MAX_AI_MODEL_LENGTH = 128;

const nonNegativeInteger = z.number().int().nonnegative();
const boundedText = z.string().max(MAX_TEXT_LENGTH);

const AppStartedProperties = z.object({}).strict();

const AppActiveProperties = z.object({
  active_session_count: nonNegativeInteger,
}).strict();

const SessionStartedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
}).strict();

const SessionEndedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
  exit_kind: z.enum(SESSION_EXIT_KINDS),
  duration_seconds: nonNegativeInteger,
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
}).strict().refine(isActionOfSurface, { message: 'action does not belong to its surface' });

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
  z.object({ event: z.literal('view_shown'), properties: ViewShownProperties }),
  z.object({ event: z.literal('operator_action'), properties: OperatorActionProperties }),
  z.object({ event: z.literal('onboarding_step'), properties: OnboardingStepProperties }),
]);

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
  view_shown: ViewShownProperties,
  operator_action: OperatorActionProperties,
  onboarding_step: OnboardingStepProperties,
  team_review_drafted: TeamReviewDraftedProperties,
  team_review_settled: TeamReviewSettledProperties,
  team_review_post_refused: TeamReviewPostRefusedProperties,
  radar_investigation_finished: RadarInvestigationFinishedProperties,
  radar_fix_handoff_failed: RadarFixHandoffFailedProperties,
});

export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_SCHEMAS;
export type TelemetryEventProperties<EventName extends TelemetryEventName> = z.infer<(typeof TELEMETRY_EVENT_SCHEMAS)[EventName]>;

export const TELEMETRY_EVENTS: readonly { name: TelemetryEventName; description: string }[] = Object.freeze([
  { name: 'app_started', description: 'The server started listening.' },
  { name: 'app_active', description: 'Once a day while the server runs, with how many sessions are live.' },
  { name: 'session_started', description: 'A session spawned, with which kind of agent (any custom agent counts as `custom`).' },
  { name: 'session_ended', description: 'A session ended: how it exited, or that it was removed, replaced by a settings change or stopped with the server, and how long it ran, in whole seconds.' },
  { name: '$exception', description: 'An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start.' },
  { name: '$ai_generation', description: 'Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output.' },
  { name: 'view_shown', description: 'A dashboard tab opened, on desktop or phone, with which tab. Sent on every open.' },
  { name: 'operator_action', description: 'An action taken in the Usage, Issues, Radar or Reviews tab or the first-run checklist: which tab and which action, from a fixed list. Never which repository, pull request, issue or session it was taken on.' },
  { name: 'onboarding_step', description: 'The first-run checklist moved a step to current or done, with which step. Sent once per change while the page is open.' },
  { name: 'team_review_drafted', description: 'A team review draft became ready, with how many inline comments it drafted.' },
  { name: 'team_review_settled', description: 'A team review draft was posted (approve, comment or approve-only) or discarded, with how many inline comments were drafted and how many were posted, plus the total action duration in milliseconds.' },
  { name: 'team_review_post_refused', description: 'Posting a team review was refused, with a reason from a fixed list and the total action duration in milliseconds. Never the error text.' },
  { name: 'radar_investigation_finished', description: 'A Radar investigation or fix run finished, with its verdict and mode, plus a reason from a fixed list when it ended in ERROR. Never the summary text.' },
  { name: 'radar_fix_handoff_failed', description: 'Handing a Radar fix over as a pull request failed, with which step failed. Never the branch or the error text.' },
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
