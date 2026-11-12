import { z } from 'zod';

export const MAX_WAKE_TEXT_CHARS = 2000;
export const MAX_WAKE_WHEN_CHARS = 200;
export const WAKE_KINDS = ['in', 'at', 'cron'] as const;
export const WAKE_STATUSES = ['pending', 'fired', 'missed', 'failed', 'cancelled'] as const;

export const WakeId = z.string({ error: 'the wake must be a string' }).regex(/^w[1-9][0-9]{0,8}$/, { error: 'a wake id looks like w3; glimmervoid wake list shows them' });
export const WakeKind = z.enum(WAKE_KINDS);

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const WakeText = z.string({ error: 'text must be a string' })
  .trim()
  .min(1, { error: 'a wake needs text, the prompt typed into this session when it fires' })
  .max(MAX_WAKE_TEXT_CHARS, { error: `wake text must be at most ${MAX_WAKE_TEXT_CHARS} characters` })
  .refine((text) => !CONTROL_CHARACTER_PATTERN.test(text), { error: 'wake text must be one line with no control characters, because it is typed into the terminal' });

const WakeWhen = z.string({ error: 'when must be a string' })
  .trim()
  .min(1, { error: 'a wake needs a when' })
  .max(MAX_WAKE_WHEN_CHARS, { error: `when must be at most ${MAX_WAKE_WHEN_CHARS} characters` })
  .refine((when) => !CONTROL_CHARACTER_PATTERN.test(when), { error: 'when must be one line with no control characters, because a cron pattern is typed into the terminal' });

export const WakeSchedule = z.union([
  z.strictObject({ kind: z.enum(['in', 'at']), fireAt: z.number().finite() }),
  z.strictObject({ kind: z.literal('cron'), pattern: z.string().min(1).max(MAX_WAKE_WHEN_CHARS), timezone: z.string().min(1).max(100) }),
]);

export const Wake = z.strictObject({
  id: WakeId,
  sessionId: z.string().min(1).max(300),
  schedule: WakeSchedule,
  text: z.string().min(1).max(MAX_WAKE_TEXT_CHARS),
  setAt: z.number().finite(),
  nextFireAt: z.number().finite(),
  status: z.enum(WAKE_STATUSES),
});

export const WakeStoreFile = z.strictObject({
  version: z.literal(1),
  lastWakeNumber: z.number().int().nonnegative(),
  wakes: z.array(Wake),
});

export const AgentWakeRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('in'), when: WakeWhen, text: WakeText }),
  z.strictObject({ sub: z.literal('at'), when: WakeWhen, text: WakeText }),
  z.strictObject({ sub: z.literal('cron'), when: WakeWhen, text: WakeText }),
  z.strictObject({ sub: z.literal('list') }),
  z.strictObject({ sub: z.literal('cancel'), wake: WakeId }),
], { error: 'wake takes in, at, cron, list or cancel' });

export const WakeView = z.strictObject({
  id: WakeId,
  kind: WakeKind,
  pattern: z.string().nullable(),
  text: z.string(),
  nextFireAt: z.number().finite(),
  nextFire: z.string(),
});

export const AgentWakeReply = z.union([
  z.strictObject({ ok: z.literal(true), wake: WakeView, timezone: z.string(), note: z.string() }),
  z.strictObject({ ok: z.literal(true), wakes: z.array(WakeView), timezone: z.string() }),
  z.strictObject({ ok: z.literal(true), cancelled: WakeId }),
]);

export type Wake = z.infer<typeof Wake>;
export type WakeKind = z.infer<typeof WakeKind>;
export type WakeSchedule = z.infer<typeof WakeSchedule>;
export type WakeStoreFile = z.infer<typeof WakeStoreFile>;
export type WakeView = z.infer<typeof WakeView>;
export type AgentWakeRequest = z.infer<typeof AgentWakeRequest>;
export type AgentWakeReply = z.infer<typeof AgentWakeReply>;
