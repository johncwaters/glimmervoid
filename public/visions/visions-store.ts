import { createAttentionAck } from '../attention-ack-core.ts';
import { getVisionsAttentionAck, setVisionsAttentionAck } from '../ui-prefs.ts';
import {
  activityOverflowCount,
  applyActivityMessage,
  applyActivitySnapshot,
  applyCommentsMessage,
  applyCommentsSnapshot,
  applyFindingsMessage,
  applyFindingsSnapshot,
  applyFixMessage,
  applyFixSnapshot,
  applyHandMessage,
  applyHandSnapshot,
  applyIntentMessage,
  decideVisionsAttention,
  emptyIntentState,
  intentStateOfMessage,
  visionsAttentionState,
} from './visions-store-core.ts';
import type { ActivityEvent, IntentState, VisionsComment, VisionsFinding, VisionsFixEntry } from './visions-store-core.ts';

type VisionsMessage = Record<string, unknown>;
export type VisionsChange = 'intent' | 'feed' | 'fixes' | 'activity' | 'connection';

let findingsByUri = new Map<string, VisionsFinding[]>();
let commentsByUri = new Map<string, VisionsComment[]>();
let handsByUri = new Map<string, string>();
let intent: IntentState = emptyIntentState();
let projectNamesById = new Map<string, string>();
let isEnabled: boolean | null = null;
let isConnected = true;
let activityEvents: ActivityEvent[] = [];
let activityOverflow = 0;
let fixEntries: VisionsFixEntry[] = [];
let activityCallback: ((level: string | null) => void) | null = null;
let isViewLooking: () => boolean = () => false;
const subscribers = new Set<(changes: readonly VisionsChange[]) => void>();

let attentionState = visionsAttentionState(findingsByUri, commentsByUri, handsByUri, fixEntries, intent);
let acknowledgedSignature = getVisionsAttentionAck();

const attention = createAttentionAck({
  getAck: () => acknowledgedSignature,
  setAck: (next: string) => {
    acknowledgedSignature = next;
    setVisionsAttentionAck(next);
  },
  signature: () => attentionState.signature,
  isLooking: () => isViewLooking(),
});

function notifySubscribers(changes: readonly VisionsChange[]): void {
  for (const subscriber of subscribers) subscriber(changes);
}

function refreshAttention(): void {
  attentionState = visionsAttentionState(findingsByUri, commentsByUri, handsByUri, fixEntries, intent);
  if (attentionState.signature !== '') attention.refresh();
  activityCallback?.(decideVisionsAttention(attentionState, acknowledgedSignature));
}

function notifyAndRefreshAttention(changes: readonly VisionsChange[]): void {
  notifySubscribers(changes);
  refreshAttention();
}

export function visionsSnapshot() {
  return { findingsByUri, commentsByUri, handsByUri, intent, projectNamesById, isEnabled, isConnected, activityEvents, activityOverflow, fixEntries };
}

export function subscribeVisions(subscriber: (changes: readonly VisionsChange[]) => void): void {
  subscribers.add(subscriber);
}

export function setVisionsLookingProbe(probe: () => boolean): void {
  isViewLooking = probe;
  refreshAttention();
}

export function setVisionsActivityCallback(callback: (level: string | null) => void): void {
  activityCallback = callback;
  refreshAttention();
}

export function acknowledgeVisionsAttention(): void {
  if (attentionState.signature !== '') attention.acknowledge();
  refreshAttention();
}

export function setVisionsProjectNames(namesById: unknown): void {
  projectNamesById = namesById instanceof Map ? namesById : new Map();
  notifySubscribers(['intent']);
}

export function applyVisionsSettings(settings: unknown): void {
  isEnabled = (settings as { visions?: { enabled?: unknown } } | null | undefined)?.visions?.enabled === true;
  notifySubscribers(['feed']);
}

export function applyVisionsConnectionState(connected: boolean): void {
  isConnected = connected;
  notifySubscribers(['connection']);
}

export function applyVisionsFix(msg: VisionsMessage): void {
  fixEntries = applyFixMessage(fixEntries, msg);
  notifyAndRefreshAttention(['fixes']);
}

export function applyVisionsFindings(msg: VisionsMessage): void {
  findingsByUri = applyFindingsMessage(findingsByUri, msg);
  notifyAndRefreshAttention(['feed']);
}

export function applyVisionsComments(msg: VisionsMessage): void {
  commentsByUri = applyCommentsMessage(commentsByUri, msg);
  notifyAndRefreshAttention(['feed']);
}

export function applyVisionsHand(msg: VisionsMessage): void {
  handsByUri = applyHandMessage(handsByUri, msg);
  notifyAndRefreshAttention(['feed']);
}

export function applyVisionsIntent(msg: VisionsMessage): void {
  intent = applyIntentMessage(intent, msg);
  notifyAndRefreshAttention(['intent']);
}

export function applyIngestActivity(msg: VisionsMessage): void {
  activityEvents = applyActivityMessage(activityEvents, msg);
  activityOverflow = activityOverflowCount(msg);
  notifyAndRefreshAttention(['activity']);
}

export function applyIngestSnapshot(msg: VisionsMessage): void {
  activityEvents = applyActivitySnapshot(msg);
  activityOverflow = 0;
  notifyAndRefreshAttention(['activity']);
}

export function applyVisionsSnapshot(msg: VisionsMessage): void {
  findingsByUri = applyFindingsSnapshot(msg);
  commentsByUri = applyCommentsSnapshot(msg);
  handsByUri = applyHandSnapshot(msg);
  intent = intentStateOfMessage(msg);
  fixEntries = applyFixSnapshot(msg);
  notifyAndRefreshAttention(['intent', 'feed', 'fixes']);
}
