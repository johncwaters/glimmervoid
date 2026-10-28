import { z } from 'zod';
import { POSTHOG_WHOLE_NUMBER_ROUNDING } from './config-numbers-core.ts';
import * as ranges from '../settings-ranges.ts';
import type { SettingsRange } from '../settings-ranges.ts';
import { USAGE_COST_MODES, USAGE_VENDOR_KEYS, USAGE_BUDGET_KEYS } from '../usage-config.ts';
import { WorkflowsSettings } from './workflows.ts';
import { repoParts } from './github-ids.ts';
import { DISCORD_CHANNEL_NAME_RE } from './community.ts';
import { UpdateChannel } from './update-journal.ts';

export const optionalBoolean = (field: string) => z.boolean({ error: `${field} must be a boolean` }).optional();
const optionalString = (field: string, trim = false) => {
  const schema = z.string({ error: `${field} must be a string` });
  return (trim ? schema.transform((value) => value.trim()) : schema).optional();
};
const numberRangeLabel = (range: SettingsRange) => {
  if (range.label) return range.label;
  if (range.max != null) return `between ${range.min} and ${range.max}`;
  if (range.exclusiveMin) return `greater than ${range.min}`;
  return `at least ${range.min}`;
};
const optionalNumber = (field: string, range: SettingsRange = ranges.POSITIVE_NUMBER_RANGE) => z.number({ error: `${field} must be ${numberRangeLabel(range)}` })
  .finite()
  .refine((value) => !range.exclusiveMin || value > range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.exclusiveMin || value >= range.min, { message: `${field} must be ${numberRangeLabel(range)}` })
  .refine((value) => range.max == null || value <= range.max, { message: `${field} must be ${numberRangeLabel(range)}` })
  .optional();
const optionalWholeNumber = (field: string, range: SettingsRange) => optionalNumber(field, range)
  .unwrap().int({ error: `${field} must be a whole number ${numberRangeLabel(range)}` }).optional();
const optionalInteger = (field: string, range: { min: number; max: number }) => z.number({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .int({ error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .min(range.min, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .max(range.max, { error: `${field} must be an integer between ${range.min} and ${range.max}` })
  .optional();
const optionalObject = (field: string, shape: z.ZodRawShape) => z.object(shape, { error: `${field} must be an object` }).nullable().optional();
export const optionalLooseObject = (field: string) => z.object({}, { error: `${field} must be an object` }).passthrough().nullable().optional();

const TaskTitleSettings = z.object({
  refiner: z.object({
    enabled: optionalBoolean('taskTitle.refiner.enabled'),
    model: optionalString('taskTitle.refiner.model', true),
    minIntervalSeconds: optionalNumber('taskTitle.refiner.minIntervalSeconds', { min: 0 }),
    timeoutSeconds: optionalNumber('taskTitle.refiner.timeoutSeconds', ranges.TASK_TITLE_TIMEOUT_RANGE),
  }, { error: 'taskTitle.refiner must be an object' }).nullable().optional(),
}, { error: 'taskTitle must be an object' }).nullable().optional();

const BRANCH_GC_SETTINGS_SHAPE = {
  enabled: optionalBoolean('branchGc.enabled'),
  worktrees: optionalBoolean('branchGc.worktrees'),
  prefixes: z.array(
    z.string({ error: 'branchGc.prefixes must be an array of strings' })
      .min(1, { error: 'branchGc.prefixes entries must be non-empty strings' }),
    { error: 'branchGc.prefixes must be an array of strings' },
  ).optional(),
  dryRun: optionalBoolean('branchGc.dryRun'),
  staleDays: optionalNumber('branchGc.staleDays', ranges.BRANCH_GC_STALE_DAYS_RANGE),
  deleteUnmerged: optionalBoolean('branchGc.deleteUnmerged'),
  intervalMs: optionalNumber('branchGc.intervalMs', ranges.BRANCH_GC_INTERVAL_MS_RANGE),
};
export const BranchGcFileSettings = z.object(BRANCH_GC_SETTINGS_SHAPE, { error: 'branchGc must be an object' });
const BranchGcSettings = optionalObject('branchGc', BRANCH_GC_SETTINGS_SHAPE);
export const BranchGcControlSettings = BranchGcFileSettings.omit({ prefixes: true, dryRun: true, worktrees: true }).nullable().optional();
export const BRANCH_GC_CONTROL_BOOLEAN_KEYS = Object.freeze(['enabled', 'deleteUnmerged']);
export const BRANCH_GC_CONTROL_NUMERIC_KEYS = Object.freeze(['staleDays', 'intervalMs']);

const VisionsSettings = optionalObject('visions', {
  enabled: optionalBoolean('visions.enabled'),
  autoFix: optionalBoolean('visions.autoFix'),
  projects: z.array(z.string({ error: 'visions.projects must be an array of strings' }), { error: 'visions.projects must be an array of strings' }).optional(),
  dispatch: optionalObject('visions.dispatch', {
    enabled: optionalBoolean('visions.dispatch.enabled'),
    model: optionalString('visions.dispatch.model', true),
    quietMs: optionalWholeNumber('visions.dispatch.quietMs', ranges.VISIONS_QUIET_MS_RANGE),
    cooldownMs: optionalWholeNumber('visions.dispatch.cooldownMs', ranges.VISIONS_COOLDOWN_MS_RANGE),
    maxPerHour: optionalWholeNumber('visions.dispatch.maxPerHour', ranges.VISIONS_MAX_PER_HOUR_RANGE),
    activityMaxPerHour: optionalWholeNumber('visions.dispatch.activityMaxPerHour', ranges.VISIONS_ACTIVITY_MAX_PER_HOUR_RANGE),
    dispatchTimeoutSeconds: optionalWholeNumber('visions.dispatch.dispatchTimeoutSeconds', ranges.VISIONS_DISPATCH_TIMEOUT_RANGE),
  }),
  intent: optionalObject('visions.intent', {
    threadTtlMs: optionalWholeNumber('visions.intent.threadTtlMs', ranges.VISIONS_INTENT_THREAD_TTL_MS_RANGE),
  }),
});

export const GithubSettings = z.object({
  teams: z.array(
    z.string({ error: 'github.teams must be an array of org/slug strings' })
      .refine((team) => repoParts(team) !== null, { message: 'github.teams entries must be org/slug with valid GitHub segments' }),
    { error: 'github.teams must be an array of org/slug strings' },
  ).optional(),
}, { error: 'github must be an object' }).nullable().optional();

const SANDBOX_DOMAIN_PATTERN = /^(?:\*\.(?=[^.]+\.[^.]+))?(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d{1,5})?$/i;
const REVIEW_AGENT_IDS = Object.freeze(['claude', 'codex', 'kimi'] as const);
export const ReviewAgentId = z.enum(REVIEW_AGENT_IDS, { error: `review agent must be one of ${REVIEW_AGENT_IDS.join(', ')}` });
export type ReviewAgentId = z.infer<typeof ReviewAgentId>;

const reviewerChoiceSettings = (field: string, agentChoices: readonly [string, ...string[]]) => optionalObject(field, {
  agent: z.enum(agentChoices, { error: `${field}.agent must be one of ${REVIEW_AGENT_IDS.join(', ')}` }).optional(),
  model: optionalString(`${field}.model`, true),
  effort: optionalString(`${field}.effort`, true),
});

const TeamReviewSettings = optionalObject('teamReview', {
  enabled: optionalBoolean('teamReview.enabled'),
  autoRebaseMyPrs: optionalBoolean('teamReview.autoRebaseMyPrs'),
  keepMergeableEnabled: optionalBoolean('teamReview.keepMergeableEnabled'),
  mergeQueueEnabled: optionalBoolean('teamReview.mergeQueueEnabled'),
  keepMergeableTimeoutMinutes: optionalInteger('teamReview.keepMergeableTimeoutMinutes', ranges.KEEP_MERGEABLE_TIMEOUT_MINUTES_RANGE),
  org: optionalString('teamReview.org', true),
  team: optionalString('teamReview.team', true),
  skill: optionalString('teamReview.skill', true),
  reviewer: reviewerChoiceSettings('teamReview.reviewer', REVIEW_AGENT_IDS),
  stampReviewer: reviewerChoiceSettings('teamReview.stampReviewer', ['', ...REVIEW_AGENT_IDS]),
  sandbox: optionalObject('teamReview.sandbox', {
    extraDomains: z.array(z.string({ error: 'teamReview.sandbox.extraDomains must be an array of domain strings' }).trim().regex(SANDBOX_DOMAIN_PATTERN, { error: 'teamReview.sandbox.extraDomains entries must be bare domains like registry.npmjs.org or *.example.com, with no scheme or path' }), { error: 'teamReview.sandbox.extraDomains must be an array of domain strings' }).optional(),
    openNetwork: optionalBoolean('teamReview.sandbox.openNetwork'),
    loadMcpServers: optionalBoolean('teamReview.sandbox.loadMcpServers'),
  }),
  reReviewAfterHours: optionalNumber('teamReview.reReviewAfterHours'),
  skipIdleAfterDays: optionalNumber('teamReview.skipIdleAfterDays'),
});

const BenchmarksSettings = optionalObject('benchmarks', {
  enabled: optionalBoolean('benchmarks.enabled'),
});

const IssuesSettings = optionalObject('issues', {
  enabled: optionalBoolean('issues.enabled'),
});

const CommunitySettings = optionalObject('community', {
  enabled: optionalBoolean('community.enabled'),
  skill: optionalString('community.skill', true),
  projectId: optionalInteger('community.projectId', ranges.POSTHOG_PROJECT_ID_RANGE),
  intervalMinutes: optionalInteger('community.intervalMinutes', ranges.COMMUNITY_INTERVAL_MINUTES_RANGE),
  discordChannels: z.array(
    z.string({ error: 'community.discordChannels must be an array of channel names' }).trim().regex(DISCORD_CHANNEL_NAME_RE, { error: 'community.discordChannels entries must be Discord channel names like community-questions, lowercase with no #' }),
    { error: 'community.discordChannels must be an array of channel names' },
  ).optional(),
});

const CoherenceSettings = optionalObject('coherence', {
  enabled: optionalBoolean('coherence.enabled'),
});

const posthogNumberRanges = {
  intervalMinutes: ranges.POSTHOG_INTERVAL_RANGE,
  maxConcurrentInvestigations: ranges.POSTHOG_MAX_CONCURRENT_RANGE,
  investigationTimeoutSeconds: ranges.POSTHOG_INVESTIGATION_TIMEOUT_RANGE,
  fixTimeoutSeconds: ranges.POSTHOG_FIX_TIMEOUT_RANGE,
  minUsersToInvestigate: ranges.POSTHOG_MIN_USERS_RANGE,
  userEscalationThreshold: ranges.POSTHOG_ESCALATION_RANGE,
  recurrenceWindowDays: ranges.POSTHOG_RECURRENCE_WINDOW_RANGE,
  transientRecurrenceLimit: ranges.POSTHOG_TRANSIENT_RECURRENCE_RANGE,
  trafficSpikeMultiplier: ranges.POSTHOG_TRAFFIC_MULTIPLIER_RANGE,
  trafficSpikeMinUsers: ranges.POSTHOG_TRAFFIC_MIN_USERS_RANGE,
  trafficSpikeCooldownMinutes: ranges.POSTHOG_TRAFFIC_COOLDOWN_RANGE,
  trafficSpikeBaselineDays: ranges.POSTHOG_TRAFFIC_BASELINE_RANGE,
};

const PosthogSettings = optionalObject('posthog', {
  enabled: optionalBoolean('posthog.enabled'),
  recurrenceDedupe: optionalBoolean('posthog.recurrenceDedupe'),
  trafficSpikeEnabled: optionalBoolean('posthog.trafficSpikeEnabled'),
  autoFix: optionalBoolean('posthog.autoFix'),
  host: optionalString('posthog.host', true).refine((value) => value == null || !value || /^https?:\/\//i.test(value), { message: 'posthog.host must be an http(s) URL' }),
  apiKey: optionalString('posthog.apiKey', true),
  repoPath: optionalString('posthog.repoPath', true),
  projects: z.union([
    z.literal('all'),
    z.array(z.number({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }).int({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }).positive({ error: 'posthog.projects must be "all" or an array of positive integer project ids' }), { error: 'posthog.projects must be "all" or an array of positive integer project ids' }),
  ], { error: 'posthog.projects must be "all" or an array of positive integer project ids' }).optional(),
  projectMap: z.record(z.string(), z.unknown(), { error: 'posthog.projectMap must be an object' }).optional(),
  ...Object.fromEntries(Object.entries(posthogNumberRanges).map(([key, range]) => [key,
    Object.hasOwn(POSTHOG_WHOLE_NUMBER_ROUNDING, key)
      ? optionalWholeNumber(`posthog.${key}`, range)
      : optionalNumber(`posthog.${key}`, range),
  ])),
});

const usageCostModeMessage = `usage.costMode must be one of ${USAGE_COST_MODES.join(', ')}`;
const usageVendorShape = Object.fromEntries(
  USAGE_VENDOR_KEYS.map((key) => [key, optionalBoolean(`usage.vendors.${key}`)]),
);
const usageBudgetShape = Object.fromEntries(
  USAGE_BUDGET_KEYS.map((key) => [
    key,
    z.number({ error: `usage.budget.${key} must be a positive number or null` })
      .positive({ error: `usage.budget.${key} must be a positive number or null` })
      .nullable()
      .optional(),
  ]),
);

const createUsageSettings = (isAbsolutePath: (directory: string) => boolean) => optionalObject('usage', {
  enabled: optionalBoolean('usage.enabled'),
  fetchPricing: optionalBoolean('usage.fetchPricing'),
  planLimits: optionalBoolean('usage.planLimits'),
  scanIntervalMinutes: optionalInteger('usage.scanIntervalMinutes', ranges.USAGE_INTEGER_RANGES.scanIntervalMinutes),
  retainDays: optionalInteger('usage.retainDays', ranges.USAGE_INTEGER_RANGES.retainDays),
  warehouseRetainDays: optionalInteger('usage.warehouseRetainDays', ranges.USAGE_INTEGER_RANGES.warehouseRetainDays),
  sessionBlockHours: optionalInteger('usage.sessionBlockHours', ranges.USAGE_INTEGER_RANGES.sessionBlockHours),
  costMode: z.enum(USAGE_COST_MODES, { error: usageCostModeMessage }).optional(),
  vendors: optionalObject('usage.vendors', usageVendorShape),
  budget: optionalObject('usage.budget', usageBudgetShape),
  extraProjectsDirs: z.array(z.string({ error: 'usage.extraProjectsDirs must be an array of absolute paths' }), { error: 'usage.extraProjectsDirs must be an array of absolute paths' })
    .transform((directories) => directories.map((directory) => directory.trim()))
    .refine((directories) => directories.every((directory) => directory && isAbsolutePath(directory)), { message: 'usage.extraProjectsDirs entries must be absolute paths' })
    .optional(),
});

const TelegramSettings = optionalObject('telegram', {
  botToken: optionalString('telegram.botToken', true),
  chatId: optionalString('telegram.chatId', true),
});

const IngestSettings = z.object({
  enabled: optionalBoolean('ingest.enabled'),
}, { error: 'ingest must be an object' }).passthrough().optional();

export const TraceSettings = z.object({
  enabled: optionalBoolean('trace.enabled'),
}, { error: 'trace must be an object' }).optional();

export const PlanReviewSettings = z.object({
  enabled: optionalBoolean('planReview.enabled'),
}, { error: 'planReview must be an object' }).optional();

const optionalPathList = (field: string) => z.array(z.string({ error: `${field} must be an array of paths` }).trim().min(1, { error: `${field} must be an array of paths` }), { error: `${field} must be an array of paths` }).optional();
const guardrailsShape = {
  unguardedRepos: optionalPathList('guardrails.unguardedRepos'),
  blockedPaths: optionalPathList('guardrails.blockedPaths'),
  unreadablePaths: optionalPathList('guardrails.unreadablePaths'),
};
const isHomeRelativePath = (entry: string) => entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\');
const createGuardrailsSettings = (isAbsolutePath: (directory: string) => boolean) => z.object({
  ...guardrailsShape,
  blockedPaths: z.array(
    z.string({ error: 'guardrails.blockedPaths must be an array of paths' }).trim()
      .min(1, { error: 'guardrails.blockedPaths must be an array of paths' })
      .refine((entry) => isHomeRelativePath(entry) || isAbsolutePath(entry), { message: 'guardrails.blockedPaths entries must be absolute paths or start with ~/' }),
    { error: 'guardrails.blockedPaths must be an array of paths' },
  ).optional(),
}, { error: 'guardrails must be an object' }).strict().optional();
export const GuardrailsFileSettings = z.object(guardrailsShape, { error: 'guardrails must be an object' }).passthrough().optional();

const telemetryShape = { enabled: optionalBoolean('telemetry.enabled') };
const TelemetrySettings = z.object(telemetryShape, { error: 'telemetry must be an object' }).strict().optional();
export const TelemetryFileSettings = z.object(telemetryShape, { error: 'telemetry must be an object' }).passthrough().optional();

const createBrowserConfigShape = (isAbsolutePath: (directory: string) => boolean) => ({
  port: z.number().int().min(ranges.PORT_RANGE.min).max(ranges.PORT_RANGE.max).optional(),
  notifyDebounceMs: z.number().finite().nonnegative().optional(),
  phoneEscalationMs: z.number().finite().nonnegative().optional(),
  replayBufferKB: optionalWholeNumber('replayBufferKB', ranges.REPLAY_BUFFER_KB_RANGE),
  sessionMemoryReserveMB: optionalWholeNumber('sessionMemoryReserveMB', ranges.MEMORY_RESERVE_MB_RANGE),
  cursorBlink: optionalBoolean('cursorBlink'),
  debugMode: optionalBoolean('debugMode'),
  streamerMode: optionalBoolean('streamerMode'),
  viewTabOrder: z.array(z.string({ error: 'viewTabOrder must be an array of view ids' }), { error: 'viewTabOrder must be an array of view ids' }).optional(),
  remoteSessions: optionalBoolean('remoteSessions'),
  detectBackgroundAgents: optionalBoolean('detectBackgroundAgents'),
  recordSignals: optionalBoolean('recordSignals'),
  saneYolo: optionalBoolean('saneYolo'),
  skipPermissionsByDefault: optionalBoolean('skipPermissionsByDefault'),
  checkForUpdates: optionalBoolean('checkForUpdates'),
  updateChannel: UpdateChannel.optional(),
  autoResume: optionalBoolean('autoResume'),
  telegramNotifications: optionalBoolean('telegramNotifications'),
  integrationBranch: optionalString('integrationBranch').nullable(),
  worktreeRoot: optionalString('worktreeRoot'),
  worktreeShare: z.array(z.string()).optional(),
  repoRoots: z.array(z.string()).optional(),
  taskTitle: TaskTitleSettings,
  branchGc: BranchGcSettings,
  visions: VisionsSettings,
  github: GithubSettings,
  teamReview: TeamReviewSettings,
  benchmarks: BenchmarksSettings,
  coherence: CoherenceSettings,
  issues: IssuesSettings,
  community: CommunitySettings,
  posthog: PosthogSettings,
  usage: createUsageSettings(isAbsolutePath),
  telegram: TelegramSettings,
  ingest: IngestSettings,
  guardrails: createGuardrailsSettings(isAbsolutePath),
  telemetry: TelemetrySettings,
  workflows: WorkflowsSettings.nullable().optional(),
});

export const createBrowserConfig = (isAbsolutePath: (directory: string) => boolean) => z.object(createBrowserConfigShape(isAbsolutePath));
export type BrowserConfig = z.infer<ReturnType<typeof createBrowserConfig>>;
