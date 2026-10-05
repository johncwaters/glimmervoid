import { z } from 'zod';
import { STATES } from '../states.ts';
import { TOOL_DETAIL_MAX_CHARS } from '../tool-detail.ts';

export const TASK_TITLE_MAX_LENGTH = 120;
export const TASK_TITLE_CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;
export const PROMPT_DETAIL_HIDDEN_CHARACTERS = new RegExp(`${TASK_TITLE_CONTROL_CHARACTERS.source}|[\\p{Cf}\\u2028\\u2029]`, 'u');
export const TaskTitle = z.string().refine((title) => !TASK_TITLE_CONTROL_CHARACTERS.test(title)).trim().max(TASK_TITLE_MAX_LENGTH);
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
  ephemeral: z.boolean(),
  isWorktree: z.boolean(),
  isWorkspace: z.boolean().default(false),
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  awaitingBackgroundTasks: z.boolean(),
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
export const AGENT_API_VERBS = ['spawn', 'attention', 'board'] as const;
export type AgentApiVerb = (typeof AGENT_API_VERBS)[number];

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

export type AgentSpawnRequest = z.infer<typeof AgentSpawnRequest>;
export type AgentAttentionRequest = z.infer<typeof AgentAttentionRequest>;
export type AgentAttentionReply = z.infer<typeof AgentAttentionReply>;
export type AgentBoardRow = z.infer<typeof AgentBoardRow>;
