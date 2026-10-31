import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { SHOWN_FILES_KEPT_PER_SESSION } from '#shared/contracts/session.ts';
import type { ShownFile } from '#shared/contracts/session.ts';
import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { findSessionUi } from './session-card/card-registry.ts';

type ShownFaceModule = typeof import('./shown-face.ts');

type ShownFilesChangedListener = (sessionId: string, files: readonly ShownFile[]) => void;

const PRELOAD_FALLBACK_DELAY_MS = 2000;

const shownFilesBySessionId = new Map<string, ShownFile[]>();
const unopenedCountBySessionId = new Map<string, number>();
const changedListeners: ShownFilesChangedListener[] = [];
const liveArrivalListeners: ShownFilesChangedListener[] = [];
let pendingFaceModuleLoad: Promise<ShownFaceModule | null> | null = null;
let hasReceivedSnapshot = false;

export function shownFilesOf(sessionId: string): ShownFile[] {
  return shownFilesBySessionId.get(sessionId) ?? [];
}

function hasShownFiles(sessionId: string): boolean {
  return shownFilesOf(sessionId).length > 0;
}

export function unopenedShownCountOf(sessionId: string): number {
  return unopenedCountBySessionId.get(sessionId) ?? 0;
}

export function shownThumbnailUrl(sessionId: string, file: ShownFile): string | null {
  if (!file.hasThumbnail) return null;
  return `/shown/${encodeURIComponent(sessionId)}/${encodeURIComponent(`${file.id}.thumb.webp`)}`;
}

export function onShownFilesChanged(listener: ShownFilesChangedListener): void {
  changedListeners.push(listener);
}

export function onShownFilesArrivedLive(listener: ShownFilesChangedListener): void {
  liveArrivalListeners.push(listener);
}

export function paintShownTabs(sessionId: string): void {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  const isEmpty = !hasShownFiles(sessionId);
  ui.btnShownTab.classList.toggle('is-empty', isEmpty);
  ui.btnShownTab.setAttribute('aria-disabled', String(isEmpty));
  const unopenedCount = unopenedShownCountOf(sessionId);
  ui.shownUnopenedCount.hidden = unopenedCount === 0;
  ui.shownUnopenedCount.textContent = String(unopenedCount);
}

export function markShownFilesOpened(sessionId: string): void {
  if (!unopenedCountBySessionId.delete(sessionId)) return;
  paintShownTabs(sessionId);
  for (const listener of changedListeners) listener(sessionId, []);
}

export function loadShownFaceModule(): Promise<ShownFaceModule | null> {
  pendingFaceModuleLoad ??= import('./shown-face.ts').then(
    (faceModule) => faceModule,
    (error: unknown) => {
      pendingFaceModuleLoad = null;
      reportToServerLog('shown-files', `shown file viewer failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingFaceModuleLoad;
}

export function preloadShownFaceWhenIdle(): void {
  const preload = () => {
    void loadShownFaceModule();
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(preload);
    return;
  }
  setTimeout(preload, PRELOAD_FALLBACK_DELAY_MS);
}

export function openShownFace(sessionId: string, fileId: string | null = null): void {
  if (!hasShownFiles(sessionId)) return;
  findSessionUi(sessionId)?._showShownFace?.(fileId);
}

function keepNewest(files: readonly ShownFile[]): ShownFile[] {
  return files.slice(-SHOWN_FILES_KEPT_PER_SESSION);
}

function applyArrivedFiles(sessionId: string, arrivedFiles: readonly ShownFile[]): void {
  const ui = findSessionUi(sessionId);
  ui?.shownFace?.applyArrivals();
  if (arrivedFiles.length === 0) return;
  const isFaceOpenOnSession = ui?.face === 'shown';
  if (!isFaceOpenOnSession) unopenedCountBySessionId.set(sessionId, unopenedShownCountOf(sessionId) + arrivedFiles.length);
  paintShownTabs(sessionId);
  for (const listener of changedListeners) listener(sessionId, arrivedFiles);
}

export function applySessionShown(message: ServerMessageOf<'session-shown'>): void {
  const knownIds = new Set(shownFilesOf(message.id).map((file) => file.id));
  const arrivedFiles = message.files.filter((file) => !knownIds.has(file.id));
  shownFilesBySessionId.set(message.id, keepNewest([...shownFilesOf(message.id), ...arrivedFiles]));
  applyArrivedFiles(message.id, arrivedFiles);
  if (arrivedFiles.length === 0) return;
  for (const listener of liveArrivalListeners) listener(message.id, arrivedFiles);
}

export function applySessionShownSnapshot(message: ServerMessageOf<'session-shown-snapshot'>): void {
  const previousFilesBySessionId = new Map(shownFilesBySessionId);
  const isReconnect = hasReceivedSnapshot;
  hasReceivedSnapshot = true;
  shownFilesBySessionId.clear();
  for (const [sessionId, files] of Object.entries(message.sessions)) shownFilesBySessionId.set(sessionId, keepNewest(files));
  for (const sessionId of new Set([...previousFilesBySessionId.keys(), ...shownFilesBySessionId.keys()])) {
    if (!hasShownFiles(sessionId)) unopenedCountBySessionId.delete(sessionId);
    const knownIds = new Set((previousFilesBySessionId.get(sessionId) ?? []).map((file) => file.id));
    const arrivedFiles = isReconnect ? shownFilesOf(sessionId).filter((file) => !knownIds.has(file.id)) : [];
    paintShownTabs(sessionId);
    applyArrivedFiles(sessionId, arrivedFiles);
  }
}
