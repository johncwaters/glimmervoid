import { HostToPanel, PanelToHost, packStoreAfterSet, packStoreSizeError } from '#shared/contracts/pack-bridge.ts';
import type { PackBridgeTopic, PackBridgeTopicData, PackStoreData } from '#shared/contracts/pack-bridge.ts';
import type { z } from 'zod';
import { errorMessage } from '#shared/text.ts';
import { sendControlRequest } from '../control-ws.ts';
import { countAttentionByKind } from '../focus-view/attention-core.ts';
import { reviewsSnapshot } from '../github/review-queue-store.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { maskStreamerText } from '../streamer-text-core.ts';
import { currentThemeColors } from '../theme.ts';
import { uiState } from '../ui-state-core.ts';
import { usageSnapshot } from '../usage/usage-store.ts';
import { planWindowOf } from '../usage/usage-store-core.ts';

const BRIDGE_PUSH_INTERVAL_MS = 1000;

type BridgedFrame = {
  frame: HTMLIFrameElement;
  packName: string;
  grantedTopics: ReadonlySet<PackBridgeTopic>;
  subscribedTopics: Set<PackBridgeTopic>;
  lastSentJsonByTopic: Map<PackBridgeTopic, string>;
};

const bridgedFrameByViewId = new Map<string, BridgedFrame>();
let pushTimer: ReturnType<typeof setInterval> | null = null;

function shownText(text: string): string {
  return isStreamerMode() ? maskStreamerText(text) : text;
}

const TOPIC_PROJECTIONS: { [Topic in PackBridgeTopic]: () => PackBridgeTopicData[Topic] } = {
  sessions: () => ({
    sessions: [...sessionUIs].map(([id, ui]) => ({
      id, name: shownText(sessionName(ui)), agent: ui.agent ?? null, state: ui.currentState, stateSinceMs: ui.stateSince, taskTitle: ui.taskTitle === null ? null : shownText(ui.taskTitle),
    })),
  }),
  focus: () => ({ sessionId: uiState.snapshot().focusedSessionId, view: uiState.snapshot().activeView, isStreamerMode: isStreamerMode() }),
  theme: () => currentThemeColors(),
  usage: () => ({
    planLimits: Object.entries(usageSnapshot().planLimitsByVendor).flatMap(([vendor, planLimits]) => {
      if (planLimits === null || (vendor !== 'claude' && vendor !== 'codex' && vendor !== 'kimi')) return [];
      return [{ vendor, fiveHour: planWindowOf(planLimits, 'fiveHour'), sevenDay: planWindowOf(planLimits, 'sevenDay') }];
    }),
  }),
  attention: () => {
    const counts = countAttentionByKind([...sessionUIs.values()].map((ui) => ({ state: ui.currentState, unseenOutcome: ui.unseenOutcome ?? null })));
    return { waiting: counts.waitingCount, finished: counts.finishedCount, failed: counts.failedCount };
  },
  reviews: () => reviewsSnapshot(),
};

function post(bridged: BridgedFrame, message: z.infer<typeof HostToPanel>): void {
  bridged.frame.contentWindow?.postMessage(message, '*');
}

type TopicFrame = { data: unknown; dataJson: string };

function topicFrame(topic: PackBridgeTopic, framesThisTick: Map<PackBridgeTopic, TopicFrame>): TopicFrame {
  const cached = framesThisTick.get(topic);
  if (cached) return cached;
  const data = TOPIC_PROJECTIONS[topic]();
  const frame = { data, dataJson: JSON.stringify(data) };
  framesThisTick.set(topic, frame);
  return frame;
}

function pushTopic(bridged: BridgedFrame, topic: PackBridgeTopic, framesThisTick: Map<PackBridgeTopic, TopicFrame> = new Map()): void {
  const { data, dataJson } = topicFrame(topic, framesThisTick);
  if (bridged.lastSentJsonByTopic.get(topic) === dataJson) return;
  bridged.lastSentJsonByTopic.set(topic, dataJson);
  post(bridged, HostToPanel.parse({ v: 1, kind: 'topic', topic, data }));
}

function pushChangedTopics(): void {
  let hasSubscriber = false;
  const framesThisTick = new Map<PackBridgeTopic, TopicFrame>();
  for (const bridged of bridgedFrameByViewId.values()) {
    for (const topic of bridged.subscribedTopics) pushTopic(bridged, topic, framesThisTick);
    hasSubscriber ||= bridged.subscribedTopics.size > 0;
  }
  if (hasSubscriber || pushTimer === null) return;
  clearInterval(pushTimer);
  pushTimer = null;
}

type PackDataReply = { ok: true; data: PackStoreData } | { ok: false; error: string };

const lastStoreByPackName = new Map<string, PackStoreData>();

async function requestPackData(type: 'pack-data-get' | 'pack-data-set', payload: Record<string, unknown>): Promise<PackDataReply> {
  const reply = await sendControlRequest(type, payload).catch((error: unknown) => errorMessage(error));
  if (typeof reply === 'string') return { ok: false, error: reply };
  if (reply.type !== 'pack-data-result') return { ok: false, error: `unexpected ${reply.type} reply` };
  if (reply.ok && reply.data) return { ok: true, data: reply.data };
  return { ok: false, error: reply.error ?? 'the pack store did not answer' };
}

function postStore(bridged: BridgedFrame, error: string | null): void {
  post(bridged, { v: 1, kind: 'store', data: lastStoreByPackName.get(bridged.packName) ?? {}, error });
}

async function sendStore(bridged: BridgedFrame): Promise<void> {
  const reply = await requestPackData('pack-data-get', { pack: bridged.packName });
  if (reply.ok) lastStoreByPackName.set(bridged.packName, reply.data);
  postStore(bridged, reply.ok ? null : reply.error);
}

async function saveStoreKey(bridged: BridgedFrame, key: string, value: unknown): Promise<void> {
  const sizeError = packStoreSizeError(bridged.packName, packStoreAfterSet(lastStoreByPackName.get(bridged.packName) ?? {}, key, value));
  if (sizeError !== null) {
    postStore(bridged, sizeError);
    return;
  }
  const reply = await requestPackData('pack-data-set', { pack: bridged.packName, key, value });
  if (!reply.ok) {
    postStore(bridged, reply.error);
    return;
  }
  lastStoreByPackName.set(bridged.packName, reply.data);
  for (const sibling of bridgedFrameByViewId.values()) {
    if (sibling.packName === bridged.packName) postStore(sibling, null);
  }
}

function subscribe(bridged: BridgedFrame, topics: readonly PackBridgeTopic[]): void {
  bridged.subscribedTopics = new Set(topics.filter((topic) => bridged.grantedTopics.has(topic)));
  bridged.lastSentJsonByTopic.clear();
  post(bridged, { v: 1, kind: 'hello', granted: [...bridged.subscribedTopics] });
  void sendStore(bridged);
  for (const topic of bridged.subscribedTopics) pushTopic(bridged, topic);
  pushTimer ??= setInterval(pushChangedTopics, BRIDGE_PUSH_INTERVAL_MS);
}

function onPanelMessage(event: MessageEvent): void {
  const bridged = [...bridgedFrameByViewId.values()].find((candidate) => candidate.frame.contentWindow !== null && candidate.frame.contentWindow === event.source);
  if (!bridged) return;
  const request = PanelToHost.safeParse(event.data);
  if (!request.success) return;
  if (request.data.kind === 'store-set') {
    void saveStoreKey(bridged, request.data.key, request.data.value);
    return;
  }
  subscribe(bridged, request.data.topics);
}

export function bridgePackFrame(viewId: string, frame: HTMLIFrameElement, packName: string, reads: readonly PackBridgeTopic[]): void {
  if (bridgedFrameByViewId.size === 0) window.addEventListener('message', onPanelMessage);
  bridgedFrameByViewId.set(viewId, { frame, packName, grantedTopics: new Set(reads), subscribedTopics: new Set(), lastSentJsonByTopic: new Map() });
}
