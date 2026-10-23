import { IssueRepoSlug, IssuesStatus } from './issues.ts';
import { GithubPollingRefreshRequest, GithubPollingRefreshResult } from './github-polling.ts';
import { z } from 'zod';
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
import {
  COHERENCE_JOURNAL_DRAWER_MAX_ROWS, CoherenceJournalEntry, SessionCoherence,
} from './coherence.ts';
import { CoherenceHooksState, ConversationAnswers, ConversationApproval, ConversationApprovalDecision, PendingWakeup, SESSION_DOC_PATH_MAX_CHARS, SessionDoc, SessionSnapshot, SessionState, TaskTitle, UnseenOutcome } from './session.ts';
import { TraceRecord } from './trace.ts';
import { SessionSetup } from './session-setup.ts';
import { UpdateChannel, UpdateJournal, UpdateJournalSummary } from './update-journal.ts';
import { TeamReviewActionRequest, TeamReviewActionResult, TeamReviewStatus, hasRequiredActionHead } from './team-review.ts';
import { LinkedPr, MyPrKeepMergeableRequest, MyPrKeepMergeableResult, MyPrMergeRequest, MyPrMergeResult, MyPrMergeWhenReadyRequest, MyPrMergeWhenReadyResult, MyPrsStatus, SessionPrLinks } from './my-prs.ts';
import { GithubPrsFrame } from './github-prs.ts';
import { BenchmarkActionRequest, BenchmarkActionResult, BenchmarkStatus } from './benchmark.ts';

const requestId = z.string().nullable().optional();
const sessionId = z.string();
export const KeptWorkPath = z.object({ path: z.string(), reason: z.string() }).strict();
export type KeptWorkPath = z.infer<typeof KeptWorkPath>;

const PullRequestKey = SessionPrLinks.shape.unlinkedKeys.unwrap().element;

const GITHUB_PULL_REQUEST_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([0-9]+)(?:[/?#].*)?$/i;

export function pullRequestKeyFromReference(reference: string): string | null {
  const trimmedReference = reference.trim();
  const urlMatch = GITHUB_PULL_REQUEST_URL_RE.exec(trimmedReference);
  const candidateKey = urlMatch ? `${urlMatch[1]}#${urlMatch[2]}` : trimmedReference;
  const parsedKey = PullRequestKey.safeParse(candidateKey);
  return parsedKey.success ? parsedKey.data : null;
}
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
const sessionDocPath = z.string().min(1).max(SESSION_DOC_PATH_MAX_CHARS);
const trailSteps = z.array(z.union([
  openObject({ at: timestamp, tool: z.string(), detail: z.string() }),
  openObject({ at: timestamp, note: z.string() }),
]));
export const CustomAgentSummaryRow = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  resolvable: z.boolean().nullable(),
}).strict();
export type CustomAgentSummaryRow = z.infer<typeof CustomAgentSummaryRow>;

const CoderEnvironmentOffer = z.object({
  name: z.string(),
  template: z.string(),
  parameters: z.record(z.string(), z.string()),
  hourlyCostUsd: z.number().nullable(),
  idleStopMinutes: z.number(),
});
export type CoderEnvironmentOffer = z.infer<typeof CoderEnvironmentOffer>;
export const CoderEnvironmentOffers = z.array(CoderEnvironmentOffer).nullable();
export const ConnectableAgent = z.enum(['claude-code', 'codex']);
export type ConnectableAgent = z.infer<typeof ConnectableAgent>;
export const AgentLoginStatus = z.object({
  agent: ConnectableAgent,
  state: z.enum(['signed-in', 'signed-out', 'connecting', 'failed']),
  source: z.enum(['host', 'glimmervoid']).nullable(),
  verificationUrl: z.string().nullable(),
  userCode: z.string().nullable(),
  needsPastedCode: z.boolean(),
  reason: z.string().nullable(),
}).strict();
export type AgentLoginStatus = z.infer<typeof AgentLoginStatus>;
export const AgentLoginStatuses = z.array(AgentLoginStatus);
export const TelegramDeliveryStatus = z.object({
  setupWarning: nullableString,
  lastFailure: z.object({ message: z.string(), failedAt: timestamp }).nullable(),
});
export type TelegramDeliveryStatus = z.infer<typeof TelegramDeliveryStatus>;

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
  remoteWorkspace: z.string().optional(),
  guarded: z.boolean().optional(),
  guardrailsReleased: z.boolean().optional(),
  resumeSessionId: nullableString,
  ephemeral: z.boolean().optional(),
  ownerId: sessionId.optional(),
  linkedPrs: z.array(LinkedPr).optional(),
});
export type SessionCardFields = z.infer<typeof SessionCardFields>;

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
  deprecation: nullableString,
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

const DASHBOARD_TELEMETRY_EVENTS = Object.freeze(['view_shown', 'operator_action'] as const);
export const DASHBOARD_VIEWS = Object.freeze(['focus', 'zen', 'prs', 'issues', 'usage', 'radar', 'visions', 'hooks', 'trace', 'benchmarks', 'settings'] as const);
export const OPERATOR_ACTIONS_BY_SURFACE = Object.freeze({
  usage: ['sort', 'range', 'period', 'expand', 'refresh'],
  issues: ['scope', 'filter', 'search', 'filters-toggle', 'select', 'back', 'go-to-session', 'open-session', 'refresh'],
  radar: ['report', 'open-session', 'resolve', 'suppress', 'archive-investigation'],
  reviews: ['open-session', 'approve', 'approve-only', 'comment', 'discard', 'requeue', 'resolve-thread', 'merge', 'keep-mergeable', 'merge-when-ready', 'refresh'],
} as const);
export const OPERATOR_SURFACES = Object.freeze(['usage', 'issues', 'radar', 'reviews'] as const);
export type OperatorSurface = (typeof OPERATOR_SURFACES)[number];
export type OperatorAction = { [Surface in OperatorSurface]: (typeof OPERATOR_ACTIONS_BY_SURFACE)[Surface][number] }[OperatorSurface];
export type OperatorActionOf<Surface extends OperatorSurface> = (typeof OPERATOR_ACTIONS_BY_SURFACE)[Surface][number];

const idOnlyClientTypes = [
  'kill', 'start-session', 'restart', 'force-restart',
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
    unguarded: z.boolean().optional(),
    runInPlace: z.boolean().optional(),
    environment: z.string().optional(),
    requestId,
  }),
  loose('remove-session', { id: sessionId, force: z.unknown().optional(), discardWork: z.boolean().optional(), confirmedKeptPaths: z.array(z.string()).optional(), requestId }),
  loose('list-conversations', { id: sessionId, requestId }),
  loose('resume-conversation', { id: sessionId, conversationId: z.string() }),
  loose('rename-session', { id: sessionId, newName: z.string() }),
  loose('get-workspace-repos', { id: sessionId, requestId }),
  loose('set-workspace-repos', { id: sessionId, repos: z.array(z.string()), requestId }),
  loose('set-session-title', { id: sessionId, title: TaskTitle }),
  loose('link-session-pr', { id: sessionId, key: PullRequestKey }),
  loose('unlink-session-pr', { id: sessionId, key: PullRequestKey }),
  loose('ping', { requestId }),
  loose('get-settings', { requestId }),
  loose('get-agent-logins', { requestId }),
  loose('start-remote-setup', { agent: ConnectableAgent, requestId }),
  loose('agent-connect', { agent: ConnectableAgent, action: z.enum(['start', 'cancel']), requestId }),
  loose('agent-connect-code', { agent: ConnectableAgent, code: z.string(), requestId }),
  loose('update-settings', { settings: z.record(z.string(), z.unknown()), requestId }),
  loose('scan-repo-roots', { requestId, includeSuggestions: z.boolean().optional() }),
  loose('list-agents', { requestId, rescan: z.boolean().optional() }),
  loose('get-radar-report', { issueId: z.union([z.string(), z.number()]), requestId }),
  loose('radar-open-session', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), requestId }),
  loose('issue-detail', { requestId: z.string().min(1), repo: IssueRepoSlug, issueNumber: z.number().int().positive() }),
  loose('open-issue-session', { requestId, projectId: z.string(), repo: IssueRepoSlug, issueNumber: z.number().int().positive() }),
  loose('radar-issue-action', { projectId: z.union([z.string(), z.number()]), issueId: z.union([z.string(), z.number()]), action: z.string(), requestId }),
  loose('open-team-review-session', { requestId, key: PullRequestKey }),
  loose('team-review-action', { ...TeamReviewActionRequest.shape, requestId }).refine(hasRequiredActionHead, { message: 'only discard may omit head', path: ['head'] }),
  loose('benchmark-action', { ...BenchmarkActionRequest.shape, requestId }),
  loose('my-pr-merge', { ...MyPrMergeRequest.shape, requestId }),
  loose('my-pr-keep-mergeable', { ...MyPrKeepMergeableRequest.shape, requestId }),
  loose('my-pr-merge-when-ready', { ...MyPrMergeWhenReadyRequest.shape, requestId }),
  loose('github-polling-refresh', { ...GithubPollingRefreshRequest.shape, requestId }),
  loose('radar-archive-investigation', { id: z.unknown().optional(), requestId }),
  loose('telegram-test', { requestId }),
  loose('request-usage-report', { requestId, days: z.unknown().optional(), force: z.unknown().optional() }),
  loose('request-hooks-report', { requestId }),

  loose('save-hook', { hook: z.record(z.string(), z.unknown()), requestId }),
  loose('delete-hook', { id: z.string(), requestId }),
  loose('shutdown'),
  loose('restart-server'),
  loose('focus-change', { focused: z.boolean() }),
  loose('request-health-snapshot'),
  loose('update-check'),
  loose('update-apply'),
  loose('session-trace', {
    id: sessionId,
    requestId,
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
  loose('set-session-conversation-view', { id: sessionId, isOn: z.boolean() }),
  loose('set-session-guardrails', { id: sessionId, isOn: z.boolean() }),
  loose('conversation-approval', { id: sessionId, requestId: ConversationApproval.shape.requestId, decision: ConversationApprovalDecision, answers: ConversationAnswers.optional() }),
  loose('session-doc-read', { id: sessionId, path: sessionDocPath, requestId }),
  loose('session-doc-save', { id: sessionId, path: sessionDocPath, text: z.string(), baseHash: z.string().min(1), requestId }),
  loose('session-coherence-journal', { id: sessionId, requestId }),
  loose('session-setup', { id: sessionId, requestId }),
  loose('client-error', ClientErrorReport.shape),
  loose('dashboard-telemetry', { event: z.enum(DASHBOARD_TELEMETRY_EVENTS), properties: z.record(z.string(), z.unknown()) }),
  loose('dismiss', { id: sessionId, force: z.unknown().optional(), expectedState: SessionState.optional() }),
  ...idOnlyClientVariants,
] as const;

export const ClientMessage = z.discriminatedUnion('type', clientVariants);

export const SERVER_MESSAGE_TYPES = Object.freeze([
  'snapshot',
  'hooks-report',
  'save-hook-result',
  'add-session-result',
  'start-remote-setup-result',
  'remove-session-result',
  'agent-logins',
  'delete-hook-result',
  'workspace-repos',
  'set-workspace-repos-result',
  'hooks-updated',
  'state-change',
  'session-added',
  'session-removed',
  'session-renamed',
  'session-title',
  'session-prs',
  'session-modified',
  'session-git',
  'session-coherence-hooks',
  'session-agents',
  'session-wakeup',
  'session-prompt',
  'session-conversation',
  'session-merge-status',
  'session-worktree-blocked',
  'session-worktree-warning',
  'session-worktree-ready',
  'session-diff',
  'session-diff-error',
  'change-map',
  'branch-sync-status',
  'session-changed',
  'post-turn-result',
  'debug-state-response',
  'session-trace-response',
  'session-trace-changed',
  'session-plan-changed',
  'session-plan-draft',
  'session-plan-response',
  'session-docs-changed',
  'session-docs-snapshot',
  'session-doc-response',
  'session-doc-save-result',
  'session-coherence',
  'session-coherence-snapshot',
  'session-coherence-journal-response',
  'session-setup-response',
  'notify',
  'update-status',
  'update-progress',
  'post-turn-leftovers',
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
  'radar-status',
  'radar-investigation-activity',
  'radar-investigation-finished',
  'radar-report',
  'radar-open-session-result',
  'issue-detail-result',
  'open-issue-session-result',
  'open-team-review-session-result',
  'radar-issue-action-result',
  'team-review-action-result',
  'benchmark-action-result',
  'my-pr-merge-result',
  'my-pr-keep-mergeable-result',
  'my-pr-merge-when-ready-result',
  'github-polling-refresh-result',
  'radar-archive-investigation-result',
  'team-review-status',
  'benchmark-status',
  'my-prs-status',
  'issues-status',
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
  loose('add-session-result', { requestId, ok: z.boolean(), error: optionalError, reason: z.enum(['not-git']).optional() }),
  loose('remove-session-result', { requestId, ok: z.boolean(), error: optionalError, canDiscardWork: z.boolean().optional(), keptPaths: z.array(KeptWorkPath).optional() }),
  loose('agent-logins', { requestId, logins: AgentLoginStatuses, error: optionalError }),
  loose('start-remote-setup-result', { requestId, ok: z.boolean(), error: optionalError, sessionId: z.string().optional(), sessionName: z.string().optional() }),
  loose('delete-hook-result', { requestId, ok: z.boolean(), error: optionalError, id: z.string().optional() }),
  loose('workspace-repos', { requestId, id: sessionId, ok: z.boolean(), repos: z.array(z.string()), error: optionalError }),
  loose('set-workspace-repos-result', { requestId, id: sessionId, ok: z.boolean(), error: optionalError }),
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
    failureReason: z.string().optional(),
  }),
  loose('session-added', SessionCardFields.shape),
  loose('session-modified', SessionCardFields.shape),
  loose('session-removed', { id: sessionId, session: z.string() }),
  loose('session-renamed', { id: sessionId, oldName: z.string(), newName: z.string() }),
  loose('session-title', { id: sessionId, taskTitle: TaskTitle.nullable(), isCustom: z.boolean() }),
  loose('session-prs', { id: sessionId, linkedPrs: z.array(LinkedPr) }),
  loose('session-git', { id: sessionId, worktree: z.boolean() }),
  loose('session-coherence-hooks', { id: sessionId, coherenceHooks: CoherenceHooksState.nullable() }),
  loose('session-agents', { id: sessionId, activeAgents: z.number().int().nonnegative(), awaitingBackgroundTasks: z.boolean(), timestamp }),
  loose('session-unseen', { id: sessionId, unseenOutcome: UnseenOutcome.nullable(), timestamp }),
  loose('session-wakeup', { id: sessionId, pendingWakeup: PendingWakeup.nullable(), timestamp }),
  loose('session-prompt', { isCompacting: z.boolean().optional(), id: sessionId, pendingPromptKind: nullableString, timestamp }),
  loose('session-conversation', { id: sessionId, hasConversationBridge: z.boolean(), isConversationViewOn: z.boolean(), conversationApproval: ConversationApproval.nullable() }),

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
  loose('session-diff-error', { id: sessionId, message: z.string() }),
  loose('change-map', { id: sessionId, map: ChangeMap }),
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
    requestId,
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
  loose('session-docs-changed', { id: sessionId, docs: z.array(SessionDoc) }),
  loose('session-docs-snapshot', { sessions: z.record(z.string(), z.array(SessionDoc)) }),
  loose('session-doc-response', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), text: z.string().optional(), hash: z.string().optional(), error: optionalError }),
  loose('session-doc-save-result', { requestId, id: sessionId, path: z.string(), ok: z.boolean(), hash: z.string().optional(), conflict: z.boolean().optional(), error: optionalError }),
  loose('session-coherence', { id: sessionId, ...SessionCoherence.shape }),
  loose('session-coherence-snapshot', { sessions: z.record(z.string(), SessionCoherence) }),
  loose('session-coherence-journal-response', { requestId, id: sessionId, ok: z.boolean(), entries: z.array(CoherenceJournalEntry).max(COHERENCE_JOURNAL_DRAWER_MAX_ROWS), error: optionalError }),
  loose('session-setup-response', { requestId, id: sessionId, ok: z.boolean(), setup: SessionSetup.optional(), error: optionalError }),
  loose('notify', {
    session: z.string(),
    category: z.string(),
    message: z.string(),
    escalationCount: z.number().int().nonnegative(),
    kind: z.literal('plan').optional(),
  }),
  loose('update-status', updateStatusShape),
  loose('update-progress', { journal: UpdateJournal }),
  loose('post-turn-leftovers', { repositories: z.array(z.string()), command: z.string() }),
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
      projects: z.array(openObject({ name: z.string(), path: z.string(), isGit: z.boolean().optional() })),
    })),
    suggestions: z.array(openObject({ path: z.string(), label: z.string(), gitRepoCount: z.number().int().nonnegative() })).optional(),
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
  loose('radar-status', {
    ts: timestamp,
    intervalMinutes: z.number(),
    projects: z.array(opaqueObject),
    investigations: z.array(opaqueObject),
  }),
  loose('radar-investigation-activity', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    inFlight: z.literal(true),
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('radar-investigation-finished', {
    projectId: z.union([z.string(), z.number()]),
    issueId: z.string(),
    verdict: z.string(),
    summaryLine: nullableString,
    startedAt: timestamp.nullable(),
    trail: trailSteps,
  }),
  loose('radar-report', {
    requestId,
    ok: z.boolean(),
    found: z.boolean(),
    issueId: nullableString,
    format: z.string().optional(),
    content: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  loose('radar-open-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
  }),
  loose('issue-detail-result', { requestId: z.string().min(1), ok: z.boolean(), body: z.string().nullable(), error: z.string().nullable() }),
  loose('open-issue-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
    existing: z.boolean().optional(),
  }),
  loose('open-team-review-session-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    key: PullRequestKey.optional(),
    sessionId: z.string().optional(),
    sessionName: z.string().optional(),
    pending: z.boolean().optional(),
    existing: z.boolean().optional(),
  }),
  loose('radar-issue-action-result', {
    requestId,
    ok: z.boolean(),
    error: optionalError,
    status: nullableString.optional(),
  }),
  loose('team-review-action-result', { ...TeamReviewActionResult.shape, requestId }),
  loose('benchmark-action-result', { ...BenchmarkActionResult.shape, requestId }),
  loose('my-pr-merge-result', { ...MyPrMergeResult.shape, requestId }),
  loose('my-pr-keep-mergeable-result', { ...MyPrKeepMergeableResult.shape, requestId }),
  loose('my-pr-merge-when-ready-result', { ...MyPrMergeWhenReadyResult.shape, requestId }),
  loose('github-polling-refresh-result', { ...GithubPollingRefreshResult.shape, requestId }),
  loose('radar-archive-investigation-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('telegram-test-result', { requestId, ok: z.boolean(), error: optionalError, telegramDelivery: TelegramDeliveryStatus.nullable() }),
  TeamReviewStatus,
  BenchmarkStatus,
  MyPrsStatus,
  GithubPrsFrame,
  IssuesStatus,

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
    vendor: z.enum(['claude', 'codex']).optional(),
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
  loose('shutting-down'),
  loose('restarting'),
] as const;

export const ServerMessage = z.discriminatedUnion('type', serverVariants);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export type ClientMessageOf<Type extends ClientMessage['type']> = Extract<ClientMessage, { type: Type }>;
export type ServerMessageOf<Type extends ServerMessage['type']> = Extract<ServerMessage, { type: Type }>;
