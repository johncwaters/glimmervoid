import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { createAttentionAck } from '../attention-ack-core.ts';
import { getRadarAttentionAck, setRadarAttentionAck } from '../ui-prefs.ts';
import {
  applyInvestigationActivity as patchInvestigationActivity,
  applyInvestigationFinished as patchInvestigationFinished,
  findIssueInSnapshot,
  radarAttentionSignature,
  retainKnownInvestigationIds,
} from './radar-core.ts';
import type { InvestigationFinishedFrame, RadarSnapshot } from './radar-core.ts';

type ActivityFrame = ServerMessageOf<'radar-investigation-activity'>;

export type RadarChange =
  | { kind: 'status' }
  | { kind: 'investigation-activity'; projectId: ActivityFrame['projectId']; issueId: ActivityFrame['issueId']; wasInFlight: boolean }
  | { kind: 'investigation-finished'; frame: InvestigationFinishedFrame; isPatched: boolean };

let latestSnapshot: RadarSnapshot | null = null;
let activityCallback: ((unseen: boolean) => void) | null = null;
let traceOpener: ((sessionId: string) => void) | null = null;
let isViewLooking: () => boolean = () => false;
const archivedLocally = new Set<string>();
const subscribers = new Set<(change: RadarChange) => void>();

const attention = createAttentionAck({
  getAck: getRadarAttentionAck,
  setAck: setRadarAttentionAck,
  signature: () => radarAttentionSignature({ posthog: latestSnapshot }),
  isLooking: () => isViewLooking(),
});

function notifySubscribers(change: RadarChange): void {
  for (const subscriber of subscribers) subscriber(change);
}

function refreshAttention(): void {
  activityCallback?.(attention.refresh());
}

export function radarSnapshot(): { latest: RadarSnapshot | null; archivedLocally: Set<string>; traceOpener: ((sessionId: string) => void) | null } {
  return { latest: latestSnapshot, archivedLocally, traceOpener };
}

export function subscribeRadar(subscriber: (change: RadarChange) => void): void {
  subscribers.add(subscriber);
}

export function setRadarLookingProbe(probe: () => boolean): void {
  isViewLooking = probe;
  refreshAttention();
}

export function archiveInvestigationLocally(investigationId: string): void {
  archivedLocally.add(investigationId);
}

export function acknowledgeRadarAttention(): void {
  attention.acknowledge();
  refreshAttention();
}

export function setRadarActivityCallback(callback: (unseen: boolean) => void): void {
  activityCallback = callback;
  refreshAttention();
}

export function setRadarTraceOpener(open: ((sessionId: string) => void) | null): void {
  traceOpener = open;
}

export function applyRadarStatus(msg: unknown): void {
  latestSnapshot = msg as RadarSnapshot;
  retainKnownInvestigationIds(latestSnapshot, archivedLocally);
  notifySubscribers({ kind: 'status' });
  refreshAttention();
}

export function applyInvestigationActivity(frame: ActivityFrame): void {
  const wasInFlight = findIssueInSnapshot(latestSnapshot, frame.projectId, frame.issueId)?.inFlight === true;
  if (!patchInvestigationActivity(latestSnapshot, frame)) return;
  notifySubscribers({ kind: 'investigation-activity', projectId: frame.projectId, issueId: frame.issueId, wasInFlight });
}

export function applyInvestigationFinished(frame: ServerMessageOf<'radar-investigation-finished'>): void {
  const isPatched = patchInvestigationFinished(latestSnapshot, frame);
  notifySubscribers({ kind: 'investigation-finished', frame, isPatched });
  if (isPatched) refreshAttention();
}
