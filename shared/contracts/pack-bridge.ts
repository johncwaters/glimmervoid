import { z } from 'zod';

const PACK_BRIDGE_VERSION = 1;

export const PackBridgeTopic = z.enum(['sessions', 'focus', 'theme', 'my-prs', 'usage', 'attention', 'team-reviews']);
export type PackBridgeTopic = z.infer<typeof PackBridgeTopic>;

const BridgeVersion = z.literal(PACK_BRIDGE_VERSION);

const BridgePlanWindow = z.strictObject({ pct: z.number().nullable(), resetsAtMs: z.number().nullable() }).nullable();
const BridgePullRequest = z.strictObject({ key: z.string(), title: z.string(), url: z.string(), author: z.string() });

const PACK_BRIDGE_TOPIC_DATA = {
  sessions: z.strictObject({
    sessions: z.array(z.strictObject({
      id: z.string(), name: z.string(), agent: z.string().nullable(), state: z.string(), stateSinceMs: z.number(), taskTitle: z.string().nullable(),
    })),
  }),
  focus: z.strictObject({ sessionId: z.string().nullable(), view: z.string(), isStreamerMode: z.boolean() }),
  theme: z.strictObject({ id: z.string().nullable(), colors: z.record(z.string(), z.string()) }),
  'my-prs': z.strictObject({
    prs: z.array(z.strictObject({
      key: z.string(), repo: z.string(), number: z.number(), title: z.string(), url: z.string(), isDraft: z.boolean(),
      state: z.enum(['OPEN', 'MERGED', 'CLOSED']), checks: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable(),
      reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(), unresolvedThreads: z.number(),
    })),
  }),
  usage: z.strictObject({
    planLimits: z.array(z.strictObject({ vendor: z.enum(['claude', 'codex', 'kimi']), fiveHour: BridgePlanWindow, sevenDay: BridgePlanWindow })),
  }),
  attention: z.strictObject({ waiting: z.number(), finished: z.number(), failed: z.number() }),
  'team-reviews': z.strictObject({ ready: z.array(BridgePullRequest), needsAttention: z.array(BridgePullRequest), inReviewCount: z.number(), queuedCount: z.number() }),
} satisfies Record<PackBridgeTopic, z.ZodType>;

export type PackBridgeTopicData = { [Topic in PackBridgeTopic]: z.infer<(typeof PACK_BRIDGE_TOPIC_DATA)[Topic]> };

export const PanelToHost = z.discriminatedUnion('kind', [
  z.strictObject({ v: BridgeVersion, kind: z.literal('subscribe'), topics: z.array(PackBridgeTopic).min(1) }),
]);

const HostTopicMessages = PackBridgeTopic.options.map((topic) => z.strictObject({
  v: BridgeVersion, kind: z.literal('topic'), topic: z.literal(topic), data: PACK_BRIDGE_TOPIC_DATA[topic],
}));

export const HostToPanel = z.union([
  z.strictObject({ v: BridgeVersion, kind: z.literal('hello'), granted: z.array(PackBridgeTopic) }),
  ...HostTopicMessages,
]);

export function packBridgeJsonSchemaText(): string {
  return `${JSON.stringify({ panelToHost: z.toJSONSchema(PanelToHost), hostToPanel: z.toJSONSchema(HostToPanel) }, null, 2)}\n`;
}
