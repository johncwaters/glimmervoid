import { z } from 'zod';
import { STATES } from '../states.ts';

export const PACK_BRIDGE_VERSION = 1;

export const PackBridgeTopic = z.enum(['sessions', 'focus', 'theme', 'my-prs', 'usage', 'attention', 'team-reviews']);
export type PackBridgeTopic = z.infer<typeof PackBridgeTopic>;

const BridgeVersion = z.literal(PACK_BRIDGE_VERSION);

const BridgePlanWindow = z.strictObject({
  pct: z.number().nullable().describe('Percent of the window used, 0 to 100; 100 or more means the limit is reached; null when the agent did not report it'),
  resetsAtMs: z.number().nullable().describe('When the window resets, as Unix epoch milliseconds; null when the agent did not report it'),
}).nullable().describe('null when the agent reported nothing for this window');
const BridgePullRequest = z.strictObject({ key: z.string(), title: z.string(), url: z.string(), author: z.string() });

const PACK_BRIDGE_TOPIC_DATA = {
  sessions: z.strictObject({
    sessions: z.array(z.strictObject({
      id: z.string(), name: z.string(), agent: z.string().nullable(),
      state: z.string().describe(`One of ${Object.values(STATES).join(', ')}; the theme color for a state is --state-<state in lowercase>, and DORMANT has none`),
      stateSinceMs: z.number().describe('When the session entered its state, as Unix epoch milliseconds'),
      taskTitle: z.string().nullable(),
    })),
  }),
  focus: z.strictObject({ sessionId: z.string().nullable(), view: z.string(), isStreamerMode: z.boolean().describe('The operator is screen sharing: session names and task titles arrive masked and pull request titles and authors arrive empty') }),
  theme: z.strictObject({
    id: z.string().nullable().describe("The active theme's id; a pack theme's id is <pack name>/<theme id>"),
    colors: z.record(z.string(), z.string()).describe('CSS custom properties to set on the root element, keyed with their leading --: one per theme chrome key (--bg, --bg-card, --bg-header, --bg-surface, --border, --border-dim, --border-hover, --text, --text-dim, --text-head, --text-muted, --accent, --accent-dim) and per session state (--state-<state>, a hex color, and --state-<state>-bg, a translucent color-mix tint of it)'),
  }),
  'my-prs': z.strictObject({
    prs: z.array(z.strictObject({
      key: z.string(), repo: z.string(), number: z.number(), title: z.string(), url: z.string(), isDraft: z.boolean(),
      state: z.enum(['OPEN', 'MERGED', 'CLOSED']), checks: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(),
      reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(), unresolvedThreads: z.number(),
    })),
  }),
  usage: z.strictObject({
    planLimits: z.array(z.strictObject({ vendor: z.enum(['claude', 'codex', 'kimi']), fiveHour: BridgePlanWindow, sevenDay: BridgePlanWindow })).describe('One entry per agent that has reported plan limits; an agent that has not is absent'),
  }),
  attention: z.strictObject({ waiting: z.number(), finished: z.number(), failed: z.number() }),
  'team-reviews': z.strictObject({ ready: z.array(BridgePullRequest), needsAttention: z.array(BridgePullRequest), inReviewCount: z.number(), queuedCount: z.number() }),
} satisfies Record<PackBridgeTopic, z.ZodType>;

export type PackBridgeTopicData = { [Topic in PackBridgeTopic]: z.infer<(typeof PACK_BRIDGE_TOPIC_DATA)[Topic]> };

export const PanelToHost = z.discriminatedUnion('kind', [
  z.strictObject({ v: BridgeVersion, kind: z.literal('subscribe'), topics: z.array(PackBridgeTopic).min(1).describe("The topics to receive; only those also listed in the panel's reads in pack.json are granted, and a later subscribe replaces the earlier one") }),
]);

const HostTopicMessages = PackBridgeTopic.options.map((topic) => z.strictObject({
  v: BridgeVersion, kind: z.literal('topic'), topic: z.literal(topic), data: PACK_BRIDGE_TOPIC_DATA[topic],
}).describe('Sent right after hello and again whenever the data changes, checked once a second'));

export const HostToPanel = z.union([
  z.strictObject({ v: BridgeVersion, kind: z.literal('hello'), granted: z.array(PackBridgeTopic).describe('The subscribed topics that are also in reads; a topic missing here never arrives') }),
  ...HostTopicMessages,
]);

export function packBridgeJsonSchemaText(): string {
  return `${JSON.stringify({ panelToHost: z.toJSONSchema(PanelToHost), hostToPanel: z.toJSONSchema(HostToPanel) }, null, 2)}\n`;
}
