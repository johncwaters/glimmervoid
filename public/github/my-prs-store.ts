import { MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { PrFlowsStatus } from '#shared/contracts/pr-flows.ts';
import type { PrActionRunView, PrFlowActionChoice, PrFlowActionRunStatus, PrFlowHandled, PrFlowItem, PrFlowPendingApproval, PrFlowSourceRunStatus } from '#shared/contracts/pr-flows.ts';
import type { LinkedPr, MyPr } from '#shared/contracts/my-prs.ts';
import { describeSchemaIssues } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { queueMergeCelebration } from '../merge-celebration.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { joinMyPrs, liveSessionsByPrKey, mergeCelebrationText, newlyMergedPrs } from './github-store-core.ts';
import type { LinkedLiveSession, LiveSessionLinks } from './github-store-core.ts';

export type MyPrsChange =
  | { kind: 'prs' }
  | { kind: 'session-state' }
  | { kind: 'merge-result'; message: unknown }
  | { kind: 'connection'; isConnected: boolean };

let latest: MyPrsStatus | null = null;
let handledByPr: Readonly<Record<string, readonly PrFlowHandled[]>> = {};
let prFlowWarnings: readonly string[] = [];
let prFlowApprovals: readonly PrFlowPendingApproval[] = [];
let sourceRunsByPr: Readonly<Record<string, readonly PrFlowSourceRunStatus[]>> = {};
let reviewItemsByPr: Readonly<Record<string, PrFlowItem[]>> = {};
let prFlowActions: readonly PrFlowActionChoice[] = [];
let actionRunsByPr: Readonly<Record<string, readonly PrFlowActionRunStatus[]>> = {};
let prActionsByPr: Readonly<Record<string, readonly PrFlowActionChoice[]>> = {};
let prActionRunsByPr: Readonly<Record<string, readonly PrActionRunView[]>> = {};
let previousJoinedPrs: MyPr[] | null = null;
const celebratedMergeKeys = new Set<string>();
let sessionLinksById: ReadonlyMap<string, readonly LinkedPr[]> = new Map();
let isRefreshQueued = false;
const listeners = new Set<(change: MyPrsChange) => void>();

function notify(change: MyPrsChange): void {
  for (const listener of listeners) listener(change);
}

function liveSessionLinks(): LiveSessionLinks[] {
  return [...sessionLinksById].flatMap(([id, links]) => {
    const ui = sessionUIs.get(id);
    if (!ui || links.length === 0) return [];
    return [{ id, title: sessionName(ui) || id, links }];
  });
}

function celebrateNewlyMergedAndNotify(): void {
  const prs = joinMyPrs(latest?.prs ?? [], githubPrByKey);
  const mergedSinceLastRefresh = newlyMergedPrs(previousJoinedPrs, prs);
  previousJoinedPrs = prs;
  celebrateMergedPrs(mergedSinceLastRefresh);
  notify({ kind: 'prs' });
}

function queueRefresh(): void {
  if (isRefreshQueued) return;
  isRefreshQueued = true;
  queueMicrotask(() => {
    isRefreshQueued = false;
    celebrateNewlyMergedAndNotify();
  });
}

export function subscribeMyPrs(listener: (change: MyPrsChange) => void): void {
  listeners.add(listener);
}

export function myPrsSnapshot(): {
  prs: MyPr[]; status: MyPrsStatus | null; sessionsByPrKey: Map<string, LinkedLiveSession[]>; handledByPr: Readonly<Record<string, readonly PrFlowHandled[]>>; prFlowWarnings: readonly string[];
  prFlowApprovals: readonly PrFlowPendingApproval[]; sourceRunsByPr: Readonly<Record<string, readonly PrFlowSourceRunStatus[]>>;
  prFlowActions: readonly PrFlowActionChoice[]; actionRunsByPr: Readonly<Record<string, readonly PrFlowActionRunStatus[]>>;
  prActionsByPr: Readonly<Record<string, readonly PrFlowActionChoice[]>>; prActionRunsByPr: Readonly<Record<string, readonly PrActionRunView[]>>;
} {
  const prs = joinMyPrs(latest?.prs ?? [], githubPrByKey).map((pr) => ({ ...pr, reviewItems: reviewItemsByPr[pr.key] ?? pr.reviewItems }));
  return { prs, status: latest, sessionsByPrKey: liveSessionsByPrKey(liveSessionLinks()), handledByPr, prFlowWarnings, prFlowApprovals, sourceRunsByPr, prFlowActions, actionRunsByPr, prActionsByPr, prActionRunsByPr };
}

export function celebrateMergedPrs(mergedPrs: readonly MyPr[]): void {
  const uncelebratedPrs = mergedPrs.filter((pr) => !celebratedMergeKeys.has(pr.key));
  if (uncelebratedPrs.length === 0) return;
  for (const pr of uncelebratedPrs) celebratedMergeKeys.add(pr.key);
  queueMergeCelebration(mergeCelebrationText(uncelebratedPrs));
}

export function setMyPrsSessionLinks(linksBySessionId: ReadonlyMap<string, readonly LinkedPr[]>): void {
  sessionLinksById = linksBySessionId;
  queueRefresh();
}

export function refreshMyPrsSessionState(): void {
  notify({ kind: 'session-state' });
}

export function applyMyPrsStatus(message: unknown): void {
  const parsed = MyPrsStatus.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('reviews', `dropped my-prs-status: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  latest = parsed.data;
  celebrateNewlyMergedAndNotify();
}

export function applyPrFlowsStatus(message: unknown): void {
  const parsed = PrFlowsStatus.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('reviews', `dropped pr-flows-status: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  handledByPr = parsed.data.handledByPr;
  prFlowWarnings = parsed.data.warnings;
  prFlowApprovals = parsed.data.pendingApprovals;
  sourceRunsByPr = parsed.data.sourceRunsByPr;
  reviewItemsByPr = parsed.data.reviewItemsByPr;
  prFlowActions = parsed.data.actions;
  actionRunsByPr = parsed.data.actionRunsByPr;
  prActionsByPr = parsed.data.prActionsByPr;
  prActionRunsByPr = parsed.data.prActionRunsByPr;
  notify({ kind: 'prs' });
}

export function applyMyPrMergeResult(message: unknown): void {
  notify({ kind: 'merge-result', message });
}

export function applyMyPrsConnectionState(isConnected: boolean): void {
  notify({ kind: 'connection', isConnected });
}

subscribeGithubPrs(queueRefresh);
