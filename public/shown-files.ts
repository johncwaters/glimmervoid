import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { SHOWN_FILES_KEPT_PER_SESSION } from '#shared/contracts/session.ts';
import type { ShownFile } from '#shared/contracts/session.ts';
import { el } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { findSessionUi } from './session-card/card-registry.ts';
import { applyDialogAria, createModalOverlay } from './session-card/modal.ts';

interface OpenLightbox {
  sessionId: string;
  selectedFileId: string;
  title: HTMLElement;
  stage: HTMLElement;
  details: HTMLElement;
  strip: HTMLElement;
  btnOpenFullSize: HTMLButtonElement;
  close: () => void;
}

type ShownFilesChangedListener = (sessionId: string, files: readonly ShownFile[]) => void;

const shownFilesBySessionId = new Map<string, ShownFile[]>();
const sessionIdsWithUnopenedFiles = new Set<string>();
const changedListeners: ShownFilesChangedListener[] = [];
let openLightbox: OpenLightbox | null = null;
let hasReceivedSnapshot = false;

function shownFilesOf(sessionId: string): ShownFile[] {
  return shownFilesBySessionId.get(sessionId) ?? [];
}

function hasShownFiles(sessionId: string): boolean {
  return shownFilesOf(sessionId).length > 0;
}

export function hasUnopenedShownFiles(sessionId: string): boolean {
  return sessionIdsWithUnopenedFiles.has(sessionId);
}

export function onShownFilesChanged(listener: ShownFilesChangedListener): void {
  changedListeners.push(listener);
}

export function paintShownButton(sessionId: string): void {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  ui.btnShown.classList.toggle('visible', hasShownFiles(sessionId));
  ui.shownUnopenedDot.hidden = !hasUnopenedShownFiles(sessionId);
}

function shownFileUrl(sessionId: string, file: ShownFile): string {
  return `/shown/${encodeURIComponent(sessionId)}/${encodeURIComponent(file.id)}`;
}

function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}

function displayTitleOf(file: ShownFile): string {
  return file.pageTitle ?? file.name;
}

function buildMedia(sessionId: string, file: ShownFile, isThumbnail: boolean): HTMLElement {
  const url = shownFileUrl(sessionId, file);
  if (file.kind === 'image') {
    const image = el('img', isThumbnail ? 'shown-thumb-media' : 'shown-stage-media');
    image.src = url;
    image.alt = file.caption ?? file.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }
  if (file.kind === 'video') {
    const video = el('video', isThumbnail ? 'shown-thumb-media' : 'shown-stage-media');
    video.src = url;
    video.preload = 'metadata';
    video.muted = isThumbnail;
    video.controls = !isThumbnail;
    video.playsInline = true;
    return video;
  }
  const page = el('div', isThumbnail ? 'shown-thumb-page' : 'shown-stage-page');
  page.append(el('span', 'shown-page-kind', 'HTML page'), el('span', 'shown-page-title', displayTitleOf(file)));
  if (isThumbnail) return page;
  const btnOpenPage = el('button', 'plan-control shown-open-page', 'Open page');
  btnOpenPage.type = 'button';
  btnOpenPage.addEventListener('click', () => openInNewTab(url));
  page.append(el('span', 'shown-page-name', file.name), btnOpenPage);
  return page;
}

function selectedFileOf(lightbox: OpenLightbox): ShownFile | null {
  const files = shownFilesOf(lightbox.sessionId);
  return files.find((file) => file.id === lightbox.selectedFileId) ?? files.at(-1) ?? null;
}

function paintStrip(lightbox: OpenLightbox, selectedFile: ShownFile): void {
  const newestFirst = [...shownFilesOf(lightbox.sessionId)].reverse();
  lightbox.strip.hidden = newestFirst.length < 2;
  lightbox.strip.replaceChildren(...newestFirst.map((file) => {
    const thumb = el('button', 'shown-thumb');
    thumb.type = 'button';
    thumb.title = file.caption ?? displayTitleOf(file);
    thumb.setAttribute('aria-label', displayTitleOf(file));
    thumb.setAttribute('aria-pressed', String(file.id === selectedFile.id));
    thumb.append(buildMedia(lightbox.sessionId, file, true));
    thumb.addEventListener('click', () => selectShownFile(lightbox, file.id));
    return thumb;
  }));
}

function paintLightbox(lightbox: OpenLightbox): void {
  const selectedFile = selectedFileOf(lightbox);
  if (!selectedFile) {
    lightbox.close();
    return;
  }
  lightbox.selectedFileId = selectedFile.id;
  lightbox.title.textContent = displayTitleOf(selectedFile);
  lightbox.stage.replaceChildren(buildMedia(lightbox.sessionId, selectedFile, false));
  const caption = selectedFile.caption ? [el('p', 'shown-caption', selectedFile.caption)] : [];
  lightbox.details.replaceChildren(...caption, el('p', 'shown-meta', `${selectedFile.name}, shown ${formatAgo(selectedFile.shownAt)}`));
  paintStrip(lightbox, selectedFile);
}

function selectShownFile(lightbox: OpenLightbox, fileId: string): void {
  lightbox.selectedFileId = fileId;
  paintLightbox(lightbox);
}

function markShownFilesOpened(sessionId: string): void {
  if (!sessionIdsWithUnopenedFiles.delete(sessionId)) return;
  paintShownButton(sessionId);
  for (const listener of changedListeners) listener(sessionId, []);
}

function buildToolbarButton(label: string, className: string): HTMLButtonElement {
  const button = el('button', `plan-control ${className}`, label);
  button.type = 'button';
  return button;
}

export function openShownLightbox(sessionId: string, fileId: string | null = null): void {
  const latestFile = shownFilesOf(sessionId).at(-1);
  if (!latestFile) return;
  openLightbox?.close();
  const modal = createModalOverlay({ dialogClass: 'shown-lightbox', closeOnBackdrop: false, onEscape: () => lightbox.close() });
  const titleId = `shown-lightbox-title-${sessionId}`;
  const title = el('h3', 'shown-lightbox-title');
  title.id = titleId;
  const btnOpenFullSize = buildToolbarButton('Open full size', 'shown-open-full-size');
  const btnClose = buildToolbarButton('Close', 'shown-close');
  const header = el('div', 'shown-lightbox-header');
  header.append(title, btnOpenFullSize, btnClose);
  const stage = el('div', 'shown-stage');
  const details = el('div', 'shown-details');
  const strip = el('div', 'shown-strip');
  strip.setAttribute('aria-label', 'Shown files');
  modal.dialog.append(header, stage, details, strip);
  applyDialogAria(modal.dialog, titleId);

  const lightbox: OpenLightbox = {
    sessionId, selectedFileId: fileId ?? latestFile.id, title, stage, details, strip, btnOpenFullSize,
    close: () => {
      if (openLightbox === lightbox) openLightbox = null;
      modal.close();
    },
  };
  openLightbox = lightbox;
  btnOpenFullSize.addEventListener('click', () => {
    const selectedFile = selectedFileOf(lightbox);
    if (selectedFile) openInNewTab(shownFileUrl(sessionId, selectedFile));
  });
  btnClose.addEventListener('click', () => lightbox.close());
  modal.overlay.addEventListener('click', (event) => {
    if (event.target === modal.overlay) lightbox.close();
  });
  paintLightbox(lightbox);
  markShownFilesOpened(sessionId);
}

function keepNewest(files: readonly ShownFile[]): ShownFile[] {
  return files.slice(-SHOWN_FILES_KEPT_PER_SESSION);
}

function applyArrivedFiles(sessionId: string, arrivedFiles: readonly ShownFile[]): void {
  if (arrivedFiles.length === 0) return;
  const isLightboxOpenOnSession = openLightbox?.sessionId === sessionId;
  if (!isLightboxOpenOnSession) sessionIdsWithUnopenedFiles.add(sessionId);
  paintShownButton(sessionId);
  if (isLightboxOpenOnSession && openLightbox) paintLightbox(openLightbox);
  for (const listener of changedListeners) listener(sessionId, arrivedFiles);
}

export function applySessionShown(message: ServerMessageOf<'session-shown'>): void {
  const knownIds = new Set(shownFilesOf(message.id).map((file) => file.id));
  const arrivedFiles = message.files.filter((file) => !knownIds.has(file.id));
  shownFilesBySessionId.set(message.id, keepNewest([...shownFilesOf(message.id), ...arrivedFiles]));
  applyArrivedFiles(message.id, arrivedFiles);
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
    if (openLightbox?.sessionId === sessionId) paintLightbox(openLightbox);
  }
}
