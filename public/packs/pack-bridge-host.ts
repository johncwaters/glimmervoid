import { HostToPanel, PanelActionEnvelope, PanelToHost, packStoreAfterSet, packStoreSizeError } from '#shared/contracts/pack-bridge.ts';
import type { PackBridgeTopic, PackBridgeTopicData, PackPanelAct, PackStoreData } from '#shared/contracts/pack-bridge.ts';
import { panelActionDecision, panelActionLogText } from '#shared/pack-action-core.ts';
import type { z } from 'zod';
import { errorMessage } from '#shared/text.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { REQUEST_TIMED_OUT_TEXT } from '../updates-view-core.ts';
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
const PANEL_ACTION_TIMEOUT_MS = 120_000;

type PanelGrant = { pack: string; reads: readonly PackBridgeTopic[]; acts: readonly PackPanelAct[] };

type BridgedFrame = {
  viewId: string;
  frame: HTMLIFrameElement;
  packName: string;
  acts: readonly PackPanelAct[];
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

function postActionResult(bridged: BridgedFrame, actionId: string, result: Record<string, unknown> | null, error: string | null, isTimedOut = false): void {
  post(bridged, { v: 1, kind: 'action-result', id: actionId, ok: error === null, timedOut: isTimedOut, result, error });
}

function replyErrorOf(type: string, result: Record<string, unknown>): string | null {
  if (result.ok !== false) return null;
  return typeof result.error === 'string' && result.error !== '' ? result.error : `${type} was refused`;
}

async function runPanelAction(bridged: BridgedFrame, actionId: string, request: unknown): Promise<void> {
  const decision = panelActionDecision(bridged.acts, request);
  if (!decision.ok) {
    postActionResult(bridged, actionId, null, decision.error);
    return;
  }
  sendControlMsg({ type: 'client-log', scope: 'packs', text: panelActionLogText(bridged.viewId, decision.type, decision.payload) });
  const reply = await sendControlRequest(decision.type, decision.payload, { timeoutMs: PANEL_ACTION_TIMEOUT_MS }).catch((error: unknown) => errorMessage(error));
  if (reply === REQUEST_TIMED_OUT_TEXT) {
    postActionResult(bridged, actionId, null, `${decision.type} got no answer within ${PANEL_ACTION_TIMEOUT_MS / 1000} s; it may still run, so check before sending it again`, true);
    return;
  }
  if (typeof reply === 'string') {
    postActionResult(bridged, actionId, null, `${decision.type} failed: ${reply}`);
    return;
  }
  const result: Record<string, unknown> = { ...reply };
  postActionResult(bridged, actionId, result, replyErrorOf(decision.type, result));
}

function onPanelMessage(event: MessageEvent): void {
  const bridged = [...bridgedFrameByViewId.values()].find((candidate) => candidate.frame.contentWindow !== null && candidate.frame.contentWindow === event.source);
  if (!bridged) return;
  const action = PanelActionEnvelope.safeParse(event.data);
  if (action.success) {
    void runPanelAction(bridged, action.data.id, action.data.request);
    return;
  }
  const request = PanelToHost.safeParse(event.data);
  if (!request.success) return;
  if (request.data.kind === 'store-set') {
    void saveStoreKey(bridged, request.data.key, request.data.value);
    return;
  }
  if (request.data.kind === 'subscribe') subscribe(bridged, request.data.topics);
}

export function bridgePackFrame(viewId: string, frame: HTMLIFrameElement, grant: PanelGrant): void {
  if (bridgedFrameByViewId.size === 0) window.addEventListener('message', onPanelMessage);
  bridgedFrameByViewId.set(viewId, { viewId, frame, packName: grant.pack, acts: grant.acts, grantedTopics: new Set(grant.reads), subscribedTopics: new Set(), lastSentJsonByTopic: new Map() });
}
