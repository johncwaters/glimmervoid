import { BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_PARAMS_MESSAGE, BOARD_PAGE_SCROLL_MESSAGE, BoardPageGesture, BoardPageScrolled, BOARD_PAGE_THEME_MESSAGE, BOARD_PAGE_TUNED_QUERY, boardMediaOriginalFilename, boardPagePath, boardSheetTextFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { BoxMedia, DialValue, LinkStateOfBox } from '#shared/contracts/whiteboard.ts';
import type { BoardBackdrop } from '#shared/contracts/whiteboard-tiles.ts';
import { DEVICE_CATALOG } from '#shared/whiteboard-devices.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutMedia, Rect } from '#shared/whiteboard-layout-core.ts';
import { isTransparentPageBox } from '#shared/whiteboard-shapes.ts';
import { pageMaskImage } from '#shared/whiteboard-svg-core.ts';
import type { PageOccluder, PageTurn } from '#shared/whiteboard-svg-core.ts';
import { rotatedBoundsOf } from '#shared/whiteboard-route-core.ts';
import { el } from '../dom-helpers.ts';
import { WHEEL_ZOOM_STEP } from './board-edit.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { routeWheel, settleReply } from './page-wheel-latch-core.ts';
import type { WheelLatch } from './page-wheel-latch-core.ts';
import { parseSheetText, sheetDelimiterOfMime } from '#shared/sheet-csv-core.ts';
import { emphasisSegmentsOf, screenplayLinesOf, screenplayPagesOf } from '../doc-editor/fountain-style-core.ts';

const VIEWPORT_WIDTH_PX_BY_KIND = { page: 1280, doc: 800, sheet: 960 } as const;
const SHEET_CARD_HEAD_BYTES = 32 * 1024;
const RANGE_NOT_SATISFIABLE_STATUS = 416;
const SHEET_CARD_MAX_ROWS = 40;
const SHEET_CARD_MAX_COLUMNS = 24;
const SHEET_UNREAD_TEXT = 'This sheet could not be read.';
const DOC_CARD_TEXT_MAX_CHARS = 16 * 1024;
const DOC_UNREAD_TEXT = 'This document could not be read.';
const OCCLUDER_REACH = 8;
const PAGE_THEME_VARIABLE_BY_COLOR = { background: '--bg-card', text: '--text', accent: '--accent', line: '--border' } as const;

type PageMedia = LaidOutMedia & { kind: keyof typeof VIEWPORT_WIDTH_PX_BY_KIND | 'video' };

interface PlacedPage {
  identity: string;
  node: HTMLElement;
  frame: HTMLIFrameElement | null;
  postedDialValues: string;
}

function isPageMedia(media: LaidOutMedia | null): media is PageMedia {
  return media?.kind === 'page' || media?.kind === 'doc' || media?.kind === 'sheet';
}

function liveMediaOf(box: LaidOutBox): PageMedia | null {
  if (isPageMedia(box.media)) return box.media;
  if (box.isAutoplay && box.media?.kind === 'video') return { ...box.media, kind: 'video' };
  return null;
}

function identityOf(media: PageMedia): string {
  return JSON.stringify([media.asset, media.mime, media.alt, media.kind === 'video' ? media.fit : null]);
}

function viewportWidthOf(box: Pick<LaidOutBox, 'device'>, media: PageMedia): number {
  if (media.kind === 'video') return media.width;
  return box.device ? DEVICE_CATALOG[box.device.name].screen.width : VIEWPORT_WIDTH_PX_BY_KIND[media.kind];
}

function backdropContentOf(media: BoardBackdrop): HTMLElement {
  if (media.kind === 'video') return autoplayVideoOf({ asset: media.asset, mime: media.mime, fit: 'fill' });
  if (media.kind === 'page') return pageFrameOf({ asset: media.asset, alt: '' });
  const image = el('img', 'wb-backdrop-image');
  image.alt = '';
  image.src = `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}`;
  return image;
}

function autoplayVideoOf(media: Pick<LaidOutMedia, 'asset' | 'mime' | 'fit'>): HTMLVideoElement {
  const video = Object.assign(el('video', 'wb-media-video'), { muted: true, defaultMuted: true, loop: true, playsInline: true, autoplay: true });
  video.style.objectFit = media.fit === 'fit' ? 'contain' : 'cover';
  video.src = `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}`;
  return video;
}

function placeNode(node: HTMLElement, media: PageMedia, viewportWidth: number, turn: PageTurn): void {
  node.style.transformOrigin = `${turn.pivot.x - media.x}px ${turn.pivot.y - media.y}px`;
  node.style.transform = turn.angle === 0 ? '' : `rotate(${turn.angle}deg)`;
  node.style.left = `${media.x}px`;
  node.style.top = `${media.y}px`;
  node.style.width = `${media.width}px`;
  node.style.height = `${media.height}px`;
  const scaledContent = node.querySelector<HTMLElement>('.wb-media-page, .wb-media-doc, .wb-media-sheet');
  if (!scaledContent) return;
  const scale = media.width / viewportWidth;
  scaledContent.style.width = `${viewportWidth}px`;
  scaledContent.style.height = `${media.height / scale}px`;
  scaledContent.style.transform = `scale(${scale})`;
}

function isOccluder(element: LaidOutElement): element is PageOccluder {
  return element.kind !== 'wire' && element.kind !== 'frame';
}

function overlaps(turnedPage: Rect, turnedElement: Rect): boolean {
  const page = rotatedBoundsOf(turnedPage);
  const element = rotatedBoundsOf(turnedElement);
  return element.x - OCCLUDER_REACH < page.x + page.width && element.x + element.width + OCCLUDER_REACH > page.x
    && element.y - OCCLUDER_REACH < page.y + page.height && element.y + element.height + OCCLUDER_REACH > page.y;
}

function occludersAbove(pageBoxId: string, page: Rect & { angle: number }, elementsInPaintOrder: readonly LaidOutElement[]): PageOccluder[] {
  const pagePaintIndex = elementsInPaintOrder.findIndex((element) => element.id === pageBoxId);
  return elementsInPaintOrder.slice(pagePaintIndex + 1).filter(isOccluder).filter((element) => overlaps(page, element));
}

function applyMask(node: HTMLElement, maskImage: string | null): void {
  const nextMaskImage = maskImage ?? '';
  if (node.style.maskImage === nextMaskImage) return;
  node.style.maskImage = nextMaskImage;
  node.style.setProperty('-webkit-mask-image', nextMaskImage);
}

export async function fetchBoardDocText(media: Pick<BoxMedia, 'asset' | 'mime'>): Promise<string | null> {
  const response = await fetch(`${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}`).catch(() => null);
  if (!response?.ok) return null;
  return response.text().catch(() => null);
}

export async function fetchBoardSheetText(media: Pick<BoxMedia, 'asset' | 'mime'>, sheetIndex: number): Promise<string | null> {
  const response = await fetch(`${WHITEBOARD_ASSET_ROUTE}/${boardSheetTextFilename(media, sheetIndex)}`).catch(() => null);
  if (!response?.ok) return null;
  const bytes = await response.arrayBuffer().catch(() => null);
  return bytes ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : null;
}

function openingOf(docText: string): string {
  if (docText.length <= DOC_CARD_TEXT_MAX_CHARS) return docText;
  const lastWholeLineEnd = docText.lastIndexOf('\n', DOC_CARD_TEXT_MAX_CHARS);
  return docText.slice(0, lastWholeLineEnd > 0 ? lastWholeLineEnd : DOC_CARD_TEXT_MAX_CHARS);
}

function renderedDocOpening(docText: string): HTMLElement {
  const rendered = renderPlanBlocks(parsePlanMarkdown(openingOf(docText)));
  for (const identified of rendered.querySelectorAll('[id]')) identified.removeAttribute('id');
  return rendered;
}

function emphasizedLineOf(text: string): HTMLElement {
  const line = el('div', 'wb-screenplay-line');
  for (const segment of emphasisSegmentsOf(text)) {
    const isPlain = !segment.isBold && !segment.isItalic && !segment.isUnderlined;
    if (isPlain) {
      line.append(segment.text);
      continue;
    }
    const span = el('span', 'wb-screenplay-emphasis', segment.text);
    span.dataset.bold = String(segment.isBold);
    span.dataset.italic = String(segment.isItalic);
    span.dataset.underlined = String(segment.isUnderlined);
    line.append(span);
  }
  return line;
}

function renderedScreenplayOpening(docText: string): HTMLElement {
  const script = el('div', 'wb-screenplay');
  for (const page of screenplayPagesOf(screenplayLinesOf(openingOf(docText)))) {
    const pageElement = el('div', 'wb-screenplay-page');
    pageElement.dataset.page = String(page.number);
    if (page.number >= 2) pageElement.append(el('div', 'wb-screenplay-page-number', `${page.number}.`));
    for (const row of page.rows) {
      const pageLine = emphasizedLineOf(row.text);
      pageLine.dataset.element = row.element;
      if (row.sceneNumber) pageLine.dataset.sceneNumber = row.sceneNumber;
      pageElement.append(pageLine);
    }
    script.append(pageElement);
  }
  return script;
}

function docCardOf(media: PageMedia): HTMLElement {
  const isScreenplay = media.mime === 'text/x-fountain';
  const card = el('div', isScreenplay ? 'wb-media-doc wb-media-screenplay' : 'wb-media-doc');
  card.inert = true;
  void fetchBoardDocText(media).then((docText) => {
    if (docText === null) {
      card.replaceChildren(el('p', 'wb-media-doc-unread', DOC_UNREAD_TEXT));
      return;
    }
    card.replaceChildren(isScreenplay ? renderedScreenplayOpening(docText) : renderedDocOpening(docText));
  });
  return card;
}

async function fetchSheetHead(media: Pick<BoxMedia, 'asset' | 'mime'>): Promise<{ text: string; isWhole: boolean } | null> {
  const response = await fetch(`${WHITEBOARD_ASSET_ROUTE}/${boardSheetTextFilename(media, 0)}`, { headers: { Range: `bytes=0-${SHEET_CARD_HEAD_BYTES - 1}` } }).catch(() => null);
  if (response?.status === RANGE_NOT_SATISFIABLE_STATUS) return { text: '', isWhole: true };
  if (!response?.ok) return null;
  const bytes = await response.arrayBuffer().catch(() => null);
  if (!bytes) return null;
  const isWhole = response.status !== 206 || bytes.byteLength < SHEET_CARD_HEAD_BYTES;
  return { text: new TextDecoder().decode(bytes), isWhole };
}

function sheetTableOf(headText: string, isWhole: boolean, mime: string): HTMLElement {
  const parsed = parseSheetText(headText, sheetDelimiterOfMime(mime), SHEET_CARD_MAX_ROWS + 1);
  const wholeRows = isWhole ? parsed.cells : parsed.cells.slice(0, -1);
  const table = el('table', 'wb-media-sheet-table');
  for (const [rowIndex, row] of wholeRows.slice(0, SHEET_CARD_MAX_ROWS).entries()) {
    const tableRow = table.appendChild(el('tr'));
    for (const cell of row.slice(0, SHEET_CARD_MAX_COLUMNS)) tableRow.append(el(rowIndex === 0 ? 'th' : 'td', undefined, cell));
  }
  return table;
}

function sheetCardOf(media: PageMedia): HTMLElement {
  const card = el('div', 'wb-media-sheet');
  card.inert = true;
  void fetchSheetHead(media).then((head) => {
    card.replaceChildren(head === null ? el('p', 'wb-media-doc-unread', SHEET_UNREAD_TEXT) : sheetTableOf(head.text, head.isWhole, media.mime));
  });
  return card;
}

function themeColorsOf(styleSource: Element): Record<string, string> {
  const style = getComputedStyle(styleSource);
  return Object.fromEntries(Object.entries(PAGE_THEME_VARIABLE_BY_COLOR).flatMap(([color, variable]) => {
    const value = style.getPropertyValue(variable).trim();
    return value ? [[color, value]] : [];
  }));
}

function postTheme(frame: HTMLIFrameElement, styleSource: Element): void {
  frame.contentWindow?.postMessage({ type: BOARD_PAGE_THEME_MESSAGE, colors: themeColorsOf(styleSource) }, '*');
}

const themeSourceByFrame = new Map<HTMLIFrameElement, Element>();
let isWatchingTheme = false;

function forgetDetachedFrames(): void {
  for (const frame of themeSourceByFrame.keys()) {
    if (!frame.isConnected) themeSourceByFrame.delete(frame);
  }
}

function watchThemeFor(frame: HTMLIFrameElement, styleSource: Element): void {
  forgetDetachedFrames();
  themeSourceByFrame.set(frame, styleSource);
  if (isWatchingTheme) return;
  isWatchingTheme = true;
  const themeWatcher = new MutationObserver(() => {
    forgetDetachedFrames();
    for (const [watchedFrame, watchedStyleSource] of themeSourceByFrame) postTheme(watchedFrame, watchedStyleSource);
  });
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
}

export function tunePageOnLoad(frame: HTMLIFrameElement, styleSource: Element, dialValues: () => Readonly<Record<string, DialValue>>): void {
  frame.addEventListener('load', () => {
    postTheme(frame, styleSource);
    postDialValues(frame, dialValues());
    watchThemeFor(frame, styleSource);
  });
}

function postDialValues(frame: HTMLIFrameElement, dialValues: Readonly<Record<string, DialValue>>): void {
  frame.contentWindow?.postMessage({ type: BOARD_PAGE_PARAMS_MESSAGE, values: dialValues }, '*');
}

function pageFrameOf(media: Pick<LaidOutMedia, 'asset' | 'alt'>): HTMLIFrameElement {
  const frame = createSandboxedFrame({ source: { kind: 'url', url: `${boardPagePath(media)}?${BOARD_PAGE_TUNED_QUERY}` }, className: 'wb-media-page', title: media.alt || 'page', allowsScripts: true });
  frame.tabIndex = -1;
  return frame;
}

const TEXT_CARD_BUILDER_BY_KIND: Readonly<Partial<Record<BoxMedia['kind'], (media: PageMedia) => HTMLElement>>> = { doc: docCardOf, sheet: sheetCardOf };

function placedPageOf(page: ShownPage, latestDialValues: () => Readonly<Record<string, DialValue>>): PlacedPage {
  const { boxId, media, identity, viewportWidth, turn } = page;
  const node = el('div', 'wb-media');
  node.dataset.boxId = boxId;
  node.dataset.mediaKind = media.kind;
  if (media.kind === 'video') {
    node.append(autoplayVideoOf(media));
    placeNode(node, media, viewportWidth, turn);
    return { identity, node, frame: null, postedDialValues: '{}' };
  }
  const textCardOf = TEXT_CARD_BUILDER_BY_KIND[media.kind];
  if (textCardOf) {
    node.append(textCardOf(media));
    placeNode(node, media, viewportWidth, turn);
    return { identity, node, frame: null, postedDialValues: '{}' };
  }
  const frame = pageFrameOf(media);
  node.append(frame);
  placeNode(node, media, viewportWidth, turn);
  const placed = { identity, node, frame, postedDialValues: JSON.stringify(media.dialValues) };
  tunePageOnLoad(frame, node, () => {
    const dialValues = latestDialValues();
    placed.postedDialValues = JSON.stringify(dialValues);
    return dialValues;
  });
  return placed;
}

function paintLinkChip(node: HTMLElement, linkState: LinkStateOfBox | undefined): void {
  const shownChip = node.querySelector<HTMLElement>('.wb-media-link-chip');
  if (!linkState) {
    shownChip?.remove();
    return;
  }
  const chip = shownChip ?? node.appendChild(el('span', 'wb-media-link-chip'));
  chip.textContent = linkState.text;
  chip.dataset.linkState = linkState.state;
}

interface ShownPage {
  boxId: string;
  media: PageMedia;
  turn: PageTurn;
  viewportWidth: number;
  identity: string;
  maskImage: string | null;
  isTransparent: boolean;
}

interface BoardMediaLayerOptions {
  onEscapeFromPage: () => void;
  onZoomFromPage: (clientX: number, clientY: number, viewWidthFactor: number) => void;
  onPanFromPage: (deltaX: number, deltaY: number) => void;
}

export interface BoardWheel {
  atMs: number;
  boxIdUnderPointer: string | null;
  boardPoint: { x: number; y: number };
  deltaX: number;
  deltaY: number;
  screenPixelsPerBoardUnit: number;
}

function pagePointOf(page: ShownPage, boardPoint: { x: number; y: number }): { x: number; y: number } {
  const radians = (-page.turn.angle * Math.PI) / 180;
  const offsetX = boardPoint.x - page.turn.pivot.x;
  const offsetY = boardPoint.y - page.turn.pivot.y;
  const unturnedX = page.turn.pivot.x + offsetX * Math.cos(radians) - offsetY * Math.sin(radians);
  const unturnedY = page.turn.pivot.y + offsetX * Math.sin(radians) + offsetY * Math.cos(radians);
  const pagePixelsPerBoardUnit = page.viewportWidth / page.media.width;
  return { x: (unturnedX - page.media.x) * pagePixelsPerBoardUnit, y: (unturnedY - page.media.y) * pagePixelsPerBoardUnit };
}

function clampToSpan(delta: number, span: number): number {
  return Math.min(span, Math.max(-span, delta));
}

export function createBoardMediaLayer(options: BoardMediaLayerOptions) {
  const layer = el('div', 'wb-media-layer');
  const backdrop = el('div', 'wb-backdrop');
  let shownBackdropIdentity: string | null = null;
  let latestBackdrop: BoardBackdrop | null = null;
  let backdropFrame: HTMLIFrameElement | null = null;
  let postedBackdropDialValues = '{}';
  const placedByBoxId = new Map<string, PlacedPage>();
  let shownPages: ShownPage[] = [];
  let liveArea: Rect | null = null;
  let interactiveBoxId: string | null = null;
  let pageListening: AbortController | null = null;
  let linkStateByBoxId = new Map<string, LinkStateOfBox>();
  let wheelLatch: WheelLatch = { state: 'idle' };

  window.addEventListener('message', (event) => {
    if (wheelLatch.state !== 'pending') return;
    const pendingBoxId = wheelLatch.boxId;
    const pendingFrame = placedByBoxId.get(pendingBoxId)?.frame;
    if (!pendingFrame || event.source !== pendingFrame.contentWindow) return;
    const reply = BoardPageScrolled.safeParse(event.data);
    if (!reply.success) return;
    const settled = settleReply(wheelLatch, pendingBoxId, reply.data.hasScrolled);
    wheelLatch = settled.latch;
    if (settled.boardPan) options.onPanFromPage(-settled.boardPan.deltaX, -settled.boardPan.deltaY);
  });

  function livePageFrameOf(boxId: string | null): { page: ShownPage; frame: HTMLIFrameElement } | null {
    if (boxId === null) return null;
    const frame = placedByBoxId.get(boxId)?.frame;
    const page = shownPages.find((shownPage) => shownPage.boxId === boxId);
    if (!frame || !page) return null;
    return { page, frame };
  }

  function takesWheel(wheel: BoardWheel): boolean {
    const pageUnderPointer = livePageFrameOf(wheel.boxIdUnderPointer);
    const routed = routeWheel(wheelLatch, { atMs: wheel.atMs, pageBoxIdUnderPointer: pageUnderPointer ? pageUnderPointer.page.boxId : null, deltaX: wheel.deltaX, deltaY: wheel.deltaY });
    wheelLatch = routed.latch;
    if (routed.heldBoardPan) options.onPanFromPage(-routed.heldBoardPan.deltaX, -routed.heldBoardPan.deltaY);
    if (routed.route.to === 'board') return false;
    const latchedPage = livePageFrameOf(routed.route.boxId);
    if (!latchedPage) return false;
    const pagePoint = pagePointOf(latchedPage.page, wheel.boardPoint);
    const pagePixelsPerScreenPixel = latchedPage.page.viewportWidth / latchedPage.page.media.width / wheel.screenPixelsPerBoardUnit;
    latchedPage.frame.contentWindow?.postMessage({ type: BOARD_PAGE_SCROLL_MESSAGE, pageX: pagePoint.x, pageY: pagePoint.y, deltaX: wheel.deltaX * pagePixelsPerScreenPixel, deltaY: wheel.deltaY * pagePixelsPerScreenPixel }, '*');
    return true;
  }

  function latestDialValuesOf(boxId: string): Readonly<Record<string, DialValue>> {
    return shownPages.find((page) => page.boxId === boxId)?.media.dialValues ?? {};
  }

  function markInteractive(boxId: string, placed: PlacedPage): void {
    const isInteractive = boxId === interactiveBoxId && placed.frame !== null;
    placed.node.classList.toggle('is-interactive', isInteractive);
    if (placed.frame) placed.frame.tabIndex = isInteractive ? 0 : -1;
  }

  function postChangedDialValues(page: ShownPage, placed: PlacedPage): void {
    const dialValuesText = JSON.stringify(page.media.dialValues);
    if (!placed.frame || placed.postedDialValues === dialValuesText) return;
    placed.postedDialValues = dialValuesText;
    postDialValues(placed.frame, page.media.dialValues);
  }

  function listenToInteractivePage(): void {
    pageListening?.abort();
    pageListening = null;
    if (interactiveBoxId === null) return;
    pageListening = new AbortController();
    window.addEventListener('message', (event) => {
      const interactiveFrame = interactiveBoxId === null ? null : placedByBoxId.get(interactiveBoxId)?.frame;
      if (!interactiveFrame || event.source !== interactiveFrame.contentWindow) return;
      if (event.data === BOARD_PAGE_ESCAPE_MESSAGE) {
        options.onEscapeFromPage();
        return;
      }
      const gesture = BoardPageGesture.safeParse(event.data);
      if (gesture.success) applyPageGestureToBoard(interactiveFrame, gesture.data);
    }, { signal: pageListening.signal });
  }

  function applyPageGestureToBoard(frame: HTMLIFrameElement, gesture: BoardPageGesture): void {
    const frameRect = frame.getBoundingClientRect();
    const frameScale = frame.offsetWidth > 0 ? frameRect.width / frame.offsetWidth : 1;
    const clientXOf = (pageX: number) => frameRect.left + pageX * frameScale;
    const clientYOf = (pageY: number) => frameRect.top + pageY * frameScale;
    switch (gesture.gesture) {
      case 'pinch':
        options.onZoomFromPage(clientXOf(gesture.centerX), clientYOf(gesture.centerY), 1 / gesture.scaleFactor);
        return;
      case 'pan':
        options.onPanFromPage(clampToSpan(gesture.deltaX, frameRect.width), clampToSpan(gesture.deltaY, frameRect.height));
        return;
      case 'wheel':
        if (!gesture.isZoom) return;
        options.onZoomFromPage(clientXOf(gesture.centerX), clientYOf(gesture.centerY), gesture.deltaY > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
        return;
      case 'doubleTap':
        return;
    }
  }

  function setInteractiveBox(boxId: string | null): void {
    if (boxId === interactiveBoxId) return;
    interactiveBoxId = boxId;
    for (const [placedBoxId, placed] of placedByBoxId) markInteractive(placedBoxId, placed);
    listenToInteractivePage();
  }

  function isLive(page: ShownPage): boolean {
    return liveArea !== null && overlaps(liveArea, page.media);
  }

  function placeLivePages(): void {
    const liveBoxIds = new Set<string>();
    for (const page of shownPages) {
      if (!isLive(page)) continue;
      liveBoxIds.add(page.boxId);
      const placed = placedByBoxId.get(page.boxId);
      if (placed?.identity === page.identity) {
        placeNode(placed.node, page.media, page.viewportWidth, page.turn);
        applyMask(placed.node, page.maskImage);
        placed.node.classList.toggle('is-transparent', page.isTransparent);
        postChangedDialValues(page, placed);
        paintLinkChip(placed.node, linkStateByBoxId.get(page.boxId));
        continue;
      }
      const replacement = placedPageOf(page, () => latestDialValuesOf(page.boxId));
      applyMask(replacement.node, page.maskImage);
      replacement.node.classList.toggle('is-transparent', page.isTransparent);
      markInteractive(page.boxId, replacement);
      paintLinkChip(replacement.node, linkStateByBoxId.get(page.boxId));
      if (placed) placed.node.replaceWith(replacement.node);
      if (!placed) layer.append(replacement.node);
      placedByBoxId.set(page.boxId, replacement);
    }
    for (const [boxId, placed] of placedByBoxId) {
      if (liveBoxIds.has(boxId)) continue;
      placed.node.remove();
      placedByBoxId.delete(boxId);
    }
  }

  function latestBackdropDialValues(): Readonly<Record<string, DialValue>> {
    const dialValues = latestBackdrop?.dialValues ?? {};
    postedBackdropDialValues = JSON.stringify(dialValues);
    return dialValues;
  }

  function replaceBackdrop(shown: BoardBackdrop | null, identity: string | null): void {
    shownBackdropIdentity = identity;
    backdropFrame = null;
    backdrop.replaceChildren();
    backdrop.classList.toggle('is-shown', shown !== null);
    if (!shown) return;
    const content = backdropContentOf(shown);
    backdrop.append(content);
    if (!(content instanceof HTMLIFrameElement)) return;
    backdropFrame = content;
    postedBackdropDialValues = JSON.stringify(shown.dialValues);
    tunePageOnLoad(content, backdrop, latestBackdropDialValues);
  }

  function showBackdrop(shown: BoardBackdrop | null): void {
    latestBackdrop = shown;
    const identity = shown ? JSON.stringify([shown.kind, shown.asset, shown.mime]) : null;
    if (identity !== shownBackdropIdentity) replaceBackdrop(shown, identity);
    if (!backdropFrame || !shown || JSON.stringify(shown.dialValues) === postedBackdropDialValues) return;
    postDialValues(backdropFrame, latestBackdropDialValues());
  }

  function sync(layout: BoardLayout, elementIdsInPaintOrder: readonly string[]): void {
    const elementById = new Map(layout.elements.map((element) => [element.id, element]));
    const elementsInPaintOrder = elementIdsInPaintOrder.flatMap((elementId) => elementById.get(elementId) ?? []);
    shownPages = layout.elements.flatMap((element) => {
      if (element.kind !== 'box') return [];
      const media = liveMediaOf(element);
      if (!media) return [];
      const turn = { angle: element.angle, pivot: { x: element.x + element.width / 2, y: element.y + element.height / 2 } };
      const occluders = occludersAbove(element.id, { x: element.x, y: element.y, width: element.width, height: element.height, angle: element.angle }, elementsInPaintOrder);
      return [{ boxId: element.id, media, turn, viewportWidth: viewportWidthOf(element, media), identity: identityOf(media), maskImage: pageMaskImage(media, occluders, turn), isTransparent: isTransparentPageBox(element) }];
    });
    placeLivePages();
  }

  function showArea(area: Rect): void {
    liveArea = area;
    placeLivePages();
  }

  function setLinkStates(linkStates: readonly LinkStateOfBox[]): void {
    linkStateByBoxId = new Map(linkStates.map((linkState) => [linkState.boxId, linkState]));
    placeLivePages();
  }

  function clear(): void {
    for (const placed of placedByBoxId.values()) placed.node.remove();
    placedByBoxId.clear();
    shownPages = [];
    showBackdrop(null);
    setInteractiveBox(null);
  }

  return { element: layer, backdrop, showBackdrop, sync, showArea, clear, setInteractiveBox, setLinkStates, takesWheel };
}

export type BoardMediaLayer = ReturnType<typeof createBoardMediaLayer>;
