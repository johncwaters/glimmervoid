import { z } from 'zod';

import { STATES } from '../states.ts';
import { LinkedPr, MyPr } from './my-prs.ts';
import { AgentAccountId } from './agent-accounts.ts';
import { QUESTION_ANSWERED_NOTIFY_CATEGORY } from './question-manager.ts';
import { AgentNeedReply, AgentSecretsEnvReply } from './secrets.ts';
import { AgentArenaReply } from './race.ts';
import { AgentWakeReply } from './wakes.ts';
import { InFlightReview, QueuedReview, ReviewDraft } from './team-review.ts';
import { REVIEW_TEXT_MAX_CHARS, ReviewCommentId } from './review-state.ts';
import { WhiteboardAgentReply } from './whiteboard.ts';

export const MergeStatus = z.enum(['none', 'pending-review', 'merging', 'parked', 'merged']);
export type MergeStatus = z.infer<typeof MergeStatus>;

export const TASK_TITLE_MAX_LENGTH = 120;
export const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_\-. ()]{1,64}$/;
export const SESSION_NAME_RULE_TEXT = 'Session name may only contain letters, numbers, spaces, dashes, dots, underscores, and parentheses (max 64 chars)';
export const TASK_TITLE_CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const TaskTitle = z.string().refine((title) => !TASK_TITLE_CONTROL_CHARACTERS.test(title)).trim().max(TASK_TITLE_MAX_LENGTH);
export const RefinedTaskTitle = z.object({ title: z.string().nullable(), name: z.string().nullable().optional() }).strict();
export const SessionState = z.enum(STATES);
export const UnseenOutcome = z.enum(['finished', 'failed']);

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

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
});
export const CoherenceHooksState = z.discriminatedUnion('active', [
  z.object({ active: z.literal(true) }).strict(),
  z.object({ active: z.literal(false), reason: z.string().min(1).max(COHERENCE_HOOKS_REASON_MAX_CHARS), version: z.string().optional() }).strict(),
]);

export const ATTENTION_NOTE_MAX_CHARS = 500;
const ATTENTION_QUESTION_ORIGINS = ['agent', 'secret'] as const;
const ATTENTION_NOTE_ORIGINS = ['coherence-hooks', 'coherence-verdict', 'coherence-spec', 'coherence-error', 'child-wake-cap', 'self-wake-cap', 'wake-failed', 'child-kept'] as const;
export const AttentionOrigin = z.enum([...ATTENTION_QUESTION_ORIGINS, ...ATTENTION_NOTE_ORIGINS]);
export const AttentionNoteOrigin = z.enum(ATTENTION_NOTE_ORIGINS);
export const AttentionNote = z.object({ origin: AttentionNoteOrigin, note: z.string().max(ATTENTION_NOTE_MAX_CHARS), at: z.number() }).strict();
export const ATTENTION_NOTE_NOTIFY_CATEGORY = 'note';
export const QUIET_NOTIFY_CATEGORIES: ReadonlySet<string> = new Set([QUESTION_ANSWERED_NOTIFY_CATEGORY, ATTENTION_NOTE_NOTIFY_CATEGORY]);
export type AttentionOrigin = z.infer<typeof AttentionOrigin>;
export type AttentionNoteOrigin = z.infer<typeof AttentionNoteOrigin>;
export type AttentionNote = z.infer<typeof AttentionNote>;

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
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  awaitingBackgroundTasks: z.boolean(),
  pendingPromptKind: z.string().nullable(),
  mergeStatus: MergeStatus.nullable(),
  mergeReason: z.string().nullable(),
  worktreeNotice: z.string().nullable(),
  failureReason: z.string().nullable().optional(),
  unseenOutcome: UnseenOutcome.nullable().default(null),
  managerSeenSeq: z.number().int().nonnegative().default(0),
  isQuestionManagerOn: z.boolean().nullable().default(null),
  accountId: AgentAccountId.nullable().default(null),
  effectiveBase: z.string().nullable(),
  linkedPrs: z.array(LinkedPr).default([]),
  coherenceHooks: CoherenceHooksState.nullable().default(null),
  attentionNotes: z.array(AttentionNote).default([]),
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

export const GIT_CREDENTIAL_URL_ENV = 'GLIMMERVOID_GIT_CREDENTIAL_URL';
export const GIT_CREDENTIAL_PATH_PREFIX = '/git-credential/';
export const GIT_CREDENTIAL_BODY_CAP_BYTES = 16 * 1024;

export const GitCredentialRequest = z.strictObject({
  protocol: z.string().max(40),
  host: z.string().max(255),
});

export const GitCredentialReply = z.union([
  z.strictObject({ found: z.literal(true), username: z.string().min(1), password: z.string().min(1), passwordExpiryUtc: z.number().int().positive() }),
  z.strictObject({ found: z.literal(false) }),
]);

export type GitCredentialRequest = z.infer<typeof GitCredentialRequest>;
export type GitCredentialReply = z.infer<typeof GitCredentialReply>;
const CLI_SESSION_COMMANDS = ['push', 'spawn', 'send', 'read', 'close', 'attention', 'sessions', 'edit', 'review', 'reviews', 'prs', 'link-pr', 'settings', 'why', 'whiteboard', 'checkout', 'packs', 'need', 'secrets', 'arena', 'comments', 'wake'] as const;
export const SESSION_COMMANDS = [...CLI_SESSION_COMMANDS, 'show'] as const;
export const AGENT_API_VERBS = [...CLI_SESSION_COMMANDS, 'limits', 'answer'] as const;
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
  note: z.string({ error: 'note must be a string' }).min(1, { error: 'note must not be empty' }).max(ATTENTION_NOTE_MAX_CHARS, { error: `note must be at most ${ATTENTION_NOTE_MAX_CHARS} characters` }),
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

export const AgentReviewsRequest = z.object({
  pr: AgentPullRequestRequest.shape.pr.optional(),
}).strict();

const AGENT_SETTINGS_COMMANDS = ['list', 'get'] as const;

export const AgentSettingsRequest = z.object({
  command: z.enum(AGENT_SETTINGS_COMMANDS, { error: 'command must be list or get' }),
  path: z.string({ error: 'path must be a string' }).min(1, { error: 'path must not be empty' }).max(200, { error: 'path must be at most 200 characters' }).optional(),
}).strict();

const AGENT_PACKS_COMMANDS = ['guide', 'check', 'list', 'install', 'preview', 'status', 'request-approval', 'remove', 'add', 'update'] as const;
const PACK_FOLDER_COMMANDS: readonly string[] = ['check', 'install', 'preview'];
const PACK_NAME_COMMANDS: readonly string[] = ['status', 'request-approval', 'remove'];

export const AgentPacksRequest = z.object({
  command: z.enum(AGENT_PACKS_COMMANDS, { error: `command must be one of ${AGENT_PACKS_COMMANDS.join(', ')}` }),
  path: z.string({ error: 'path must be a string' }).min(1, { error: 'path must not be empty' }).max(4096, { error: 'path must be at most 4096 characters' }).optional(),
  name: z.string({ error: 'name must be a string' }).min(1, { error: 'name must not be empty' }).max(40, { error: 'a pack name is at most 40 characters' }).optional(),
  url: z.string({ error: 'url must be a string' }).min(1, { error: 'url must not be empty' }).max(500, { error: 'url must be at most 500 characters' }).optional(),
}).strict()
  .refine((request) => !PACK_FOLDER_COMMANDS.includes(request.command) || request.path !== undefined, { error: 'check, install and preview need the path of a pack folder' })
  .refine((request) => !PACK_NAME_COMMANDS.includes(request.command) || request.name !== undefined, { error: 'status, request-approval and remove need the name of a pack' })
  .refine((request) => request.command !== 'add' || request.url !== undefined, { error: 'add needs the https URL of a git repository' });

const AGENT_COMMENTS_COMMANDS = ['list', 'reply', 'resolve'] as const;

export const AgentCommentsRequest = z.object({
  command: z.enum(AGENT_COMMENTS_COMMANDS, { error: 'command must be list, reply or resolve' }),
  commentId: ReviewCommentId.optional(),
  text: z.string({ error: 'text must be a string' }).trim().min(1, { error: 'text must not be empty' }).max(REVIEW_TEXT_MAX_CHARS, { error: `text must be at most ${REVIEW_TEXT_MAX_CHARS} characters` }).optional(),
}).strict()
  .refine((request) => request.command === 'list' || request.commentId !== undefined, { error: 'reply and resolve need the comment id, for example c-0123abcd' })
  .refine((request) => request.command !== 'reply' || request.text !== undefined, { error: 'reply needs the text of the answer' });

const AgentReviewCommentRow = z.object({ id: z.string(), path: z.string(), line: z.number(), side: z.enum(['old', 'new']), text: z.string() }).strict();

export const AgentWhyRequest = z.object({
  target: z.string({ error: 'target must be a string' }).min(1, { error: 'target must not be empty' }).max(4200, { error: 'target must be at most 4200 characters' }),
}).strict();

export const AgentCheckoutRequest = z.object({
  repo: z.string({ error: 'repo must be a string' }).min(1, { error: 'repo must not be empty' }).max(4096, { error: 'repo must be at most 4096 characters' }),
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

export const AgentReviewDetailReply = z.object({
  ok: z.literal(true),
  key: z.string(),
  state: z.enum(['drafted', 'reviewing', 'queued']),
  phase: InFlightReview.shape.phase.nullable(),
  note: z.string().nullable(),
  draft: ReviewDraft.nullable(),
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
}).strict();

export const AgentLimitsReply = SessionLimits.extend({ ok: z.literal(true) }).strict();

export const AgentRefusal = z.object({ ok: z.literal(false), error: z.string(), reason: z.string().optional() }).strict();

const AgentOkReply = z.object({ ok: z.literal(true) }).strict();

export const AGENT_REPLY_SCHEMAS = Object.freeze({
  push: z.union([z.object({ ok: z.literal(true), landedOn: z.string().nullable(), pushed: z.boolean(), note: z.string().optional() }).strict(), AgentRefusal]),
  spawn: z.union([z.object({ ok: z.literal(true), sessionId: z.string(), name: z.string(), note: z.string() }).strict(), AgentRefusal]),
  send: z.union([AgentOkReply, AgentRefusal]),
  read: z.union([AgentReadReply, AgentRefusal]),
  close: z.union([z.object({ ok: z.literal(true), closed: z.string() }).strict(), AgentRefusal]),
  attention: z.union([AgentAttentionReply, AgentRefusal]),
  sessions: z.union([z.object({ ok: z.literal(true), sessions: z.array(AgentBoardRow) }).strict(), AgentRefusal]),
  edit: z.union([z.object({ ok: z.literal(true), path: z.string(), name: z.string() }).strict(), AgentRefusal]),
  review: z.union([z.object({ ok: z.literal(true), key: z.string(), status: z.enum(['queued', 'running']), note: z.string() }).strict(), AgentRefusal]),
  reviews: z.union([AgentReviewsReply, AgentReviewDetailReply, AgentRefusal]),
  prs: z.union([AgentPrsReply, AgentRefusal]),
  'link-pr': z.union([z.object({ ok: z.literal(true), key: z.string(), url: z.string() }).strict(), AgentRefusal]),
  settings: z.union([AgentSettingsReply, AgentRefusal]),
  why: z.union([z.object({ ok: z.literal(true), text: z.string() }).strict(), AgentRefusal]),
  whiteboard: z.union([WhiteboardAgentReply, AgentRefusal]),
  checkout: z.union([z.object({ ok: z.literal(true), path: z.string(), branch: z.string() }).strict(), AgentRefusal]),
  packs: z.union([z.object({ ok: z.literal(true), text: z.string(), hasProblem: z.boolean() }).strict(), AgentRefusal]),
  need: z.union([AgentNeedReply, AgentRefusal]),
  secrets: z.union([AgentSecretsEnvReply, AgentRefusal]),
  limits: z.union([AgentLimitsReply, AgentRefusal]),
  answer: z.union([AgentOkReply, AgentRefusal]),
  arena: z.union([AgentArenaReply, AgentRefusal]),
  comments: z.union([z.object({ ok: z.literal(true), comments: z.array(AgentReviewCommentRow) }).strict(), AgentOkReply, AgentRefusal]),
  wake: z.union([AgentWakeReply, AgentRefusal]),
}) satisfies { readonly [V in AgentApiVerb]: z.ZodType };

export type AgentRefusal = z.infer<typeof AgentRefusal>;
export type AgentReplyBodyOf<V extends AgentApiVerb> = z.infer<(typeof AGENT_REPLY_SCHEMAS)[V]>;

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
export type AgentPacksRequest = z.infer<typeof AgentPacksRequest>;
export type AgentWhyRequest = z.infer<typeof AgentWhyRequest>;
export type AgentCommentsRequest = z.infer<typeof AgentCommentsRequest>;
export type AgentCheckoutRequest = z.infer<typeof AgentCheckoutRequest>;
export type AgentSettingsReply = z.infer<typeof AgentSettingsReply>;
export type AgentReviewsRequest = z.infer<typeof AgentReviewsRequest>;
export type AgentReviewsReply = z.infer<typeof AgentReviewsReply>;
export type AgentReviewDetailReply = z.infer<typeof AgentReviewDetailReply>;
export type AgentPrsReply = z.infer<typeof AgentPrsReply>;
