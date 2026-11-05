import { z } from 'zod';
import { STATES } from '../states.ts';
import { ReviewsSnapshot } from './reviews.ts';

export const PACK_BRIDGE_VERSION = 1;

export const PackBridgeTopic = z.enum(['sessions', 'focus', 'theme', 'usage', 'attention', 'reviews']);
export type PackBridgeTopic = z.infer<typeof PackBridgeTopic>;

const BridgeVersion = z.literal(PACK_BRIDGE_VERSION);

const BridgePlanWindow = z.strictObject({
  pct: z.number().nullable().describe('Percent of the window used, 0 to 100; 100 or more means the limit is reached; null when the agent did not report it'),
  resetsAtMs: z.number().nullable().describe('When the window resets, as Unix epoch milliseconds; null when the agent did not report it'),
}).nullable().describe('null when the agent reported nothing for this window');

const PACK_BRIDGE_TOPIC_DATA = {
  sessions: z.strictObject({
    sessions: z.array(z.strictObject({
      id: z.string(), name: z.string(), agent: z.string().nullable(),
      state: z.string().describe(`One of ${Object.values(STATES).join(', ')}; the theme color for a state is --state-<state in lowercase>, and DORMANT has none`),
      stateSinceMs: z.number().describe('When the session entered its state, as Unix epoch milliseconds'),
      taskTitle: z.string().nullable(),
    })),
  }),
  focus: z.strictObject({ sessionId: z.string().nullable(), view: z.string(), isStreamerMode: z.boolean().describe('The operator is screen sharing: session names and task titles arrive masked; reviews arrive in full') }),
  theme: z.strictObject({
    id: z.string().nullable().describe("The active theme's id; a pack theme's id is <pack name>/<theme id>"),
    colors: z.record(z.string(), z.string()).describe('CSS custom properties to set on the root element, keyed with their leading --: one per theme chrome key (--bg, --bg-card, --bg-header, --bg-surface, --border, --border-dim, --border-hover, --text, --text-dim, --text-head, --text-muted, --accent, --accent-dim) and per session state (--state-<state>, a hex color, and --state-<state>-bg, a translucent color-mix tint of it)'),
  }),
  usage: z.strictObject({
    planLimits: z.array(z.strictObject({ vendor: z.enum(['claude', 'codex', 'kimi']), fiveHour: BridgePlanWindow, sevenDay: BridgePlanWindow })).describe('One entry per agent that has reported plan limits; an agent that has not is absent'),
  }),
  attention: z.strictObject({ waiting: z.number(), finished: z.number(), failed: z.number() }),
  reviews: ReviewsSnapshot,
} satisfies Record<PackBridgeTopic, z.ZodType>;

export type PackBridgeTopicData = { [Topic in PackBridgeTopic]: z.infer<(typeof PACK_BRIDGE_TOPIC_DATA)[Topic]> };

export const PackName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'a pack name is lowercase letters, digits and dashes, at most 40 characters' });

export const PACK_DATA_MAX_BYTES = 64 * 1024;

export const PACK_STORE_MAX_DEPTH = 32;

function isShallowJsonValue(root: unknown): boolean {
  const pending: [unknown, number][] = [[root, 0]];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [value, depth] = entry;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object' || depth >= PACK_STORE_MAX_DEPTH) return false;
    const isPlainObject = Object.getPrototypeOf(value) === Object.prototype;
    if (!Array.isArray(value) && !isPlainObject) return false;
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  return true;
}

export const PackStoreKey = z.string().min(1).max(128);
export const PackStoreValue = z.unknown().refine(isShallowJsonValue, { error: `a JSON value nested at most ${PACK_STORE_MAX_DEPTH} levels deep` });
export const PackStoreData = z.record(PackStoreKey, z.unknown().describe('A JSON value a panel saved')).describe(`The pack's saved keys and values, shared by all its panels and kept across reloads, browsers and pack updates; at most ${PACK_DATA_MAX_BYTES} bytes as JSON, deleted when the pack folder is removed`);
export type PackStoreData = z.infer<typeof PackStoreData>;

export function packStoreAfterSet(data: PackStoreData, key: string, value: unknown): PackStoreData {
  return Object.fromEntries([...Object.entries(data).filter(([existingKey]) => existingKey !== key), ...(value === null ? [] : [[key, value] as const])]);
}

function packStoreText(data: PackStoreData): string {
  return `${JSON.stringify(data)}\n`;
}

export function packStoreSizeError(packName: string, data: PackStoreData): string | null {
  const byteCount = new TextEncoder().encode(packStoreText(data)).length;
  if (byteCount <= PACK_DATA_MAX_BYTES) return null;
  return `${packName} would store ${byteCount} bytes, over the ${PACK_DATA_MAX_BYTES} byte limit; nothing was saved`;
}

export const PanelToHost = z.discriminatedUnion('kind', [
  z.strictObject({ v: BridgeVersion, kind: z.literal('subscribe'), topics: z.array(PackBridgeTopic).describe("The topics to receive; only those also listed in the panel's reads in pack.json are granted, and a later subscribe replaces the earlier one. An empty list still gets hello and the store") }),
  z.strictObject({ v: BridgeVersion, kind: z.literal('store-set'), key: PackStoreKey, value: PackStoreValue.describe(`Any JSON value nested at most ${PACK_STORE_MAX_DEPTH} levels deep; null deletes the key`) }).describe('Save one key of the pack store; the host answers with a store message'),
]);

const HostTopicMessages = PackBridgeTopic.options.map((topic) => z.strictObject({
  v: BridgeVersion, kind: z.literal('topic'), topic: z.literal(topic), data: PACK_BRIDGE_TOPIC_DATA[topic],
}).describe('Sent right after hello and again whenever the data changes, checked once a second'));

export const HostToPanel = z.union([
  z.strictObject({ v: BridgeVersion, kind: z.literal('hello'), granted: z.array(PackBridgeTopic).describe('The subscribed topics that are also in reads; a topic missing here never arrives') }),
  z.strictObject({ v: BridgeVersion, kind: z.literal('store'), data: PackStoreData, error: z.string().nullable().describe('Why the last store-set was not saved, such as the size limit; null when it was') }).describe('Sent after hello and after each store-set from any panel of the pack in this dashboard'),
  ...HostTopicMessages,
]);

export function packBridgeJsonSchemaText(): string {
  return `${JSON.stringify({ panelToHost: z.toJSONSchema(PanelToHost), hostToPanel: z.toJSONSchema(HostToPanel) }, null, 2)}\n`;
}
