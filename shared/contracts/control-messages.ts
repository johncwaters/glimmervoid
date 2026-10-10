import { ReviewsRefreshRequest, ReviewsRefreshResult } from './reviews.ts';
import { z } from 'zod';
import { FactoryControlRequest, FactoryControlResult, FactoryQueueIntentRequest, FactoryQueueIntentResult, FactoryState } from './factory.ts';
import {
  PLAN_BODY_CAP_BYTES,
  PLAN_COMMENTS_MAX,
  PLAN_COMMENT_MAX_CHARS,
  PLAN_FEEDBACK_MAX_CHARS,
  PlanChangedPush,
  PlanDecision,
  PlanDraftPush,
  PlanResponseFrame,
} from './plan-review.ts';
import { ChangeMap } from './change-map.ts';
import { PendingPromptDetail, PendingWakeup, SessionSnapshot, SessionState, TaskTitle } from './session.ts';
import { TraceRecord } from './trace.ts';
import { UpdateChannel, UpdateJournal, UpdateJournalSummary } from './update-journal.ts';
import { TeamReviewActionRequest, TeamReviewActionResult, TeamReviewStatus } from './team-review.ts';
import { MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsStatus } from './my-prs.ts';
import { BenchmarkActionRequest, BenchmarkActionResult, BenchmarkStatus } from './benchmark.ts';

const requestId = z.string().nullable().optional();
const sessionId = z.string();
function loose<const Type extends string>(type: Type): z.ZodObject<{ type: z.ZodLiteral<Type> }, z.core.$loose>;
function loose<const Type extends string, Shape extends z.ZodRawShape>(type: Type, shape: Shape): z.ZodObject<{ type: z.ZodLiteral<Type> } & Shape, z.core.$loose>;
function loose(type: string, shape?: z.ZodRawShape) {
  return z.looseObject({ type: z.literal(type), ...shape });
}

function openObject(): z.ZodObject<Record<never, never>, z.core.$loose>;
function openObject<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape, z.core.$loose>;
function openObject(shape: z.ZodRawShape = {}) {
  return z.looseObject(shape);
}
const nullableString = z.string().nullable();
const timestamp = z.number().finite();
const optionalTimestamp = timestamp.optional();
const optionalError = nullableString.optional();
const opaqueObject = openObject();
const opaqueArray = z.array(z.unknown());
const planRevisionNumber = z.number().int().positive();
const trailSteps = z.array(openObject({ at: timestamp, tool: z.string(), detail: z.string() }));
export const CustomAgentSummaryRow = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  resolvable: z.boolean().nullable(),
}).strict();
export type CustomAgentSummaryRow = z.infer<typeof CustomAgentSummaryRow>;

export const SessionCardFields = z.object({
  id: sessionId,
  session: z.string(),
  taskTitle: TaskTitle.nullable().optional(),
  taskTitleIsCustom: z.boolean().optional(),
  path: z.string(),
  agent: z.string(),
  state: SessionState,
  stateSince: timestamp,
  skipPerms: z.boolean(),
  saneYolo: z.boolean(),
  worktree: z.boolean(),
  workspace: z.boolean().optional(),
  resumeSessionId: nullableString,
  ephemeral: z.boolean().optional(),
});
export type SessionCardFields = z.infer<typeof SessionCardFields>;

const githubIssueRow = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string(), color: z.string() }).passthrough()),
  url: z.string(),
  updatedAt: z.string(),
}).passthrough();
export type GithubIssueRow = z.infer<typeof githubIssueRow>;

export const IssuesReportPush = z.object({
  ts: timestamp,
  projectId: z.string(),
  issues: z.array(githubIssueRow),
  error: optionalError,
});
export type IssuesReportPush = z.infer<typeof IssuesReportPush>;

export const DIFF_ANNOTATION_PATH_MAX_CHARS = 400;
export const DIFF_ANNOTATION_NOTE_MAX_CHARS = 1000;
const DIFF_ANNOTATION_PATH_RE = new RegExp(
  `^[^${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]+$`,
);

export const DiffAnnotation = z.strictObject({
  section: z.enum(['committed', 'uncommitted']),
  path: z.string().min(1).max(DIFF_ANNOTATION_PATH_MAX_CHARS).regex(DIFF_ANNOTATION_PATH_RE),
  line: z.number().int().positive(),
  side: z.enum(['old', 'new']),
  note: z.string().min(1).max(DIFF_ANNOTATION_NOTE_MAX_CHARS),
});
export type DiffAnnotation = z.infer<typeof DiffAnnotation>;

export const DIFF_ANNOTATIONS_MAX = 50;

export const CONTROL_FRAME_ENVELOPE_BYTES = 4096;
export const CONTROL_FRAME_MAX_BYTES = CONTROL_FRAME_ENVELOPE_BYTES
  + 2 * (PLAN_BODY_CAP_BYTES + PLAN_FEEDBACK_MAX_CHARS + 2 * PLAN_COMMENTS_MAX * PLAN_COMMENT_MAX_CHARS);

export const UpdateApplyRefusal = z.object({ reason: z.string(), message: z.string() });
export type UpdateApplyRefusal = z.infer<typeof UpdateApplyRefusal>;

export const InstallFlavor = z.enum(['npm-global', 'npx', 'clone', 'unknown']);
export type InstallFlavor = z.infer<typeof InstallFlavor>;

const updateStatusShape = {
  updateAvailable: z.boolean(),
  current: nullableString,
  latest: nullableString,
  currentSha: nullableString,
  latestSha: nullableString,
  releaseUrl: nullableString,
  command: z.string(),
  flavor: InstallFlavor,
  platform: z.string(),
  installedBranch: nullableString,
  upstream: nullableString,
  isTreeClean: z.boolean().nullable(),
  lastCheckAt: timestamp,
  channel: UpdateChannel,
  behindCount: z.number().int().nonnegative().nullable(),
  reason: nullableString,
  journalSummary: UpdateJournalSummary.nullable(),
  applyRefusal: UpdateApplyRefusal.nullable(),
};

export const UpdateStatus = z.object(updateStatusShape);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const CLIENT_ERROR_NAME_MAX_CHARS = 128;
export const CLIENT_ERROR_STACK_MAX_CHARS = 8192;

export const ClientErrorReport = z.object({
  name: z.string().max(CLIENT_ERROR_NAME_MAX_CHARS),
  stack: z.string().max(CLIENT_ERROR_STACK_MAX_CHARS),
}).strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

const idOnlyClientTypes = [
  'remove-session', 'kill', 'start-session', 'restart', 'force-restart', 'dismiss', 'sleep', 'wake',
  'merge-session', 'finish-session', 'merge-continue-session', 'discard-session-worktree',
  'resolve-session-merge', 'request-session-diff', 'request-change-map', 'request-branch-sync', 'resync-branch', 'debug-state',
] as const;

function idOnlyClientVariant<const Type extends string>(type: Type) {
  return loose(type, { id: sessionId, force: z.unknown().optional() });
}

const idOnlyClientVariants = idOnlyClientTypes.map(idOnlyClientVariant) as {
  [Type in typeof idOnlyClientTypes[number]]: ReturnType<typeof idOnlyClientVariant<Type>>;
}[typeof idOnlyClientTypes[number]][];

const clientVariants = [
  loose('add-session', {
    name: z.string(),
    path: z.string(),
    repos: z.array(z.string()).optional(),
    agent: z.string().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
  }),
  loose('list-conversations', { id: sessionId, requestId }),
  loose('resume-conversation', { id: sessionId, conversationId: z.string() }),
  loose('rename-session', { id: sessionId, newName: z.string() }),
  loose('set-session-title', { id: sessionId, title: TaskTitle }),
  loose('reorder-sessions', { order: z.array(sessionId) }),
  loose('ping', { requestId }),
  loose('get-settings', { requestId }),
  loose('update-settings', { settings: z.record(z.string(), z.unknown()), requestId }),
  loose('scan-repo-roots', { requestId }),
  loose('list-agents', { requestId }),
  loose('get-posthog-report', { issueId: z.union([z.string(), z.number()]), requestId }),
  loose('posthog-open-session', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), requestId }),
  loose('request-issues', { requestId, projectId: z.string() }),
  loose('open-issue-session', { requestId, projectId: z.string(), issueNumber: z.number().int().positive() }),
  loose('posthog-issue-action', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), action: z.string(), requestId }),
  loose('team-review-action', { ...TeamReviewActionRequest.shape, requestId }),
  loose('factory-queue-intent', { ...FactoryQueueIntentRequest.shape, requestId }),
  loose('factory-control', { ...FactoryControlRequest.shape, requestId }),
  loose('benchmark-action', { ...BenchmarkActionRequest.shape, requestId }),
  loose('my-pr-merge', { ...MyPrMergeRequest.shape, requestId }),
  loose('my-pr-keep-mergeable', { ...MyPrKeepMergeableRequest.shape, requestId }),
  loose('my-pr-merge-when-ready', { ...MyPrMergeWhenReadyRequest.shape, requestId }),
  loose('reviews-refresh', { ...ReviewsRefreshRequest.shape, requestId }),
  loose('posthog-archive-investigation', { id: z.unknown().optional(), requestId }),
  loose('request-usage-report', { requestId, days: z.unknown().optional(), force: z.unknown().optional() }),
  loose('request-hooks-report', { requestId }),
  loose('send-diff-annotations', {
    id: sessionId,
    annotations: z.array(DiffAnnotation).min(1).max(DIFF_ANNOTATIONS_MAX),
    requestId,
  }),

  loose('save-hook', { hook: z.record(z.string(), z.unknown()), requestId }),
  loose('delete-hook', { id: z.string(), requestId }),
  loose('shutdown'),
  loose('restart-server'),
  loose('focus-change', { focused: z.boolean() }),
  loose('request-health-snapshot'),
  loose('update-check'),
  loose('update-apply', {
    restartWhenStaged: z.boolean().optional(),
    confirmedSessionIds: z.array(z.string().min(1)).max(1000).optional(),
  }),
  loose('session-trace', {
    id: sessionId,
    after: z.number().int().nonnegative().default(0),
    endingAt: z.union([z.number().int().nonnegative(), z.literal('tail')]).optional(),
  }),
  loose('session-plan', {
    id: sessionId,
    agentId: nullableString,
    revision: planRevisionNumber.optional(),
    draft: z.boolean().optional(),
  }),
  loose('plan-decision', PlanDecision.shape),
  loose('client-error', ClientErrorReport.shape),
  ...idOnlyClientVariants,
] as const;

export const ClientMessage = z.discriminatedUnion('type', clientVariants);

export const SERVER_MESSAGE_TYPES = Object.freeze([
  'snapshot',
  'hooks-report',
  'save-hook-result',
  'delete-hook-result',
  'hooks-updated',
  'state-change',
  'session-added',
  'session-removed',
  'session-renamed',
  'session-title',
  'session-modified',
  'session-git',
  'session-agents',
  'session-wakeup',
  'session-prompt',
  'session-sleep',
  'session-wake',
  'session-merge-status',
  'session-worktree-blocked',
  'session-worktree-warning',
  'session-worktree-ready',
  'session-diff',
  'change-map',
  'send-diff-annotations-result',
  'branch-sync-status',
  'session-changed',
  'post-turn-result',
  'debug-state-response',
  'session-trace-response',
  'session-trace-changed',
  'session-plan-changed',
  'session-plan-draft',
  'session-plan-response',
  'notify',
  'update-status',
  'update-progress',
  'error',
  'session-error',
  'settings',
  'settings-error',
  'settings-updated',
  'pong',
  'agents-listed',
  'repo-roots-scanned',
  'conversations',
  'resume-conversation-ack',
  'health-snapshot',
  'posthog-status',
  'posthog-investigation-activity',
  'posthog-investigation-finished',
  'posthog-report',
  'posthog-open-session-result',
  'issues-report',
  'open-issue-session-result',
  'posthog-issue-action-result',
  'team-review-action-result',
  'benchmark-action-result',
  'factory-queue-intent-result',
  'factory-control-result',
  'my-pr-merge-result',
  'my-pr-keep-mergeable-result',
  'my-pr-merge-when-ready-result',
  'reviews-refresh-result',
  'posthog-archive-investigation-result',
  'team-review-status',
  'benchmark-status',
  'factory-state',
  'my-prs-status',
  'branch-gc-status',
  'usage-sessions',
  'usage-report',
  'plan-limits',
  'usage-budget-alert',
  'visions-findings',
  'visions-comments',
  'visions-hand',
  'visions-intent',
  'visions-fix',
  'visions-snapshot',
  'ingest-activity',
  'ingest-snapshot',
  'client-trust',
  'sessions-reordered',
  'shutting-down',
  'restarting',
] as const);

const serverVariants = [
  loose('snapshot', {
    sessions: z.array(SessionSnapshot),
    serverBuild: nullableString,
  }),
  loose('hooks-report', {
    requestId,
    ts: optionalTimestamp,
    hooks: z.array(opaqueObject).optional(),
    builtin: z.array(opaqueObject).optional(),
    events: z.array(openObject({ name: z.string(), matcher: nullableString, description: z.string(), http: z.boolean().optional() })).optional(),
    projects: z.array(openObject({ id: z.string(), name: z.string(), agent: z.string() })).optional(),
    limits: openObject({ maxTimeoutSec: z.number().int().positive() }).optional(),
    error: optionalError,
  }),
  loose('save-hook-result', { requestId, ok: z.boolean(), error: optionalError, hook: opaqueObject.optional() }),
  loose('delete-hook-result', { requestId, ok: z.boolean(), error: optionalError, id: z.string().optional() }),
  loose('hooks-updated', { count: z.number().int().nonnegative() }),
  loose('state-change', {
    id: sessionId,
    session: z.string(),
    from: SessionState,
    to: SessionState,
    event: z.string(),
    timestamp,
    skipPerms: z.boolean().optional(),
    saneYolo: z.boolean().optional(),
    hasEndedTurn: z.boolean().optional(),
  }),
  loose('session-added', SessionCardFields.shape),
  loose('session-modified', SessionCardFields.shape),
  loose('session-removed', { id: sessionId, session: z.string() }),
  loose('session-renamed', { id: sessionId, oldName: z.string(), newName: z.string() }),
  loose('session-title', { id: sessionId, taskTitle: TaskTitle.nullable(), isCustom: z.boolean() }),
  loose('session-git', { id: sessionId, worktree: z.boolean() }),
  loose('session-agents', { id: sessionId, activeAgents: z.number().int().nonnegative(), awaitingBackgroundTasks: z.boolean(), timestamp }),
  loose('session-wakeup', { id: sessionId, pendingWakeup: PendingWakeup.nullable(), timestamp }),
  loose('session-prompt', { isCompacting: z.boolean().optional(), id: sessionId, pendingPromptKind: nullableString, pendingPromptDetail: PendingPromptDetail.nullable().optional(), timestamp }),

  loose('session-sleep'),
  loose('session-wake'),
  loose('session-merge-status', {
    id: sessionId,
    mergeStatus: z.string(),
    reason: nullableString,
    parked: z.boolean(),
    timestamp,
  }),
  loose('session-worktree-blocked', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    notice: nullableString,
    timestamp,
  }),
  loose('session-worktree-warning', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    notice: nullableString,
    timestamp,
  }),
  loose('session-worktree-ready', {
    id: sessionId,
    session: z.string(),
    branch: nullableString,
    base: nullableString,
    timestamp,
  }),
  loose('session-diff', {
    id: sessionId,
    committed: openObject({ stat: z.string(), diff: z.string() }),
    uncommitted: openObject({ stat: z.string(), diff: z.string() }),
    hasCommits: z.boolean(),
  }),
  loose('change-map', { id: sessionId, map: ChangeMap }),
  loose('send-diff-annotations-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    pending: z.boolean().optional(),
  }),
  loose('branch-sync-status', {
    id: sessionId,
    branch: nullableString,
    upstream: nullableString,
    state: z.string(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    fetched: z.boolean().nullable(),
    action: z.string().optional(),
    error: optionalError,
  }),
  loose('session-changed', { id: sessionId }),
  loose('post-turn-result', {
    id: sessionId,
    mode: z.string(),
    skipped: nullableString,
    filesFixed: z.number().int().nonnegative(),
    findings: z.array(openObject({
      file: z.string(),
      rule: z.string(),
      count: z.number().int().nonnegative(),
    })),
    timestamp,
  }),
  loose('debug-state-response', { id: sessionId, payload: opaqueObject }),
  loose('session-trace-response', {
    id: sessionId,
    records: z.array(TraceRecord),
    start: z.number().int().nonnegative(),
    next: z.number().int().nonnegative(),
    reset: z.boolean(),
    path: z.string(),
  }),
  loose('session-trace-changed', { id: sessionId }),
  loose('session-plan-changed', PlanChangedPush.shape),
  loose('session-plan-draft', PlanDraftPush.shape),
  loose('session-plan-response', PlanResponseFrame.shape),
  loose('notify', {
    session: z.string(),
    category: z.string(),
    message: z.string(),
    escalationCount: z.number().int().nonnegative(),
    kind: z.literal('plan').optional(),
  }),
  loose('update-status', updateStatusShape),
  loose('update-progress', { journal: UpdateJournal }),
  loose('error', { id: sessionId.optional(), message: z.string(), requestId, scope: z.string().optional() }),
  loose('session-error', { id: sessionId.optional(), session: z.string(), message: z.string(), scope: z.string().optional() }),
  loose('settings', { settings: opaqueObject, requestId }),
  loose('settings-error', { message: z.string(), requestId }),
  loose('settings-updated', { settings: opaqueObject, requestId }),
  loose('pong', { requestId }),
  loose('agents-listed', {
    requestId,
    agents: z.array(openObject({ id: z.string(), label: z.string(), resolvable: z.boolean() })),
  }),
  loose('repo-roots-scanned', {
    requestId,
    directories: z.array(openObject({
      root: z.string(),
      projects: z.array(openObject({ name: z.string(), path: z.string() })),
    })),
    error: z.string().optional(),
  }),
  loose('conversations', {
    requestId,
    id: nullableString,
    current: nullableString.optional(),
    conversations: z.array(openObject({
      id: z.string(),
      title: z.string(),
      cwd: z.string(),
      worktreePath: z.string(),
      worktreeName: z.string(),
      gitBranch: nullableString,
      mtime: timestamp,
    })),
    error: z.string().optional(),
  }),
  loose('resume-conversation-ack', {
    id: sessionId.optional(),
    resumeSessionId: nullableString.optional(),
    ok: z.boolean(),
    error: z.string().optional(),
    requestId,
  }),
  loose('health-snapshot', { stats: opaqueObject }),
  loose('posthog-status', {
    ts: timestamp,
    intervalMinutes: z.number(),
    projects: z.array(opaqueObject),
    investigations: z.array(opaqueObject),
  }),
  loose('posthog-investigation-activity', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    inFlight: z.literal(true),
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('posthog-investigation-finished', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    verdict: z.string(),
    summaryLine: nullableString,
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('posthog-report', {
    requestId,
    ok: z.boolean(),
    found: z.boolean(),
    issueId: nullableString,
    format: z.string().optional(),
    content: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  loose('posthog-open-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
  }),
  loose('issues-report', { requestId, ...IssuesReportPush.shape }),
  loose('open-issue-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
  }),
  loose('posthog-issue-action-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    status: nullableString.optional(),
  }),
  loose('team-review-action-result', { ...TeamReviewActionResult.shape, requestId }),
  loose('factory-queue-intent-result', { ...FactoryQueueIntentResult.shape, requestId }),
  loose('factory-control-result', { ...FactoryControlResult.shape, requestId }),
  loose('benchmark-action-result', { ...BenchmarkActionResult.shape, requestId }),
  loose('my-pr-merge-result', { ...MyPrMergeResult.shape, requestId }),
  loose('my-pr-keep-mergeable-result', { ...MyPrKeepMergeableResult.shape, requestId }),
  loose('my-pr-merge-when-ready-result', { ...MyPrMergeWhenReadyResult.shape, requestId }),
  loose('reviews-refresh-result', { ...ReviewsRefreshResult.shape, requestId }),
  loose('posthog-archive-investigation-result', { requestId, ok: z.boolean(), error: optionalError }),
  TeamReviewStatus,
  BenchmarkStatus,
  loose('factory-state', FactoryState.shape),
  MyPrsStatus,

  loose('branch-gc-status'),
  loose('usage-sessions', {
    ts: timestamp,
    pricingSource: nullableString,
    sessions: z.array(openObject({
      id: sessionId,
      tokens: z.number(),
      costUSD: z.number(),
      officialCostUSD: z.number().nullable().optional(),
    })),
  }),
  loose('usage-report', {
    requestId,
    ts: optionalTimestamp,
    tz: z.string().optional(),
    blockHours: z.number().optional(),
    totals: opaqueObject.optional(),
    daily: opaqueArray.optional(),
    models: opaqueArray.optional(),
    sessions: opaqueArray.optional(),
    blocks: opaqueArray.optional(),
    activeBlock: z.unknown().nullable().optional(),
    anomaly: z.unknown().nullable().optional(),
    byLane: z.unknown().optional(),
    planWindowLanes: z.unknown().nullable().optional(),
    budget: z.unknown().optional(),
    savings: z.unknown().optional(),
    tokenLimit: z.unknown().nullable().optional(),
    pricing: opaqueObject.optional(),
    scan: opaqueObject.optional(),
    warning: optionalError,
    error: optionalError,
  }),
  loose('plan-limits', {
    ts: timestamp,
    fiveHour: z.unknown().nullable(),
    sevenDay: z.unknown().nullable(),
    source: z.string(),
  }),
  loose('usage-budget-alert', {
    scope: z.string(),
    periodKey: z.string(),
    threshold: z.number(),
    text: z.string(),
    ts: timestamp,
  }),
  loose('visions-findings', { uri: z.string(), diagnostics: opaqueArray, ts: timestamp }),
  loose('visions-comments', { uri: z.string(), comments: opaqueArray, ts: timestamp }),
  loose('visions-hand', { uri: z.string(), hand: nullableString, ts: timestamp }),
  loose('visions-intent', { projectId: nullableString, intent: opaqueObject, ts: timestamp }),
  loose('visions-fix', { uri: z.string(), fix: opaqueObject, ts: timestamp }),
  loose('visions-snapshot', {
    documents: z.array(opaqueObject),
    intent: opaqueObject,
    fixes: z.array(opaqueObject),
    ts: timestamp,
  }),
  loose('ingest-activity', { events: z.array(opaqueObject), overflow: z.number().int().nonnegative(), ts: timestamp }),
  loose('ingest-snapshot', { events: z.array(opaqueObject), sources: z.unknown(), ts: timestamp }),
  loose('client-trust', { trust: z.enum(['local', 'remote']) }),
  loose('sessions-reordered', { order: z.array(sessionId) }),
  loose('shutting-down'),
  loose('restarting'),
] as const;

export const ServerMessage = z.discriminatedUnion('type', serverVariants);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ClientMessageOf<Type extends ClientMessage['type']> = Extract<ClientMessage, { type: Type }>;
export type ServerMessageOf<Type extends ServerMessage['type']> = Extract<ServerMessage, { type: Type }>;
