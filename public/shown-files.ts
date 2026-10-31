import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { SHOWN_FILES_KEPT_PER_SESSION } from '#shared/contracts/session.ts';
import type { ShownFile } from '#shared/contracts/session.ts';
import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { findSessionUi } from './session-card/card-registry.ts';

type ShownLightbox = typeof import('./shown-lightbox.ts');

type ShownFilesChangedListener = (sessionId: string, files: readonly ShownFile[]) => void;

const shownFilesBySessionId = new Map<string, ShownFile[]>();
const sessionIdsWithUnopenedFiles = new Set<string>();
const changedListeners: ShownFilesChangedListener[] = [];
const liveArrivalListeners: ShownFilesChangedListener[] = [];
let loadedLightbox: ShownLightbox | null = null;
let pendingLightboxLoad: Promise<ShownLightbox | null> | null = null;
let hasReceivedSnapshot = false;

export function shownFilesOf(sessionId: string): ShownFile[] {
  return shownFilesBySessionId.get(sessionId) ?? [];
}

function hasShownFiles(sessionId: string): boolean {
  return shownFilesOf(sessionId).length > 0;
}

export function hasUnopenedShownFiles(sessionId: string): boolean {
  return sessionIdsWithUnopenedFiles.has(sessionId);
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

export function paintShownButton(sessionId: string): void {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.btnShown.classList.toggle('visible', hasShownFiles(sessionId));
  ui.shownUnopenedDot.hidden = !hasUnopenedShownFiles(sessionId);
}

export function markShownFilesOpened(sessionId: string): void {
  if (!sessionIdsWithUnopenedFiles.delete(sessionId)) return;
  paintShownButton(sessionId);
  for (const listener of changedListeners) listener(sessionId, []);
}

function loadLightbox(): Promise<ShownLightbox | null> {
  pendingLightboxLoad ??= import('./shown-lightbox.ts').then(
    (lightbox) => {
      loadedLightbox = lightbox;
      return lightbox;
    },
    (error: unknown) => {
      pendingLightboxLoad = null;
      reportToServerLog('shown-files', `shown file viewer failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingLightboxLoad;
}

export function openShownLightbox(sessionId: string, fileId: string | null = null): void {
  if (!hasShownFiles(sessionId)) return;
  void loadLightbox().then((lightbox) => lightbox?.openShownLightbox(sessionId, fileId));
}

function keepNewest(files: readonly ShownFile[]): ShownFile[] {
  return files.slice(-SHOWN_FILES_KEPT_PER_SESSION);
}

function applyArrivedFiles(sessionId: string, arrivedFiles: readonly ShownFile[]): void {
  if (arrivedFiles.length === 0) return;
  const isLightboxOpenOnSession = loadedLightbox?.isLightboxOpenOn(sessionId) ?? false;
  if (!isLightboxOpenOnSession) sessionIdsWithUnopenedFiles.add(sessionId);
  paintShownButton(sessionId);
  if (isLightboxOpenOnSession) loadedLightbox?.repaintLightboxOn(sessionId);
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
    if (!hasShownFiles(sessionId)) sessionIdsWithUnopenedFiles.delete(sessionId);
    const knownIds = new Set((previousFilesBySessionId.get(sessionId) ?? []).map((file) => file.id));
    const arrivedFiles = isReconnect ? shownFilesOf(sessionId).filter((file) => !knownIds.has(file.id)) : [];
    paintShownButton(sessionId);
    applyArrivedFiles(sessionId, arrivedFiles);
    loadedLightbox?.repaintLightboxOn(sessionId);
  }
}
