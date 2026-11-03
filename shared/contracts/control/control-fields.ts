import { z } from 'zod';
import { GH_SEGMENT } from '../github-ids.ts';
import { PLAN_BODY_CAP_BYTES, PLAN_COMMENTS_MAX, PLAN_COMMENT_MAX_CHARS, PLAN_FEEDBACK_MAX_CHARS } from '../plan-review.ts';
import { SESSION_DOC_PATH_MAX_CHARS, SessionState, TaskTitle, UnseenOutcome } from '../session.ts';
import { UpdateChannel, UpdateJournalSummary } from '../update-journal.ts';
import { LinkedPr, SessionPrLinks } from '../my-prs.ts';

export const CHANGES_POLL_INTERVAL_MS = 4_000;
export const CHANGES_WATCH_LEASE_MS = 10_000;

export const requestId = z.string().nullable().optional();
export const sessionId = z.string();
export const KeptWorkPath = z.object({ path: z.string(), reason: z.string() }).strict();
export type KeptWorkPath = z.infer<typeof KeptWorkPath>;
export const GithubTeam = z.object({ org: z.string().regex(GH_SEGMENT), slug: z.string().regex(GH_SEGMENT), name: z.string() });
export type GithubTeam = z.infer<typeof GithubTeam>;

export const PullRequestKey = SessionPrLinks.shape.unlinkedKeys.unwrap().element;

const GITHUB_PULL_REQUEST_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([0-9]+)(?:[/?#].*)?$/i;

export function pullRequestKeyFromReference(reference: string): string | null {
  const trimmedReference = reference.trim();
  const urlMatch = GITHUB_PULL_REQUEST_URL_RE.exec(trimmedReference);
  const candidateKey = urlMatch ? `${urlMatch[1]}#${urlMatch[2]}` : trimmedReference;
  const parsedKey = PullRequestKey.safeParse(candidateKey);
  return parsedKey.success ? parsedKey.data : null;
}
export function loose<const Type extends string>(type: Type): z.ZodObject<{ type: z.ZodLiteral<Type> }, z.core.$loose>;
export function loose<const Type extends string, Shape extends z.ZodRawShape>(type: Type, shape: Shape): z.ZodObject<{ type: z.ZodLiteral<Type> } & Shape, z.core.$loose>;
export function loose(type: string, shape?: z.ZodRawShape) {
  return z.looseObject({ type: z.literal(type), ...shape });
}

export function openObject(): z.ZodObject<Record<never, never>, z.core.$loose>;
export function openObject<Shape extends z.ZodRawShape>(shape: Shape): z.ZodObject<Shape, z.core.$loose>;
export function openObject(shape: z.ZodRawShape = {}) {
  return z.looseObject(shape);
}
export const nullableString = z.string().nullable();
export const DiffBase = z.object({ member: nullableString, ref: nullableString, sha: z.string(), verified: z.boolean() });
export const timestamp = z.number().finite();
export const optionalTimestamp = timestamp.optional();
export const optionalError = nullableString.optional();
export const opaqueObject = openObject();
export const opaqueArray = z.array(z.unknown());
export const planRevisionNumber = z.number().int().positive();
export const sessionDocPath = z.string().min(1).max(SESSION_DOC_PATH_MAX_CHARS);
export const trailSteps = z.array(z.union([
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
export const PlanLimitsVendor = z.enum(['claude', 'codex', 'kimi']);
export type PlanLimitsVendor = z.infer<typeof PlanLimitsVendor>;
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
  resumeSessionId: nullableString,
  ephemeral: z.boolean().optional(),
  ownerId: sessionId.optional(),
  linkedPrs: z.array(LinkedPr).optional(),
});
export type SessionCardFields = z.infer<typeof SessionCardFields>;

export const NotifyAlertGroup = z.object({
  id: z.number().int().positive(),
  isStart: z.boolean(),
  sessionIds: z.array(z.string()).min(1),
});
export type NotifyAlertGroup = z.infer<typeof NotifyAlertGroup>;

export const SessionStatusFields = z.object({
  transition: z.object({ from: SessionState, to: SessionState, event: z.string() }).optional(),
  skipPerms: z.boolean().optional(),
  saneYolo: z.boolean().optional(),
  failureReason: z.string().optional(),
  activeAgents: z.number().int().nonnegative().optional(),
  awaitingBackgroundTasks: z.boolean().optional(),
  unseenOutcome: UnseenOutcome.nullable().optional(),
  pendingPromptKind: nullableString.optional(),
});
export type SessionStatusFields = z.infer<typeof SessionStatusFields>;

export const CONTROL_FRAME_ENVELOPE_BYTES = 4096;
export const CONTROL_FRAME_MAX_BYTES = CONTROL_FRAME_ENVELOPE_BYTES
  + 2 * (PLAN_BODY_CAP_BYTES + PLAN_FEEDBACK_MAX_CHARS + 2 * PLAN_COMMENTS_MAX * PLAN_COMMENT_MAX_CHARS);

export const UpdateApplyRefusal = z.object({ reason: z.string(), message: z.string() });
export type UpdateApplyRefusal = z.infer<typeof UpdateApplyRefusal>;

export const InstallFlavor = z.enum(['npm-global', 'npx', 'clone', 'unknown']);
export type InstallFlavor = z.infer<typeof InstallFlavor>;

export const updateStatusShape = {
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

export const CLIENT_LOG_SCOPE_MAX_CHARS = 64;
export const CLIENT_LOG_TEXT_MAX_CHARS = 1000;
export const TELEMETRY_TEXT_MAX_CHARS = 512;

export const ClientLogReport = z.object({
  scope: z.string().min(1).max(CLIENT_LOG_SCOPE_MAX_CHARS),
  text: z.string().min(1).max(CLIENT_LOG_TEXT_MAX_CHARS),
}).strict();

export const DASHBOARD_TELEMETRY_EVENTS = Object.freeze(['view_shown', 'operator_action', 'onboarding_step', 'header_error_shown'] as const);
export const DASHBOARD_VIEWS = Object.freeze(['focus', 'prs', 'issues', 'usage', 'radar', 'community', 'boards', 'hooks', 'trace', 'benchmarks', 'settings'] as const);
export const OPERATOR_ACTIONS_BY_SURFACE = Object.freeze({
  usage: ['sort', 'range', 'period', 'expand', 'refresh'],
  issues: ['step', 'search', 'select', 'back', 'go-to-session', 'open-session', 'open-reviews', 'close', 'reopen', 'refresh'],
  radar: ['report', 'open-session', 'resolve', 'suppress', 'archive-investigation', 'approve-fix', 'dismiss-fix'],
  onboarding: ['rescan', 'add-root-typed', 'add-root-suggested', 'add-session', 'open-shell', 'check-github-again', 'save-github-teams', 'save-github-org', 'save-lane-read-token', 'save-review-skill', 'save-community-key', 'save-community-project', 'save-community-skill', 'save-community-discord', 'finish-community-setup'],
  reviews: ['open-session', 'approve', 'approve-only', 'comment', 'request-changes', 'discard', 'requeue', 'resolve-thread', 'merge', 'keep-mergeable', 'merge-when-ready', 'refresh'],
  hints: ['shown', 'open', 'dismiss'],
  star: ['shown', 'open', 'dismiss'],
  community: ['open-session', 'rerun', 'set-aside'],
} as const);
export const ONBOARDING_STEPS = Object.freeze(['agent', 'repo_roots', 'first_session'] as const);
export const ONBOARDING_STEP_STATES = Object.freeze(['current', 'done'] as const);
export type OnboardingStepReport = { step: (typeof ONBOARDING_STEPS)[number]; state: (typeof ONBOARDING_STEP_STATES)[number] };
export const OPERATOR_SURFACES = Object.freeze(['usage', 'issues', 'radar', 'onboarding', 'reviews', 'hints', 'star', 'community'] as const);
export type OperatorSurface = (typeof OPERATOR_SURFACES)[number];
export type OperatorAction = { [Surface in OperatorSurface]: (typeof OPERATOR_ACTIONS_BY_SURFACE)[Surface][number] }[OperatorSurface];
export type OperatorActionOf<Surface extends OperatorSurface> = (typeof OPERATOR_ACTIONS_BY_SURFACE)[Surface][number];
