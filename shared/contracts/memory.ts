import { z } from 'zod';

export const MEMORY_KEY_MAX_CHARS = 80;
const MEMORY_TEXT_MAX_CHARS = 8000;
export const MEMORY_MAX_ENTRIES_PER_PROJECT = 200;

export const MemoryText = z.string({ error: 'text must be a string' })
  .min(1, { error: 'text must not be empty' })
  .max(MEMORY_TEXT_MAX_CHARS, {
    error: (issue) => (typeof issue.input === 'string'
      ? `text is ${issue.input.length} characters, limit is ${MEMORY_TEXT_MAX_CHARS}`
      : `text must be at most ${MEMORY_TEXT_MAX_CHARS} characters`),
  });

const MemoryKey = z.string({ error: 'key must be a string' })
  .min(1, { error: 'key must not be empty' })
  .max(MEMORY_KEY_MAX_CHARS, { error: `key must be at most ${MEMORY_KEY_MAX_CHARS} characters` })
  .regex(/^[a-z0-9][a-z0-9._-]*$/, { error: 'key uses lowercase letters, digits and . _ -, starting with a letter or digit' });

export const MemoryEntry = z.strictObject({
  key: MemoryKey,
  projectPath: z.string().min(1),
  text: z.string(),
  updatedBy: z.string(),
  updatedAt: z.number().int().nonnegative(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryStoreFile = z.strictObject({
  version: z.literal(1),
  entries: z.array(MemoryEntry),
});
export type MemoryStoreFile = z.infer<typeof MemoryStoreFile>;

const AGENT_RULES_MAX_COUNT = 40;
const AGENT_RULE_MAX_CHARS = 500;

export const AgentRulesBlock = z.object({
  rules: z.array(z.string({ error: 'agentRules.rules must be an array of strings' }).max(AGENT_RULE_MAX_CHARS, { error: `each agentRules.rules entry must be at most ${AGENT_RULE_MAX_CHARS} characters` }), { error: 'agentRules.rules must be an array of strings' })
    .max(AGENT_RULES_MAX_COUNT, { error: `agentRules.rules holds at most ${AGENT_RULES_MAX_COUNT} rules` }).optional(),
});

export const AgentMemoryRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('list') }),
  z.strictObject({ sub: z.literal('read'), key: MemoryKey }),
  z.strictObject({
    sub: z.literal('write'),
    key: MemoryKey,
    text: MemoryText,
  }),
  z.strictObject({ sub: z.literal('forget'), key: MemoryKey }),
], { error: 'memory takes list, read, write or forget' });
export type AgentMemoryRequest = z.infer<typeof AgentMemoryRequest>;

const MemoryView = z.strictObject({ key: z.string(), text: z.string(), updatedBy: z.string(), updatedAt: z.number() });

export const AgentMemoryReply = z.union([
  z.strictObject({ ok: z.literal(true), entries: z.array(MemoryView.omit({ text: true })), note: z.string() }),
  z.strictObject({ ok: z.literal(true), entry: MemoryView, note: z.string() }),
  z.strictObject({ ok: z.literal(true), written: z.string() }),
  z.strictObject({ ok: z.literal(true), forgotten: z.string() }),
]);
export type AgentMemoryReply = z.infer<typeof AgentMemoryReply>;
