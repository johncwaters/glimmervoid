import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { SHOWN_FILES_KEPT_PER_SESSION } from '#shared/contracts/session.ts';
import type { ShownFile } from '#shared/contracts/session.ts';
import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { reportSessionProblem } from './session-card/card-problems.ts';
import type { SessionPage, SessionPagePlacement } from './session-pages/session-pages.ts';
import { announceSessionPageChange, closeSessionPage, isSessionPageOpen, openSessionPage } from './session-pages/session-pages.ts';
import { IMAGE_ICON_PATH } from './svg-dom.ts';

type ShownFaceModule = typeof import('./shown-face.ts');
type ShownViewer = ReturnType<ShownFaceModule['createShownFace']>;

type ShownFilesChangedListener = (sessionId: string, files: readonly ShownFile[]) => void;

const PRELOAD_FALLBACK_DELAY_MS = 2000;
const SHOWN_PAGE_ID = 'shown';
const SHOWN_PAGE_TITLE = 'Files the agent showed you';

const shownFilesBySessionId = new Map<string, ShownFile[]>();
const unopenedCountBySessionId = new Map<string, number>();
const changedListeners: ShownFilesChangedListener[] = [];
const liveArrivalListeners: ShownFilesChangedListener[] = [];
let pendingFaceModuleLoad: Promise<ShownFaceModule | null> | null = null;
let hasReceivedSnapshot = false;
let viewer: ShownViewer | null = null;
let viewerSessionId: string | null = null;

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

function shownPageTitleFor(sessionId: string): string {
  const unopenedCount = unopenedShownCountOf(sessionId);
  return unopenedCount === 0 ? SHOWN_PAGE_TITLE : `${SHOWN_PAGE_TITLE}, ${unopenedCount} not opened yet`;
}

function markShownFilesOpened(sessionId: string): void {
  if (!unopenedCountBySessionId.delete(sessionId)) return;
  announceSessionPageChange(SHOWN_PAGE_ID, sessionId);
  for (const listener of changedListeners) listener(sessionId, []);
}

async function mountShownViewer(host: HTMLElement, sessionId: string, placement: SessionPagePlacement, fileId: string | null) {
  const faceModule = await loadShownFaceModule();
  if (!isSessionPageOpen(SHOWN_PAGE_ID, sessionId)) return;
  if (!faceModule) {
    reportSessionProblem(sessionId, 'The shown files view did not load. Open it again to retry.');
    closeSessionPage();
    return;
  }
  if (!viewer || viewerSessionId !== sessionId) {
    viewer?.el.remove();
    viewer = faceModule.createShownFace({ sessionId, onClose: closeSessionPage });
    viewerSessionId = sessionId;
  }
  viewer.el.dataset.placement = placement;
  host.append(viewer.el);
  viewer.show(fileId);
  markShownFilesOpened(sessionId);
}

function unmountShownViewer() {
  viewer?.hide();
  viewer?.el.remove();
}

export const shownPage: SessionPage = {
  id: SHOWN_PAGE_ID,
  label: 'Shown',
  iconPath: IMAGE_ICON_PATH,
  titleFor: shownPageTitleFor,
  isAvailableFor: hasShownFiles,
  hasUnreadFor: (sessionId) => unopenedShownCountOf(sessionId) > 0,
  mount(host, sessionId, { placement, target }) {
    void mountShownViewer(host, sessionId, placement, target);
  },
  unmount: unmountShownViewer,
  canStepBack: () => false,
  stepBack: () => {},
};

function loadShownFaceModule(): Promise<ShownFaceModule | null> {
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

export function openShownPage(sessionId: string, fileId: string | null = null): void {
  openSessionPage(SHOWN_PAGE_ID, sessionId, fileId);
}

function keepNewest(files: readonly ShownFile[]): ShownFile[] {
  return files.slice(-SHOWN_FILES_KEPT_PER_SESSION);
}

function applyArrivedFiles(sessionId: string, arrivedFiles: readonly ShownFile[]): void {
  if (viewerSessionId === sessionId) viewer?.applyArrivals();
  if (arrivedFiles.length === 0) return;
  if (!isSessionPageOpen(SHOWN_PAGE_ID, sessionId)) unopenedCountBySessionId.set(sessionId, unopenedShownCountOf(sessionId) + arrivedFiles.length);
  announceSessionPageChange(SHOWN_PAGE_ID, sessionId);
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
    announceSessionPageChange(SHOWN_PAGE_ID, sessionId);
    applyArrivedFiles(sessionId, arrivedFiles);
  }
}
