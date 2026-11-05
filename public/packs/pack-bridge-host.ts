import { HostToPanel, PanelToHost } from '#shared/contracts/pack-bridge.ts';
import type { PackBridgeTopic, PackBridgeTopicData } from '#shared/contracts/pack-bridge.ts';
import type { z } from 'zod';
import { countAttentionByKind } from '../focus-view/attention-core.ts';
import { myPrsSnapshot } from '../github/my-prs-store.ts';
import { teamReviewSections } from '../github/team-review-store.ts';
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
  grantedTopics: ReadonlySet<PackBridgeTopic>;
  subscribedTopics: Set<PackBridgeTopic>;
  lastSentJsonByTopic: Map<PackBridgeTopic, string>;
};

const bridgedFrameByViewId = new Map<string, BridgedFrame>();
let pushTimer: ReturnType<typeof setInterval> | null = null;

function shownText(text: string): string {
  return isStreamerMode() ? maskStreamerText(text) : text;
}

function shownPullRequestText(text: string): string {
  return isStreamerMode() ? '' : text;
}

const TOPIC_PROJECTIONS: { [Topic in PackBridgeTopic]: () => PackBridgeTopicData[Topic] } = {
  sessions: () => ({
    sessions: [...sessionUIs].map(([id, ui]) => ({
      id, name: shownText(sessionName(ui)), agent: ui.agent ?? null, state: ui.currentState, stateSinceMs: ui.stateSince, taskTitle: ui.taskTitle === null ? null : shownText(ui.taskTitle),
    })),
  }),
  focus: () => ({ sessionId: uiState.snapshot().focusedSessionId, view: uiState.snapshot().activeView, isStreamerMode: isStreamerMode() }),
  theme: () => currentThemeColors(),
  'my-prs': () => ({
    prs: myPrsSnapshot().prs.map((pr) => ({
      key: pr.key, repo: pr.repo, number: pr.number, title: shownPullRequestText(pr.title), url: pr.url, isDraft: pr.isDraft, state: pr.state,
      checks: pr.checks.state, reviewDecision: pr.reviewDecision, unresolvedThreads: pr.unresolvedThreads,
    })),
  }),
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
  'team-reviews': () => {
    const sections = teamReviewSections();
    const pullRequestOf = ({ key, title, url, author }: { key: string; title: string; url: string; author: string }) => ({ key, title: shownPullRequestText(title), url, author: shownPullRequestText(author) });
    return { ready: sections.ready.map(pullRequestOf), needsAttention: sections.attention.map(pullRequestOf), inReviewCount: sections.inReview.length, queuedCount: sections.queued.length };
  },
};

function post(bridged: BridgedFrame, message: z.infer<typeof HostToPanel>): void {
  bridged.frame.contentWindow?.postMessage(message, '*');
}

function pushTopic(bridged: BridgedFrame, topic: PackBridgeTopic): void {
  const data = TOPIC_PROJECTIONS[topic]();
  const dataJson = JSON.stringify(data);
  if (bridged.lastSentJsonByTopic.get(topic) === dataJson) return;
  bridged.lastSentJsonByTopic.set(topic, dataJson);
  post(bridged, HostToPanel.parse({ v: 1, kind: 'topic', topic, data }));
}

function pushChangedTopics(): void {
  let hasSubscriber = false;
  for (const bridged of bridgedFrameByViewId.values()) {
    for (const topic of bridged.subscribedTopics) pushTopic(bridged, topic);
    hasSubscriber ||= bridged.subscribedTopics.size > 0;
  }
  if (hasSubscriber || pushTimer === null) return;
  clearInterval(pushTimer);
  pushTimer = null;
}

function onPanelMessage(event: MessageEvent): void {
  const bridged = [...bridgedFrameByViewId.values()].find((candidate) => candidate.frame.contentWindow !== null && candidate.frame.contentWindow === event.source);
  if (!bridged) return;
  const request = PanelToHost.safeParse(event.data);
  if (!request.success) return;
  bridged.subscribedTopics = new Set(request.data.topics.filter((topic) => bridged.grantedTopics.has(topic)));
  bridged.lastSentJsonByTopic.clear();
  post(bridged, { v: 1, kind: 'hello', granted: [...bridged.subscribedTopics] });
  for (const topic of bridged.subscribedTopics) pushTopic(bridged, topic);
  pushTimer ??= setInterval(pushChangedTopics, BRIDGE_PUSH_INTERVAL_MS);
}

export function bridgePackFrame(viewId: string, frame: HTMLIFrameElement, reads: readonly PackBridgeTopic[]): void {
  if (bridgedFrameByViewId.size === 0) window.addEventListener('message', onPanelMessage);
  bridgedFrameByViewId.set(viewId, { frame, grantedTopics: new Set(reads), subscribedTopics: new Set(), lastSentJsonByTopic: new Map() });
}
