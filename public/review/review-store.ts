import { CHANGES_POLL_INTERVAL_MS } from '#shared/contracts/control-messages.ts';
import { ChangeMap } from '#shared/contracts/change-map.ts';
import type { ChangeMapView } from '#shared/change-map-view-core.ts';
import { buildChangeMapView } from '#shared/change-map-view-core.ts';
import { sendControlMsg } from '../control-ws.ts';
import { sessionIdOf, sessionUIs } from '../session-card/card-registry.ts';
import { shouldDropDiffCache } from './diff-core.ts';
import type { SessionDiffPayload } from './review-copy-core.ts';
import type { ReaderFile, ReviewView } from './review-reader-core.ts';
import { readerFilesOf, reviewViewOf } from './review-reader-core.ts';
import { getSelectedId, onSelectionChange, setSelectedId } from './selection.ts';

export interface SessionReview extends ReviewView {
  sessionId: string;
  files: ReaderFile[];
  diffError: string | null;
  changeMapView: ChangeMapView | null;
  isWorkspace: boolean;
}

const statusById = new Map<string, string>();
const reasonById = new Map<string, string | null>();
const diffById = new Map<string, SessionDiffPayload | null>();
const diffErrorById = new Map<string, string>();
const mapById = new Map<string, ChangeMap | null>();
const filesByPayload = new WeakMap<SessionDiffPayload, ReaderFile[]>();
const changeMapViewByMap = new WeakMap<ChangeMap, ChangeMapView>();
const listeners = new Set<(sessionId: string) => void>();
const onScreenSurfaces = new Set<Element>();
let watchedSessionId: string | null = null;
let watchRenewTimer: ReturnType<typeof setInterval> | null = null;
let surfaceObserver: IntersectionObserver | null = null;

export function onReviewChange(listener: (sessionId: string) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(sessionId: string) {
  for (const listener of listeners) listener(sessionId);
}

function filesOf(payload: SessionDiffPayload | null | undefined): ReaderFile[] {
  if (!payload) return [];
  const cached = filesByPayload.get(payload);
  if (cached) return cached;
  const files = readerFilesOf(payload);
  filesByPayload.set(payload, files);
  return files;
}

function changeMapViewOf(map: ChangeMap | null | undefined): ChangeMapView | null {
  if (!map) return null;
  const cached = changeMapViewByMap.get(map);
  if (cached) return cached;
  const view = buildChangeMapView(map);
  changeMapViewByMap.set(map, view);
  return view;
}

function isWorkspaceSession(sessionId: string) {
  return sessionUIs.get(sessionId)?.card.dataset.workspace !== undefined;
}

export function reviewOf(sessionId: string): SessionReview | null {
  const ui = sessionUIs.get(sessionId);
  if (!ui) return null;
  const payload = diffById.get(sessionId) ?? null;
  const files = filesOf(payload);
  const diffError = diffErrorById.get(sessionId) ?? null;
  const view = reviewViewOf({
    status: statusById.get(sessionId) || 'none',
    reason: reasonById.get(sessionId) ?? null,
    isFetched: diffById.has(sessionId),
    hasCommits: payload?.hasCommits === true,
    hasDiffError: diffError !== null,
    isWorkspace: isWorkspaceSession(sessionId),
    state: ui.currentState,
    files,
  });
  return {
    ...view,
    sessionId,
    files,
    diffError,
    changeMapView: changeMapViewOf(mapById.get(sessionId)),
    isWorkspace: isWorkspaceSession(sessionId),
  };
}

function requestChangeMap(sessionId: string) {
  if (!mapById.has(sessionId)) mapById.set(sessionId, null);
  sendControlMsg({ type: 'request-change-map', id: sessionId });
}

function requestDiff(sessionId: string) {
  sendControlMsg({ type: 'request-session-diff', id: sessionId });
  requestChangeMap(sessionId);
}

function applyStatus(sessionId: string, nextStatus: string) {
  const previousStatus = statusById.get(sessionId);
  statusById.set(sessionId, nextStatus);
  if (shouldDropDiffCache(previousStatus, nextStatus)) {
    diffById.delete(sessionId);
    diffErrorById.delete(sessionId);
    mapById.delete(sessionId);
    if (sessionId === getSelectedId()) requestDiff(sessionId);
  }
  announce(sessionId);
}

export function setMergeStatus(sessionId: string, status: string, reason: string | null = null) {
  const nextStatus = status || 'none';
  reasonById.set(sessionId, reason);
  applyStatus(sessionId, nextStatus);
}

export function seedMergeStatus(sessionId: string, status: string, reason: string | null = null) {
  reasonById.set(sessionId, reason);
  applyStatus(sessionId, status || 'none');
}

export function setSessionDiff(id: unknown, payload: SessionDiffPayload | null) {
  const sessionId = sessionIdOf(id);
  if (!sessionId) return;
  diffById.set(sessionId, payload);
  diffErrorById.delete(sessionId);
  announce(sessionId);
}

export function setSessionDiffError(id: unknown, message: string) {
  const sessionId = sessionIdOf(id);
  if (!sessionId) return;
  diffErrorById.set(sessionId, message);
  announce(sessionId);
}

export function setChangeMap(id: unknown, map: unknown) {
  const sessionId = sessionIdOf(id);
  if (!sessionId) return;
  const parsed = ChangeMap.safeParse(map);
  if (!parsed.success || parsed.data.sessionId !== sessionId) return;
  mapById.set(sessionId, parsed.data);
  announce(sessionId);
}

export function noteWorktreeChanged(id: unknown) {
  const sessionId = sessionIdOf(id);
  if (sessionId && sessionId === getSelectedId()) requestDiff(sessionId);
}

function hasChangeMapError(map: ChangeMap | null | undefined) {
  if (!map) return false;
  return Boolean(map.error) || map.repos.some((repo) => repo.error !== null);
}

export function refreshReview(id: unknown) {
  const sessionId = sessionIdOf(id);
  if (!sessionId || sessionId !== getSelectedId()) return;
  const isDiffStale = !diffById.has(sessionId) || diffErrorById.has(sessionId);
  const isChangeMapStale = !mapById.has(sessionId) || hasChangeMapError(mapById.get(sessionId));
  if (isDiffStale) requestDiff(sessionId);
  if (isChangeMapStale && !isDiffStale) requestChangeMap(sessionId);
  announce(sessionId);
}

export function forgetReview(id: unknown) {
  const sessionId = sessionIdOf(id);
  statusById.delete(sessionId);
  reasonById.delete(sessionId);
  diffById.delete(sessionId);
  diffErrorById.delete(sessionId);
  mapById.delete(sessionId);
  if (sessionId === getSelectedId()) {
    setSelectedId(null);
    return;
  }
  announce(sessionId);
}

function hasShowingSurface(): boolean {
  return [...onScreenSurfaces].some((surface) => !surface.hasAttribute('data-slot-held'));
}

export function syncWatch() {
  const wantedSessionId = hasShowingSurface() && document.visibilityState === 'visible' ? getSelectedId() : null;
  if (wantedSessionId === watchedSessionId) return;
  if (watchRenewTimer) clearInterval(watchRenewTimer);
  watchRenewTimer = null;
  watchedSessionId = wantedSessionId;
  sendControlMsg({ type: 'watch-session-changes', id: wantedSessionId });
  if (!wantedSessionId) return;
  watchRenewTimer = setInterval(() => sendControlMsg({ type: 'watch-session-changes', id: wantedSessionId }), CHANGES_POLL_INTERVAL_MS);
}

export function watchReviewSurface(surface: Element) {
  surfaceObserver ??= startWatchingSurfaces();
  surfaceObserver.observe(surface);
}

function startWatchingSurfaces() {
  document.addEventListener('visibilitychange', syncWatch);
  onSelectionChange((sessionId) => {
    if (sessionId) requestDiff(sessionId);
    syncWatch();
  });
  return new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreenSurfaces.add(entry.target);
      if (!entry.isIntersecting) onScreenSurfaces.delete(entry.target);
    }
    syncWatch();
  });
}
