import { z } from 'zod';
import { STATES } from '../states.ts';

export const SessionState = z.enum(STATES);
export const PendingWakeup = z.object({
  at: z.number().finite().nullable(),
  kind: z.string(),
  reason: z.string().nullable(),
}).passthrough();

export const SessionSnapshot = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  agent: z.string(),
  state: SessionState,
  stateSince: z.number(),
  sleeping: z.boolean(),
  dangerouslySkipPermissions: z.boolean(),
  ephemeral: z.boolean(),
  isWorktree: z.boolean(),
  resumeSessionId: z.string().nullable(),
  activeAgents: z.number().int().nonnegative(),
  packs: z.array(z.object({ name: z.string(), version: z.string() })),
  pendingWakeup: PendingWakeup.nullable(),
  pendingPromptKind: z.string().nullable(),
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

export const AgentAttentionRequest = z.object({
  note: z.string({ error: 'note must be a string' }).min(1, { error: 'note must not be empty' }).max(500, { error: 'note must be at most 500 characters' }),
}).strict();

export const AgentBoardRow = z.object({
  id: SessionSnapshot.shape.id,
  name: SessionSnapshot.shape.name,
  agent: SessionSnapshot.shape.agent,
  state: SessionSnapshot.shape.state,
  ephemeral: SessionSnapshot.shape.ephemeral,
}).strict();

export type AgentSpawnRequest = z.infer<typeof AgentSpawnRequest>;
export type AgentAttentionRequest = z.infer<typeof AgentAttentionRequest>;
export type AgentBoardRow = z.infer<typeof AgentBoardRow>;
