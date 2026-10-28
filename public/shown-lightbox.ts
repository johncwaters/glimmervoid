import type { ShownFile } from '#shared/contracts/session.ts';
import { el } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createSandboxedFrame } from './sandboxed-frame.ts';
import { applyDialogAria, createModalOverlay } from './session-card/modal.ts';
import { markShownFilesOpened, shownFilesOf } from './shown-files.ts';

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

let openLightbox: OpenLightbox | null = null;

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
  if (!isThumbnail) return createSandboxedFrame({ source: { kind: 'url', url }, className: 'shown-stage-frame', title: displayTitleOf(file), allowsScripts: true });
  const page = el('div', 'shown-thumb-page');
  page.append(el('span', 'shown-page-kind', 'HTML page'), el('span', 'shown-page-title', displayTitleOf(file)));
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
  if (lightbox.stage.dataset.fileId !== selectedFile.id) {
    lightbox.stage.replaceChildren(buildMedia(lightbox.sessionId, selectedFile, false));
    lightbox.stage.dataset.fileId = selectedFile.id;
  }
  const caption = selectedFile.caption ? [el('p', 'shown-caption', selectedFile.caption)] : [];
  lightbox.details.replaceChildren(...caption, el('p', 'shown-meta', `${selectedFile.name}, shown ${formatAgo(selectedFile.shownAt)}`));
  paintStrip(lightbox, selectedFile);
}

function selectShownFile(lightbox: OpenLightbox, fileId: string): void {
  lightbox.selectedFileId = fileId;
  paintLightbox(lightbox);
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

export function isLightboxOpenOn(sessionId: string): boolean {
  return openLightbox?.sessionId === sessionId;
}

export function repaintLightboxOn(sessionId: string): void {
  if (openLightbox?.sessionId === sessionId) paintLightbox(openLightbox);
}
