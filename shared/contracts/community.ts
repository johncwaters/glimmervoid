import { z } from 'zod';

export const CommunitySource = z.enum(['forum', 'discord']);
export type CommunitySource = z.infer<typeof CommunitySource>;

export const CommunityVerdict = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type CommunityVerdict = z.infer<typeof CommunityVerdict>;

export const COMMUNITY_ITEM_KEY_RE = /^(forum|discord):[A-Za-z0-9_-]{1,128}$/;

export const CommunityItem = z.strictObject({
  key: z.string().regex(COMMUNITY_ITEM_KEY_RE),
  source: CommunitySource,
  title: z.string().max(300),
  body: z.string().max(20000),
  url: z.url(),
  author: z.string().max(100),
  channel: z.string().max(100).nullable(),
  createdAt: z.string(),
});
export type CommunityItem = z.infer<typeof CommunityItem>;

export const CommunityDraft = z.strictObject({
  body: z.string().max(8000),
  publicLinks: z.array(z.url()).max(20),
});
export type CommunityDraft = z.infer<typeof CommunityDraft>;

export const CommunityRunStatus = z.enum(['queued', 'running', 'ready', 'error', 'aside']);
export type CommunityRunStatus = z.infer<typeof CommunityRunStatus>;

export const CommunityStateEntry = z.strictObject({
  item: CommunityItem,
  status: CommunityRunStatus,
  verdict: CommunityVerdict.nullable(),
  summary: z.string(),
  goal: z.string(),
  checked: z.array(z.string()),
  gaps: z.array(z.string()),
  draft: CommunityDraft.nullable(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  seenAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CommunityStateEntry = z.infer<typeof CommunityStateEntry>;

export const CommunityWatermarks = z.strictObject({
  forum: z.string().nullable(),
  discord: z.string().nullable(),
});
export type CommunityWatermarks = z.infer<typeof CommunityWatermarks>;

export const CommunityState = z.strictObject({
  watermarks: CommunityWatermarks,
  entries: z.record(z.string().regex(COMMUNITY_ITEM_KEY_RE), CommunityStateEntry),
});
export type CommunityState = z.infer<typeof CommunityState>;

export const CommunityStatus = z.object({
  type: z.literal('community-status'),
  ts: z.number().finite(),
  configured: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  error: z.string().nullable().optional(),
  entries: z.array(CommunityStateEntry),
}).passthrough();
export type CommunityStatus = z.infer<typeof CommunityStatus>;

export const CommunityAction = z.enum(['rerun', 'set-aside']);
export type CommunityAction = z.infer<typeof CommunityAction>;

export const CommunityItemKey = z.string().regex(COMMUNITY_ITEM_KEY_RE);

export const CommunityActionRequest = z.object({
  key: CommunityItemKey,
  action: CommunityAction,
});
export type CommunityActionRequest = z.infer<typeof CommunityActionRequest>;

export const CommunityActionResult = z.object({
  key: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type CommunityActionResult = z.infer<typeof CommunityActionResult>;
