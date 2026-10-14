import { z } from 'zod';
import { STATES } from '../states.ts';
import { TOOL_DETAIL_MAX_CHARS } from '../tool-detail.ts';

export const TASK_TITLE_MAX_LENGTH = 120;
export const TASK_TITLE_CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const PROMPT_DETAIL_HIDDEN_CHARACTERS = new RegExp(`${TASK_TITLE_CONTROL_CHARACTERS.source}|[\\p{Cf}\\u2028\\u2029]`, 'u');
export const TaskTitle = z.string().refine((title) => !TASK_TITLE_CONTROL_CHARACTERS.test(title)).trim().max(TASK_TITLE_MAX_LENGTH);
export const RefinedTaskTitle = z.object({ title: z.string().nullable() }).strict();
export const SessionState = z.enum(STATES);
export const PendingWakeup = z.object({
  at: z.number().finite().nullable(),
  kind: z.string(),
  reason: z.string().nullable(),
}).passthrough();

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const PROMPT_QUESTION_MAX_CHARS = 300;
export const PROMPT_QUESTION_OPTION_MAX_CHARS = 80;
export const PROMPT_QUESTION_MAX_OPTIONS = 8;

const hasNoHiddenCharacters = (text: string) => !PROMPT_DETAIL_HIDDEN_CHARACTERS.test(text);

export const PendingPromptQuestion = z.object({
  text: z.string().min(1).max(PROMPT_QUESTION_MAX_CHARS).refine(hasNoHiddenCharacters),
  options: z.array(z.string().min(1).max(PROMPT_QUESTION_OPTION_MAX_CHARS).refine(hasNoHiddenCharacters)).min(1).max(PROMPT_QUESTION_MAX_OPTIONS),
  multiSelect: z.boolean(),
});

export const PendingPromptDetail = z.object({
  toolName: z.string().max(TOOL_DETAIL_MAX_CHARS),
  summary: z.string().max(TOOL_DETAIL_MAX_CHARS),
  isComplete: z.boolean(),
  question: PendingPromptQuestion.nullable().optional(),
});

export const SessionSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  taskTitle: TaskTitle.nullable().default(null),
  taskTitleIsCustom: z.boolean().default(false),
  path: z.string(),
  agent: z.string(),
  state: SessionState,
  stateSince: z.number(),
  sleeping: z.boolean(),
  dangerouslySkipPermissions: z.boolean(),
  saneYolo: z.boolean().default(false),
  ephemeral: z.boolean(),
  isWorktree: z.boolean(),
  isWorkspace: z.boolean().default(false),
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  awaitingBackgroundTasks: z.boolean(),
  isCompacting: z.boolean().default(false),
  hasEndedTurn: z.boolean().default(false),
  pendingWakeup: PendingWakeup.nullable(),
  pendingPromptKind: z.string().nullable(),
  pendingPromptDetail: PendingPromptDetail.nullable().default(null),
  hasPlan: z.boolean().default(false),
  mergeStatus: z.string().nullable(),
  mergeReason: z.string().nullable(),
  worktreeNotice: z.string().nullable(),
  effectiveBase: z.string().nullable(),
  auditLog: z.array(z.unknown()),
}).passthrough();

export type SessionState = z.infer<typeof SessionState>;
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;
export type PendingWakeup = z.infer<typeof PendingWakeup>;
export type PendingPromptDetail = z.infer<typeof PendingPromptDetail>;
export type PendingPromptQuestion = z.infer<typeof PendingPromptQuestion>;

export function isSamePromptQuestion(left: PendingPromptQuestion | null | undefined, right: PendingPromptQuestion | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.text === right.text
    && left.multiSelect === right.multiSelect
    && left.options.length === right.options.length
    && left.options.every((option, index) => option === right.options[index]);
}

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
export const AGENT_API_VERBS = ['spawn', 'attention', 'board', 'dispatch', 'reopen', 'cancel', 'push', 'edit', 'limits'] as const;
export type AgentApiVerb = (typeof AGENT_API_VERBS)[number];
export const ORCHESTRATOR_AGENT_VERBS = ['dispatch', 'reopen', 'cancel'] as const satisfies readonly AgentApiVerb[];
export type OrchestratorAgentVerb = (typeof ORCHESTRATOR_AGENT_VERBS)[number];
export type TicketAgentVerb = Exclude<OrchestratorAgentVerb, 'dispatch'>;

export const AgentSpawnRequest = z.object({
  prompt: z.string({ error: 'prompt must be a string' })
    .min(1, { error: 'prompt must not be empty' })
    .max(20000, { error: 'prompt must be at most 20000 characters' })
    .refine((prompt) => !prompt.trimStart().startsWith('-'), { message: 'prompt must not start with a dash, which the agent CLI would read as an option' }),
  name: z.string({ error: 'name must be a string' }).min(1, { error: 'name must not be empty' }).max(200, { error: 'name must be at most 200 characters' }).optional(),
  agent: z.string({ error: 'agent must be a string' }).min(1, { error: 'agent must not be empty' }).max(40, { error: 'agent must be at most 40 characters' }).optional(),
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

export const SESSION_DOC_BODY_CAP_BYTES = 256 * 1024;
export const SESSION_DOC_PATH_MAX_CHARS = 4096;
export const SESSION_DOCS_MAX = 20;

export const AgentEditRequest = z.object({
  path: z.string({ error: 'path must be a string' })
    .min(1, { error: 'path must not be empty' })
    .max(SESSION_DOC_PATH_MAX_CHARS, { error: `path must be at most ${SESSION_DOC_PATH_MAX_CHARS} characters` }),
}).strict();

export const SessionDoc = z.object({
  path: z.string(),
  name: z.string(),
  surfacedAt: z.number().finite(),
}).strict();

export type AgentEditRequest = z.infer<typeof AgentEditRequest>;
export type SessionDoc = z.infer<typeof SessionDoc>;

export const SESSION_COMMANDS = ['push', 'spawn', 'attention', 'board', 'edit'] as const;

export const SessionLimits = z.object({
  commands: z.array(z.object({
    name: z.enum(SESSION_COMMANDS),
    answers: z.boolean(),
    reason: z.string().optional(),
  }).strict()),
  sandboxed: z.boolean(),
  deadEnds: z.array(z.object({ blocked: z.string(), route: z.string() }).strict()),
}).strict();

export const AgentLimitsReply = SessionLimits.extend({ ok: z.literal(true) }).strict();

export type AgentSpawnRequest = z.infer<typeof AgentSpawnRequest>;
export type SessionCommand = (typeof SESSION_COMMANDS)[number];
export type SessionLimits = z.infer<typeof SessionLimits>;
export type AgentLimitsReply = z.infer<typeof AgentLimitsReply>;
export type AgentAttentionRequest = z.infer<typeof AgentAttentionRequest>;
export type AgentAttentionReply = z.infer<typeof AgentAttentionReply>;
export type AgentBoardRow = z.infer<typeof AgentBoardRow>;

export const AgentDispatchRequest = z.object({
  workId: z.string().regex(/^wrk-[0-9a-f]{16}$/).optional(),
  readyIntent: z.string().regex(/^wrk-[0-9a-f]{16}$/).optional(),
}).strict().refine((request) => Boolean(request.workId) !== Boolean(request.readyIntent), 'Expected exactly one work id or ready intent');
export type AgentDispatchRequest = z.infer<typeof AgentDispatchRequest>;

export const AgentTicketRequest = z.object({
  workId: z.string({ error: 'workId must be a string' }).regex(/^wrk-[0-9a-f]{16}$/, { error: 'workId must match wrk-[0-9a-f]{16}' }),
}).strict();
export type AgentTicketRequest = z.infer<typeof AgentTicketRequest>;

export const AgentTicketReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), workId: z.string(), state: z.enum(['open', 'cancelled']) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type AgentTicketReply = z.infer<typeof AgentTicketReply>;
