import type { ShownFile } from '#shared/contracts/session.ts';
import { el } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createSandboxedFrame } from './sandboxed-frame.ts';
import { shownFilesOf, shownThumbnailUrl } from './shown-files.ts';
import { BACK_ICON_PATH, createLineIcon } from './svg-dom.ts';

const MAX_WARM_PAGES = 3;
const KIND_LABELS: Record<ShownFile['kind'], string> = { image: 'Image', video: 'Video', page: 'Page' };

function shownFileUrl(sessionId: string, file: ShownFile): string {
  return `/shown/${encodeURIComponent(sessionId)}/${encodeURIComponent(file.id)}`;
}

function displayTitleOf(file: ShownFile): string {
  return file.pageTitle ?? file.name;
}

function buildStageMedia(sessionId: string, file: ShownFile): HTMLElement {
  const url = shownFileUrl(sessionId, file);
  if (file.kind === 'image') {
    const image = el('img', 'shown-stage-media');
    image.src = url;
    image.alt = file.caption ?? file.name;
    image.decoding = 'async';
    return image;
  }
  if (file.kind === 'video') {
    const video = el('video', 'shown-stage-media');
    video.src = url;
    video.preload = 'metadata';
    video.controls = true;
    video.playsInline = true;
    return video;
  }
  return createSandboxedFrame({ source: { kind: 'url', url }, className: 'shown-stage-frame', title: displayTitleOf(file), allowsScripts: true });
}

function buildTileFace(sessionId: string, file: ShownFile): HTMLElement {
  const thumbnailUrl = shownThumbnailUrl(sessionId, file);
  if (thumbnailUrl) {
    const thumbnail = el('img', 'shown-thumb-media');
    thumbnail.src = thumbnailUrl;
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    thumbnail.decoding = 'async';
    return thumbnail;
  }
  const label = el('span', 'shown-thumb-label');
  label.append(el('span', 'shown-page-kind', KIND_LABELS[file.kind]), el('span', 'shown-page-title', displayTitleOf(file)));
  return label;
}

function preDecodeImage(url: string): void {
  const image = new Image();
  image.src = url;
  void image.decode().catch(() => {});
}

function buildStepButton(label: string, className: string): HTMLButtonElement {
  const button = el('button', `shown-step ${className}`);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createLineIcon(BACK_ICON_PATH));
  return button;
}

export function createShownFace({ sessionId }: { sessionId: string }) {
  const face = el('section', 'shown-face');
  face.hidden = true;
  face.tabIndex = -1;
  face.setAttribute('aria-label', 'Shown files');
  const stage = el('div', 'shown-stage');
  const btnPrevious = buildStepButton('Previous file', 'shown-step-previous');
  const btnNext = buildStepButton('Next file', 'shown-step-next');
  const stageFrame = el('div', 'shown-stage-frame-wrap');
  stageFrame.append(stage, btnPrevious, btnNext);
  const caption = el('p', 'shown-caption');
  const meta = el('p', 'shown-meta');
  const position = el('span', 'shown-position');
  const btnOpenFullSize = el('button', 'plan-control shown-open-full-size', 'Open full size');
  btnOpenFullSize.type = 'button';
  const details = el('div', 'shown-details');
  const detailText = el('div', 'shown-detail-text');
  detailText.append(caption, meta);
  details.append(detailText, position, btnOpenFullSize);
  const strip = el('div', 'shown-strip');
  strip.setAttribute('aria-label', 'Shown files');
  face.append(stageFrame, details, strip);

  const tileByFileId = new Map<string, HTMLButtonElement>();
  const warmStageByFileId = new Map<string, HTMLElement>();
  let selectedFileId: string | null = null;

  function selectedFile(): ShownFile | null {
    const files = shownFilesOf(sessionId);
    return files.find((file) => file.id === selectedFileId) ?? files.at(-1) ?? null;
  }

  function buildTile(file: ShownFile): HTMLButtonElement {
    const tile = el('button', 'shown-thumb');
    tile.type = 'button';
    tile.title = file.caption ?? displayTitleOf(file);
    tile.setAttribute('aria-label', displayTitleOf(file));
    tile.append(buildTileFace(sessionId, file));
    tile.addEventListener('click', () => select(file.id));
    return tile;
  }

  function syncStrip(files: readonly ShownFile[]): void {
    const keptIds = new Set(files.map((file) => file.id));
    for (const [fileId, tile] of tileByFileId) {
      if (keptIds.has(fileId)) continue;
      tile.remove();
      tileByFileId.delete(fileId);
    }
    for (const file of files) {
      if (tileByFileId.has(file.id)) continue;
      const tile = buildTile(file);
      tileByFileId.set(file.id, tile);
      strip.append(tile);
    }
    strip.hidden = files.length < 2;
  }

  function revealTile(tile: HTMLElement | undefined): void {
    if (!tile) return;
    const tileStart = tile.offsetLeft - strip.offsetLeft;
    const tileEnd = tileStart + tile.offsetWidth;
    if (tileStart < strip.scrollLeft) {
      strip.scrollLeft = tileStart;
      return;
    }
    if (tileEnd > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tileEnd - strip.clientWidth;
  }

  function dropColdStages(files: readonly ShownFile[]): void {
    const keptIds = new Set(files.map((file) => file.id));
    for (const [fileId, media] of warmStageByFileId) {
      if (keptIds.has(fileId)) continue;
      media.remove();
      warmStageByFileId.delete(fileId);
    }
    const warmPageIds = [...warmStageByFileId.keys()].filter((fileId) => warmStageByFileId.get(fileId) instanceof HTMLIFrameElement);
    for (const fileId of warmPageIds.slice(0, Math.max(0, warmPageIds.length - MAX_WARM_PAGES))) {
      warmStageByFileId.get(fileId)?.remove();
      warmStageByFileId.delete(fileId);
    }
    for (const [fileId, media] of warmStageByFileId) {
      if (media instanceof HTMLIFrameElement || fileId === selectedFileId) continue;
      media.remove();
      warmStageByFileId.delete(fileId);
    }
  }

  function paintStage(file: ShownFile): void {
    const existing = warmStageByFileId.get(file.id);
    const media = existing ?? buildStageMedia(sessionId, file);
    warmStageByFileId.delete(file.id);
    warmStageByFileId.set(file.id, media);
    if (!existing) stage.append(media);
    for (const [fileId, other] of warmStageByFileId) other.hidden = fileId !== file.id;
    for (const sibling of stage.querySelectorAll('video')) if (sibling !== media) sibling.pause();
  }

  function warmNeighbours(files: readonly ShownFile[], index: number): void {
    for (const neighbour of [files[index - 1], files[index + 1]]) {
      if (neighbour?.kind === 'image') preDecodeImage(shownFileUrl(sessionId, neighbour));
    }
  }

  function paint(): void {
    const files = shownFilesOf(sessionId);
    syncStrip(files);
    const file = selectedFile();
    if (!file) return;
    selectedFileId = file.id;
    const index = files.indexOf(file);
    paintStage(file);
    dropColdStages(files);
    caption.textContent = file.caption ?? displayTitleOf(file);
    meta.textContent = `${file.name}, shown ${formatAgo(file.shownAt)}`;
    position.textContent = `${index + 1} of ${files.length}`;
    btnPrevious.disabled = index <= 0;
    btnNext.disabled = index >= files.length - 1;
    for (const [fileId, tile] of tileByFileId) tile.setAttribute('aria-current', String(fileId === file.id));
    revealTile(tileByFileId.get(file.id));
    warmNeighbours(files, index);
  }

  function step(offset: number): void {
    const files = shownFilesOf(sessionId);
    const file = selectedFile();
    if (!file) return;
    const target = files[files.indexOf(file) + offset];
    if (target) select(target.id);
  }

  function select(fileId: string): void {
    selectedFileId = fileId;
    paint();
  }

  btnPrevious.addEventListener('click', () => step(-1));
  btnNext.addEventListener('click', () => step(1));
  btnOpenFullSize.addEventListener('click', () => {
    const file = selectedFile();
    if (file) window.open(shownFileUrl(sessionId, file), '_blank', 'noopener');
  });
  face.addEventListener('keydown', (event) => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const offsetByKey: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    const offset = offsetByKey[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    step(offset);
  });

  return {
    el: face,
    show(fileId: string | null) {
      selectedFileId = fileId;
      face.hidden = false;
      paint();
      if (!face.contains(document.activeElement)) face.focus({ preventScroll: true });
    },
    hide() {
      face.hidden = true;
      for (const video of stage.querySelectorAll('video')) video.pause();
    },
    applyArrivals() {
      if (face.hidden) {
        syncStrip(shownFilesOf(sessionId));
        return;
      }
      paint();
    },
    select,
  };
}
