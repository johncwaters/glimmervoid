import type { LinkedPr, MyPr, MyPrsStatus } from '#shared/contracts/my-prs.ts';
import { queueMergeCelebration } from '../merge-celebration.ts';
import { sessionName, sessionUIs } from '../session-card/card-registry.ts';
import { githubPrByKey, subscribeGithubPrs } from './github-prs-store.ts';
import { joinMyPrs, liveSessionsByPrKey, mergeCelebrationText, newlyMergedPrs, parseMyPrsStatus } from './my-prs-view-core.ts';
import type { LinkedLiveSession, LiveSessionLinks } from './my-prs-view-core.ts';

export type MyPrsChange =
  | { kind: 'prs' }
  | { kind: 'session-state' }
  | { kind: 'merge-result'; message: unknown }
  | { kind: 'connection'; isConnected: boolean };

let latest: MyPrsStatus | null = null;
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

export function myPrsSnapshot(): { prs: MyPr[]; status: MyPrsStatus | null; sessionsByPrKey: Map<string, LinkedLiveSession[]> } {
  return { prs: joinMyPrs(latest?.prs ?? [], githubPrByKey), status: latest, sessionsByPrKey: liveSessionsByPrKey(liveSessionLinks()) };
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
  const parsed = parseMyPrsStatus(message);
  if (!parsed) return;
  latest = parsed;
  celebrateNewlyMergedAndNotify();
}

export function applyMyPrMergeResult(message: unknown): void {
  notify({ kind: 'merge-result', message });
}

export function applyMyPrsConnectionState(isConnected: boolean): void {
  notify({ kind: 'connection', isConnected });
}

subscribeGithubPrs(queueRefresh);
