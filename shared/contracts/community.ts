import { z } from 'zod';
import { PACK_ID_PATTERN } from './pack-bridge.ts';

export const CommunitySource = z.string().regex(new RegExp(`^${PACK_ID_PATTERN}:${PACK_ID_PATTERN}$`), { error: 'a community source id is <pack>:<source>' });
export type CommunitySource = z.infer<typeof CommunitySource>;

export const CommunityVerdict = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type CommunityVerdict = z.infer<typeof CommunityVerdict>;

const COMMUNITY_ITEM_KEY_RE = new RegExp(`^${PACK_ID_PATTERN}:${PACK_ID_PATTERN}:[A-Za-z0-9_-]{1,128}$`);
const COMMUNITY_SOURCE_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const DISCORD_CHANNEL_NAME_RE = /^[a-z0-9_-]{1,100}$/;

export const SKILL_NAME_RE = /^[A-Za-z0-9:._-]{1,100}$/;

export const CommunityItem = z.strictObject({
  key: z.string().regex(COMMUNITY_ITEM_KEY_RE),
  source: CommunitySource,
  title: z.string().max(300),
  body: z.string().max(20000),
  url: z.url(),
  author: z.string().max(100),
  channel: z.string().regex(DISCORD_CHANNEL_NAME_RE).nullable(),
  tags: z.array(z.string().max(100)).max(20).default([]),
  createdAt: z.string(),
  resolved: z.boolean().default(false),
});
export type CommunityItem = z.infer<typeof CommunityItem>;

export const CommunityDraft = z.strictObject({
  body: z.string().max(8000),
  publicLinks: z.array(z.url()).max(20),
});
export type CommunityDraft = z.infer<typeof CommunityDraft>;

const CommunityRunStatus = z.enum(['queued', 'running', 'ready', 'error', 'aside']);

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
  retriedAfterTimeout: z.boolean().optional(),
  seenAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CommunityStateEntry = z.infer<typeof CommunityStateEntry>;

const CommunityWatermarks = z.record(CommunitySource, z.string().nullable());

export const CommunityState = z.strictObject({
  watermarks: CommunityWatermarks,
  entries: z.record(z.string().regex(COMMUNITY_ITEM_KEY_RE), CommunityStateEntry),
});
export type CommunityState = z.infer<typeof CommunityState>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'a color is #rrggbb' });
const CommunitySourceColor = z.strictObject({ dark: HexColor, light: HexColor });

export const CommunitySourceView = z.strictObject({
  id: CommunitySource,
  label: z.string(),
  iconUrl: z.string().nullable(),
  color: CommunitySourceColor,
  error: z.string().nullable(),
  waitingFor: z.array(z.string()),
});
export type CommunitySourceView = z.infer<typeof CommunitySourceView>;

function channelNameOf(printed: string | null): string | null {
  if (printed === null) return null;
  const channel = printed.trim().toLowerCase().replace(/^[^a-z0-9]+/, '');
  return DISCORD_CHANNEL_NAME_RE.test(channel) ? channel : null;
}

export const CommunitySourceItem = z.object({
  id: z.string().regex(COMMUNITY_SOURCE_ITEM_ID_RE),
  title: z.string().transform((title) => title.slice(0, 300)),
  body: z.string().transform((body) => body.slice(0, 20000)),
  url: z.httpUrl().max(2000).transform((url) => new URL(url).href),
  author: z.string().default('').transform((author) => author.trim().slice(0, 100) || 'unknown'),
  channel: z.string().nullable().default(null).transform(channelNameOf),
  tags: z.array(z.string()).default([]).transform((tags) => tags.map((tag) => tag.trim().slice(0, 100)).filter((tag) => tag !== '').slice(0, 20)),
  createdAt: z.iso.datetime({ offset: true }),
  resolved: z.boolean().default(false),
});

export const CommunitySourceOutput = z.object({
  items: z.array(z.unknown()).max(200),
}).describe('What a community source command prints on stdout; each item is read on its own as a CommunitySourceItem');
export type CommunitySourceOutput = z.infer<typeof CommunitySourceOutput>;

export const CommunityStatus = z.object({
  type: z.literal('community-status'),
  ts: z.number().finite(),
  configured: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  error: z.string().nullable().optional(),
  entries: z.array(CommunityStateEntry),
  sources: z.array(z.lazy(() => CommunitySourceView)).default([]),
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
