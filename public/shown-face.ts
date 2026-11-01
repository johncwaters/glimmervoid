import type { ShownFile } from '#shared/contracts/session.ts';
import { el } from './dom-helpers.ts';
import { formatAgo } from './poll-ago.ts';
import { createSandboxedFrame } from './sandboxed-frame.ts';
import { shownFilesOf, shownThumbnailUrl } from './shown-files.ts';
import { BACK_ICON_PATH, createLineIcon } from './svg-dom.ts';
import {
  BUTTON_ZOOM_FACTOR, FIT_VIEW, MAX_ZOOM_SCALE, isZoomedIn, panZoomView, pinchZoomView, toggledZoomView, wheelZoomScale, zoomPercentText, zoomViewAround,
} from './shown-zoom-core.ts';
import type { ZoomBounds, ZoomPoint, ZoomView } from './shown-zoom-core.ts';

const MAX_WARM_PAGES = 3;
const PAN_THRESHOLD_PX = 6;
const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_REACH_PX = 30;
const WHEEL_LINE_HEIGHT_PX = 16;
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
    image.draggable = false;
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

type ZoomableMedia = HTMLImageElement | HTMLVideoElement;
type PageZoomCommand = 'in' | 'out' | 'fit' | 'report';
const PAGE_ZOOM_MESSAGE_KEY = 'glimmervoidShownZoom';
type StageGesture =
  | { kind: 'pinch'; startView: ZoomView; startMidpoint: ZoomPoint; startDistance: number }
  | { kind: 'pan'; pointerId: number; origin: ZoomPoint; last: ZoomPoint; isPanning: boolean };

function isZoomableMedia(media: HTMLElement | null | undefined): media is ZoomableMedia {
  return media instanceof HTMLImageElement || media instanceof HTMLVideoElement;
}

function postPageZoom(frame: HTMLIFrameElement, command: PageZoomCommand): void {
  frame.contentWindow?.postMessage({ [PAGE_ZOOM_MESSAGE_KEY]: command }, '*');
}

function reportedPageZoomScaleOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null || !(PAGE_ZOOM_MESSAGE_KEY in data)) return null;
  const reportedScale: unknown = Reflect.get(data, PAGE_ZOOM_MESSAGE_KEY);
  if (typeof reportedScale !== 'number' || !Number.isFinite(reportedScale)) return null;
  return reportedScale;
}

function gestureScaleOf(event: Event): number | null {
  if (!('scale' in event) || typeof event.scale !== 'number') return null;
  return event.scale;
}

function gesturePointOf(event: Event): ZoomPoint | null {
  if (!('clientX' in event) || !('clientY' in event)) return null;
  if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return null;
  return { x: event.clientX, y: event.clientY };
}

function midpointOf(points: readonly ZoomPoint[]): ZoomPoint {
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}

function distanceBetween(points: readonly ZoomPoint[]): number {
  const [first, second] = points;
  if (!first || !second) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function buildZoomButton(text: string, label: string): HTMLButtonElement {
  const button = el('button', 'plan-control shown-zoom-control', text);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
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
  const btnZoomOut = buildZoomButton('-', 'Zoom out');
  const btnZoomFit = buildZoomButton('Fit', 'Fit to stage');
  const btnZoomIn = buildZoomButton('+', 'Zoom in');
  const zoomPercent = el('span', 'shown-zoom-percent');
  zoomPercent.setAttribute('aria-live', 'polite');
  const zoomControls = el('div', 'shown-zoom-controls');
  zoomControls.append(btnZoomOut, btnZoomFit, btnZoomIn, zoomPercent);
  const details = el('div', 'shown-details');
  const detailText = el('div', 'shown-detail-text');
  detailText.append(caption, meta);
  details.append(detailText, zoomControls, position, btnOpenFullSize);
  const strip = el('div', 'shown-strip');
  strip.setAttribute('aria-label', 'Shown files');
  face.append(stageFrame, details, strip);

  const tileByFileId = new Map<string, HTMLButtonElement>();
  const warmStageByFileId = new Map<string, HTMLElement>();
  let selectedFileId: string | null = null;
  let zoomedFileId: string | null = null;
  let zoomView: ZoomView = FIT_VIEW;
  let stageGesture: StageGesture | null = null;
  let lastTap: { at: number; point: ZoomPoint } | null = null;
  let lastPointerType = 'mouse';
  let safariGestureStartView: ZoomView | null = null;
  const activePointers = new Map<number, ZoomPoint>();
  const pageFramesWithLiveBridge = new WeakSet<HTMLIFrameElement>();

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
    if (!existing && media instanceof HTMLIFrameElement) media.addEventListener('load', () => postPageZoom(media, 'report'));
    if (!existing) stage.append(media);
    for (const [fileId, other] of warmStageByFileId) other.hidden = fileId !== file.id;
    for (const sibling of stage.querySelectorAll('video')) if (sibling !== media) sibling.pause();
  }

  function shownMedia(): HTMLElement | null {
    if (!selectedFileId) return null;
    return warmStageByFileId.get(selectedFileId) ?? null;
  }

  function zoomBoundsOf(media: HTMLElement): ZoomBounds {
    return { media: { width: media.offsetWidth, height: media.offsetHeight }, stage: { width: stage.clientWidth, height: stage.clientHeight } };
  }

  function focalFromStageCenter(point: ZoomPoint): ZoomPoint {
    const stageRect = stage.getBoundingClientRect();
    return { x: point.x - stageRect.left - stageRect.width / 2, y: point.y - stageRect.top - stageRect.height / 2 };
  }

  function syncZoomControls(): void {
    const media = shownMedia();
    zoomControls.hidden = !media || (media instanceof HTMLIFrameElement && !pageFramesWithLiveBridge.has(media));
    zoomPercent.textContent = zoomPercentText(zoomView.scale);
    btnZoomOut.disabled = !isZoomedIn(zoomView.scale);
    btnZoomFit.disabled = !isZoomedIn(zoomView.scale);
    btnZoomIn.disabled = zoomView.scale >= MAX_ZOOM_SCALE;
  }

  function applyZoom(nextView: ZoomView): void {
    zoomView = nextView;
    const media = shownMedia();
    if (isZoomableMedia(media)) media.style.transform = isZoomedIn(zoomView.scale) ? `translate(${zoomView.offsetX}px, ${zoomView.offsetY}px) scale(${zoomView.scale})` : '';
    stage.classList.toggle('is-zoomed', isZoomedIn(zoomView.scale));
    syncZoomControls();
  }

  function sendPageZoom(command: PageZoomCommand): boolean {
    const media = shownMedia();
    if (!(media instanceof HTMLIFrameElement)) return false;
    postPageZoom(media, command);
    return true;
  }

  function onPageZoomReport(event: MessageEvent): void {
    const media = shownMedia();
    if (!(media instanceof HTMLIFrameElement) || event.source !== media.contentWindow) return;
    const reportedScale = reportedPageZoomScaleOf(event.data);
    if (reportedScale === null) return;
    pageFramesWithLiveBridge.add(media);
    applyZoom({ scale: reportedScale, offsetX: 0, offsetY: 0 });
  }

  function zoomAroundFocal(targetScale: number, focalFromCenter: ZoomPoint): void {
    const media = shownMedia();
    if (!isZoomableMedia(media)) return;
    applyZoom(zoomViewAround(zoomView, targetScale, focalFromCenter, zoomBoundsOf(media)));
  }

  function toggleZoomAt(point: ZoomPoint): void {
    const media = shownMedia();
    if (!(media instanceof HTMLImageElement)) return;
    applyZoom(toggledZoomView(zoomView, focalFromStageCenter(point), zoomBoundsOf(media)));
  }

  function resetZoomForFile(fileId: string): void {
    if (zoomedFileId === fileId) return;
    zoomedFileId = fileId;
    for (const media of warmStageByFileId.values()) if (isZoomableMedia(media)) media.style.transform = '';
    stageGesture = null;
    activePointers.clear();
    sendPageZoom('fit');
    sendPageZoom('report');
    applyZoom(FIT_VIEW);
  }

  function startStageGesture(): void {
    const points = [...activePointers.values()];
    if (points.length >= 2) {
      stageGesture = { kind: 'pinch', startView: zoomView, startMidpoint: focalFromStageCenter(midpointOf(points)), startDistance: distanceBetween(points) };
      return;
    }
    const [pointerId, point] = [...activePointers.entries()][0] ?? [];
    if (pointerId === undefined || !point) return;
    stageGesture = { kind: 'pan', pointerId, origin: point, last: point, isPanning: false };
  }

  function onStagePointerDown(event: PointerEvent): void {
    if (!isZoomableMedia(shownMedia())) return;
    if (event.target instanceof Element && event.target.closest('.shown-step')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    lastPointerType = event.pointerType;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2) for (const pointerId of activePointers.keys()) stage.setPointerCapture(pointerId);
    startStageGesture();
  }

  function onStagePointerMove(event: PointerEvent): void {
    if (!activePointers.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    activePointers.set(event.pointerId, point);
    const media = shownMedia();
    if (!isZoomableMedia(media) || !stageGesture) return;
    if (stageGesture.kind === 'pinch') {
      const points = [...activePointers.values()];
      applyZoom(pinchZoomView({ ...stageGesture, midpoint: focalFromStageCenter(midpointOf(points)), distance: distanceBetween(points), bounds: zoomBoundsOf(media) }));
      return;
    }
    if (stageGesture.pointerId !== event.pointerId || !isZoomedIn(zoomView.scale)) return;
    const isPastThreshold = Math.hypot(point.x - stageGesture.origin.x, point.y - stageGesture.origin.y) >= PAN_THRESHOLD_PX;
    if (!stageGesture.isPanning && !isPastThreshold) return;
    if (!stageGesture.isPanning) stage.setPointerCapture(event.pointerId);
    stageGesture.isPanning = true;
    applyZoom(panZoomView(zoomView, point.x - stageGesture.last.x, point.y - stageGesture.last.y, zoomBoundsOf(media)));
    stageGesture.last = point;
  }

  function swallowNextClick(): void {
    stage.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, once: true });
  }

  function noteTouchTap(event: PointerEvent): void {
    const point = { x: event.clientX, y: event.clientY };
    const previousTap = lastTap;
    lastTap = { at: event.timeStamp, point };
    if (!previousTap) return;
    const isQuickEnough = event.timeStamp - previousTap.at <= DOUBLE_TAP_WINDOW_MS;
    const isCloseEnough = Math.hypot(point.x - previousTap.point.x, point.y - previousTap.point.y) <= DOUBLE_TAP_REACH_PX;
    if (!isQuickEnough || !isCloseEnough) return;
    lastTap = null;
    toggleZoomAt(point);
  }

  function onStagePointerEnd(event: PointerEvent): void {
    if (!activePointers.delete(event.pointerId)) return;
    const finished = stageGesture;
    stageGesture = null;
    if (finished?.kind === 'pinch') {
      lastTap = null;
      if (activePointers.size > 0) startStageGesture();
      return;
    }
    if (finished?.kind === 'pan' && finished.isPanning) {
      lastTap = null;
      if (event.pointerType !== 'touch') swallowNextClick();
      return;
    }
    if (event.type === 'pointerup' && event.pointerType === 'touch') noteTouchTap(event);
  }

  function onStageWheel(event: WheelEvent): void {
    const media = shownMedia();
    if (!isZoomableMedia(media)) return;
    const pixelsPerUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_HEIGHT_PX : 1;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomAroundFocal(wheelZoomScale(zoomView.scale, event.deltaY * pixelsPerUnit), focalFromStageCenter({ x: event.clientX, y: event.clientY }));
      return;
    }
    if (!isZoomedIn(zoomView.scale)) return;
    event.preventDefault();
    applyZoom(panZoomView(zoomView, -event.deltaX * pixelsPerUnit, -event.deltaY * pixelsPerUnit, zoomBoundsOf(media)));
  }

  function onSafariGestureStart(event: Event): void {
    if (!isZoomableMedia(shownMedia())) return;
    event.preventDefault();
    safariGestureStartView = zoomView;
  }

  function onSafariGestureChange(event: Event): void {
    if (!isZoomableMedia(shownMedia())) return;
    event.preventDefault();
    const gestureScale = gestureScaleOf(event);
    if (activePointers.size > 0 || !safariGestureStartView || gestureScale === null) return;
    const gesturePoint = gesturePointOf(event);
    const focalPoint = gesturePoint ? focalFromStageCenter(gesturePoint) : { x: 0, y: 0 };
    zoomView = safariGestureStartView;
    zoomAroundFocal(safariGestureStartView.scale * gestureScale, focalPoint);
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
    resetZoomForFile(file.id);
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

  btnZoomOut.addEventListener('click', () => {
    if (sendPageZoom('out')) return;
    zoomAroundFocal(zoomView.scale / BUTTON_ZOOM_FACTOR, { x: 0, y: 0 });
  });
  btnZoomIn.addEventListener('click', () => {
    if (sendPageZoom('in')) return;
    zoomAroundFocal(zoomView.scale * BUTTON_ZOOM_FACTOR, { x: 0, y: 0 });
  });
  btnZoomFit.addEventListener('click', () => {
    if (sendPageZoom('fit')) return;
    applyZoom(FIT_VIEW);
  });
  stage.addEventListener('pointerdown', onStagePointerDown);
  stage.addEventListener('pointermove', onStagePointerMove);
  stage.addEventListener('pointerup', onStagePointerEnd);
  stage.addEventListener('pointercancel', onStagePointerEnd);
  stage.addEventListener('wheel', onStageWheel, { passive: false });
  stage.addEventListener('dblclick', (event) => {
    if (lastPointerType === 'touch') return;
    toggleZoomAt({ x: event.clientX, y: event.clientY });
  });
  stage.addEventListener('gesturestart', onSafariGestureStart);
  stage.addEventListener('gesturechange', onSafariGestureChange);
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
      window.addEventListener('message', onPageZoomReport);
      paint();
      if (!face.contains(document.activeElement)) face.focus({ preventScroll: true });
    },
    hide() {
      face.hidden = true;
      zoomedFileId = null;
      window.removeEventListener('message', onPageZoomReport);
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
