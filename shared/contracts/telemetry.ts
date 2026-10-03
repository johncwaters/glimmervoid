import { z } from 'zod';
import { BUILTIN_AGENT_IDS } from './config.ts';

export const TELEMETRY_ADAPTERS = Object.freeze([...BUILTIN_AGENT_IDS, 'custom'] as const);
export const SESSION_EXIT_KINDS = Object.freeze(['clean', 'error', 'signal', 'no_output'] as const);

export const MAX_EXCEPTION_FRAMES = 64;
export const MAX_TEXT_LENGTH = 512;
export const MAX_AI_PROVIDER_LENGTH = 64;
export const MAX_AI_MODEL_LENGTH = 128;

const nonNegativeInteger = z.number().int().nonnegative();
const boundedText = z.string().max(MAX_TEXT_LENGTH);

export const AppStartedProperties = z.object({}).strict();

export const AppActiveProperties = z.object({
  active_session_count: nonNegativeInteger,
}).strict();

export const SessionStartedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
}).strict();

export const SessionEndedProperties = z.object({
  adapter: z.enum(TELEMETRY_ADAPTERS),
  exit_kind: z.enum(SESSION_EXIT_KINDS),
  duration_seconds: nonNegativeInteger,
}).strict();

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
});

export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_SCHEMAS;
export type TelemetryEventProperties<EventName extends TelemetryEventName> = z.infer<(typeof TELEMETRY_EVENT_SCHEMAS)[EventName]>;

export const TELEMETRY_EVENTS: readonly { name: TelemetryEventName; description: string }[] = Object.freeze([
  { name: 'app_started', description: 'The server started listening.' },
  { name: 'app_active', description: 'Once a day while the server runs, with how many sessions are live.' },
  { name: 'session_started', description: 'A session spawned, with which kind of agent (any custom agent counts as `custom`).' },
  { name: 'session_ended', description: 'A session exited: how it exited and how long it ran, in whole seconds.' },
  { name: '$exception', description: 'An error in the server or the dashboard: its type, an error code when it has one, and stack frames with file paths cut to the package or URL path. Never the error message. Each distinct error is sent once per run, and a crash is sent on the next start.' },
  { name: '$ai_generation', description: 'Per agent session and model, after each usage scan, for usage recorded in the last 24 hours: token counts, the model name and estimated cost, under a one-way hash of the session. A model name outside the shipped pricing table is sent as unknown. No prompts or output.' },
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
export type TelemetryAdapter = (typeof TELEMETRY_ADAPTERS)[number];
export type SessionExitKind = (typeof SESSION_EXIT_KINDS)[number];
export type TelemetryState = z.infer<typeof TelemetryState>;
export type PendingCrashReport = z.infer<typeof PendingCrashReport>;
