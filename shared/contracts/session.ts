import { z } from 'zod';
import { STATES } from '../states.ts';
import { LinkedPr, MyPr } from './my-prs.ts';
import { InFlightReview, QueuedReview, ReviewDraft } from './team-review.ts';

export const TASK_TITLE_MAX_LENGTH = 120;
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_\-. ()]{1,64}$/;
export const SESSION_NAME_RULE_TEXT = 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)';
export const TASK_TITLE_CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const TaskTitle = z.string().refine((title) => !TASK_TITLE_CONTROL_CHARACTERS.test(title)).trim().max(TASK_TITLE_MAX_LENGTH);
export const RefinedTaskTitle = z.object({ title: z.string().nullable(), name: z.string().nullable().optional() }).strict();
export const SessionState = z.enum(STATES);
export const UnseenOutcome = z.enum(['finished', 'failed']);

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

export const CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS = 4000;
export const CONVERSATION_PERMISSION_HOOK_EVENT = 'permissionrequest-conversation';
export const CONVERSATION_TOOL_RESULT_HOOK_EVENT = 'posttooluse-conversation';
const CONVERSATION_QUESTION_MAX_CHARS = 1000;
const CONVERSATION_ANSWER_MAX_CHARS = 2000;

export const ConversationQuestion = z.object({
  question: z.string().min(1).max(CONVERSATION_QUESTION_MAX_CHARS),
  header: z.string().max(100).default(''),
  options: z.array(z.object({
    label: z.string().min(1).max(200),
    description: z.string().max(CONVERSATION_QUESTION_MAX_CHARS).default(''),
  })).min(1).max(8),
  multiSelect: z.boolean().default(false),
});

export const ConversationApproval = z.object({
  requestId: z.union([z.string().min(1).max(128), z.number().int()]),
  kind: z.literal('question'),
  summary: z.string().max(CONVERSATION_APPROVAL_SUMMARY_MAX_CHARS),
  isSummaryTruncated: z.boolean(),
  questions: z.array(ConversationQuestion).min(1).max(4).optional(),
});

export const ConversationAnswers = z.record(z.string().max(CONVERSATION_QUESTION_MAX_CHARS), z.string().max(CONVERSATION_ANSWER_MAX_CHARS));

const COHERENCE_HOOKS_REASON_MAX_CHARS = 80;
export const COHERENCE_HOOKS_INACTIVE = Object.freeze({
  notInstalled: 'not installed',
  unsupportedVersion: 'unsupported version',
  codexHooksUntrusted: 'Codex hooks need trust in /hooks',
});
export const CoherenceHooksState = z.discriminatedUnion('active', [
  z.object({ active: z.literal(true) }).strict(),
  z.object({ active: z.literal(false), reason: z.string().min(1).max(COHERENCE_HOOKS_REASON_MAX_CHARS), version: z.string().optional() }).strict(),
]);

export const SessionSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  taskTitle: TaskTitle.nullable().default(null),
  taskTitleIsCustom: z.boolean().default(false),
  path: z.string(),
  agent: z.string(),
  state: SessionState,
  stateSince: z.number(),
  dangerouslySkipPermissions: z.boolean(),
  saneYolo: z.boolean().default(false),
  ephemeral: z.boolean(),
  ownerId: z.string().nullable().optional(),
  isWorktree: z.boolean(),
  isWorkspace: z.boolean().default(false),
  remoteWorkspace: z.string().nullable().default(null),
  isGuarded: z.boolean().default(false),
  isGuardrailsReleased: z.boolean().default(false),
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  awaitingBackgroundTasks: z.boolean(),
  pendingPromptKind: z.string().nullable(),
  hasPlan: z.boolean().default(false),
  mergeStatus: z.string().nullable(),
  mergeReason: z.string().nullable(),
  worktreeNotice: z.string().nullable(),
  failureReason: z.string().nullable().optional(),
  unseenOutcome: UnseenOutcome.nullable().default(null),
  effectiveBase: z.string().nullable(),
  linkedPrs: z.array(LinkedPr).default([]),
  coherenceHooks: CoherenceHooksState.nullable().default(null),
  auditLog: z.array(z.unknown()),
}).passthrough();

export type RefinedTaskTitle = z.infer<typeof RefinedTaskTitle>;
export type SessionState = z.infer<typeof SessionState>;
export type UnseenOutcome = z.infer<typeof UnseenOutcome>;
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
export type CoherenceHooksState = z.infer<typeof CoherenceHooksState>;
export type ConversationApproval = z.infer<typeof ConversationApproval>;
export type ConversationQuestion = z.infer<typeof ConversationQuestion>;
export type ConversationAnswers = z.infer<typeof ConversationAnswers>;

export const AGENT_URL_ENV = 'GLIMMERVOID_AGENT_URL';
export const SIGN_URL_ENV = 'GLIMMERVOID_SIGN_URL';
export const SSH_SIGN_BODY_CAP_BYTES = 1024 * 1024;

export const SshSignRequest = z.object({
  namespace: z.literal('git', { error: 'namespace must be git' }),
  publicKey: z.string({ error: 'publicKey must be a string' }).min(1, { error: 'publicKey must not be empty' }).max(16384, { error: 'publicKey must be at most 16384 characters' }),
  payload: z.base64({ error: 'payload must be base64' }),
}).strict();

export const SshSignReply = z.union([
  z.object({ ok: z.literal(true), signature: z.string() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

export type SshSignRequest = z.infer<typeof SshSignRequest>;
export type SshSignReply = z.infer<typeof SshSignReply>;
export const SESSION_COMMANDS = ['push', 'spawn', 'send', 'read', 'close', 'attention', 'board', 'edit', 'show', 'review', 'reviews', 'prs', 'link-pr', 'settings'] as const;
export const AGENT_API_VERBS = [...SESSION_COMMANDS, 'limits', 'answer'] as const;
export type AgentApiVerb = (typeof AGENT_API_VERBS)[number];


export const AgentSpawnRequest = z.object({
  prompt: z.string({ error: 'prompt must be a string' })
    .min(1, { error: 'prompt must not be empty' })
    .max(20000, { error: 'prompt must be at most 20000 characters' })
    .refine((prompt) => !prompt.trimStart().startsWith('-'), { message: 'prompt must not start with a dash, which the agent CLI would read as an option' }),
  name: z.string({ error: 'name must be a string' }).min(1, { error: 'name must not be empty' }).max(200, { error: 'name must be at most 200 characters' }).optional(),
  agent: z.string({ error: 'agent must be a string' }).min(1, { error: 'agent must not be empty' }).max(40, { error: 'agent must be at most 40 characters' }).optional(),
}).strict();

const SessionTarget = z.string({ error: 'the session must be a string' }).min(1, { error: 'the session must not be empty' }).max(300, { error: 'the session must be at most 300 characters' });

export const AgentSendRequest = z.object({
  words: z.array(z.string({ error: 'each word must be a string' }).max(20000, { error: 'each word must be at most 20000 characters' }), { error: 'words must be a list' })
    .min(1, { error: 'send needs text' })
    .max(5000, { error: 'send takes at most 5000 words' }),
}).strict();

export const AgentReadRequest = z.object({
  child: SessionTarget.optional(),
}).strict();

export const AgentCloseRequest = z.object({
  child: SessionTarget,
  discard: z.boolean().optional(),
}).strict();

export const AgentAnswerRequest = z.union([
  z.object({ child: SessionTarget, answers: z.record(z.string(), z.string().min(1)) }).strict(),
  z.object({ child: SessionTarget, toOperator: z.literal(true) }).strict(),
]);

const AgentChannelEntry = z.object({
  from: z.enum(['parent', 'child', 'glimmervoid']),
  at: z.number().finite(),
  text: z.string(),
}).strict();

export const AgentReadReply = z.object({
  ok: z.literal(true),
  channels: z.array(z.object({
    sessionId: z.string(),
    name: z.string(),
    entries: z.array(AgentChannelEntry),
    dropped: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export const AGENT_ATTENTION_NOTE_SEPARATOR = ' | ';

export const AgentAttentionRequest = z.object({
  note: z.string({ error: 'note must be a string' }).min(1, { error: 'note must not be empty' }).max(500, { error: 'note must be at most 500 characters' }),
}).strict();

export const AgentAttentionReply = z.union([
  z.object({ ok: z.literal(true), pending: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

export const AgentBoardRow = z.object({
  id: SessionSnapshot.shape.id,
  name: SessionSnapshot.shape.name,
  agent: SessionSnapshot.shape.agent,
  state: SessionSnapshot.shape.state,
  ephemeral: SessionSnapshot.shape.ephemeral,
}).strict();

export const AgentPullRequestRequest = z.object({
  pr: z.string({ error: 'pr must be a string' }).min(1, { error: 'pr must not be empty' }).max(300, { error: 'pr must be at most 300 characters' }),
}).strict();

const AGENT_SETTINGS_COMMANDS = ['list', 'get'] as const;

export const AgentSettingsRequest = z.object({
  command: z.enum(AGENT_SETTINGS_COMMANDS, { error: 'command must be list or get' }),
  path: z.string({ error: 'path must be a string' }).min(1, { error: 'path must not be empty' }).max(200, { error: 'path must be at most 200 characters' }).optional(),
}).strict();

export const AgentSettingsReply = z.union([
  z.object({ ok: z.literal(true), text: z.string(), readout: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);

const PullRequestIdentity = QueuedReview.pick({ key: true, title: true, url: true, author: true });

export const AgentReviewsReply = z.object({
  ok: z.literal(true),
  configured: z.boolean(),
  reason: z.string().nullable(),
  reviewing: z.array(PullRequestIdentity.extend({ phase: InFlightReview.shape.phase })),
  queued: z.array(PullRequestIdentity),
  drafts: z.array(PullRequestIdentity.extend({
    status: ReviewDraft.shape.status,
    verdict: z.string(),
    summary: ReviewDraft.shape.summary,
    comments: z.number().int().nonnegative(),
    isOutOfDate: z.boolean(),
  })),
}).strict();

export const AgentPrsReply = z.object({
  ok: z.literal(true),
  configured: z.boolean(),
  prs: z.array(z.object({
    key: MyPr.shape.key, title: MyPr.shape.title, url: MyPr.shape.url, state: MyPr.shape.state, isDraft: MyPr.shape.isDraft,
    stage: MyPr.shape.stage, reviewDecision: MyPr.shape.reviewDecision, approvals: MyPr.shape.approvals,
    unresolvedThreads: MyPr.shape.unresolvedThreads, behindBy: MyPr.shape.behindBy, mergeable: MyPr.shape.mergeable,
    isInMergeQueue: MyPr.shape.isInMergeQueue, checks: MyPr.shape.checks.pick({ state: true, failing: true }),
  }).strict()),
}).strict();

export const SESSION_DOC_BODY_CAP_BYTES = 256 * 1024;
export const SESSION_DOC_PATH_MAX_CHARS = 4096;
export const SESSION_DOCS_MAX = 20;

export const AgentEditRequest = z.object({
  path: z.string({ error: 'path must be a string' })
    .min(1, { error: 'path must not be empty' })
    .max(SESSION_DOC_PATH_MAX_CHARS, { error: `path must be at most ${SESSION_DOC_PATH_MAX_CHARS} characters` }),
}).strict();

export const SHOWN_FILE_CAP_BYTES = 200 * 1024 * 1024;
export const SHOWN_FILES_KEPT_PER_SESSION = 50;
export const SHOWN_CAPTION_MAX_CHARS = 500;
const SHOWN_FILE_KINDS = ['image', 'video', 'page'] as const;

export const ShownFile = z.object({
  id: z.string(),
  name: z.string(),
  caption: z.string().max(SHOWN_CAPTION_MAX_CHARS).nullable(),
  kind: z.enum(SHOWN_FILE_KINDS),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  pageTitle: z.string().nullable(),
  shownAt: z.number().finite(),
}).strict();

export type ShownFile = z.infer<typeof ShownFile>;
export type ShownFileKind = (typeof SHOWN_FILE_KINDS)[number];

export const SessionDoc = z.object({
  path: z.string(),
  name: z.string(),
  surfacedAt: z.number().finite(),
}).strict();

export type AgentEditRequest = z.infer<typeof AgentEditRequest>;
export type SessionDoc = z.infer<typeof SessionDoc>;

export const SessionLimits = z.object({
  commands: z.array(z.object({
    name: z.enum(SESSION_COMMANDS),
    answers: z.boolean(),
    reason: z.string().optional(),
  }).strict()),
  guarded: z.boolean(),
  boundary: z.enum(['os-sandbox', 'workspace', 'none']),
  environment: z.object({ name: z.string(), workspace: z.string(), state: z.string() }).strict().nullable(),
  deadEnds: z.array(z.object({ blocked: z.string(), route: z.string() }).strict()),
}).strict();

export const AgentLimitsReply = SessionLimits.extend({ ok: z.literal(true) }).strict();

export type AgentSpawnRequest = z.infer<typeof AgentSpawnRequest>;
export type AgentSendRequest = z.infer<typeof AgentSendRequest>;
export type AgentReadRequest = z.infer<typeof AgentReadRequest>;
export type AgentCloseRequest = z.infer<typeof AgentCloseRequest>;
export type AgentAnswerRequest = z.infer<typeof AgentAnswerRequest>;
export type AgentReadReply = z.infer<typeof AgentReadReply>;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];
export type SessionLimits = z.infer<typeof SessionLimits>;
export type AgentLimitsReply = z.infer<typeof AgentLimitsReply>;
export type AgentAttentionRequest = z.infer<typeof AgentAttentionRequest>;
export type AgentAttentionReply = z.infer<typeof AgentAttentionReply>;
export type AgentBoardRow = z.infer<typeof AgentBoardRow>;
export type AgentPullRequestRequest = z.infer<typeof AgentPullRequestRequest>;
export type AgentSettingsRequest = z.infer<typeof AgentSettingsRequest>;
export type AgentSettingsReply = z.infer<typeof AgentSettingsReply>;
export type AgentReviewsReply = z.infer<typeof AgentReviewsReply>;
export type AgentPrsReply = z.infer<typeof AgentPrsReply>;
