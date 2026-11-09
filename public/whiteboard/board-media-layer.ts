import { BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_PARAMS_MESSAGE, BoardPageGesture, BOARD_PAGE_THEME_MESSAGE, BOARD_PAGE_TUNED_QUERY, boardMediaOriginalFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { BoxMedia, DialValue } from '#shared/contracts/whiteboard.ts';
import { DEVICE_CATALOG } from '#shared/whiteboard-devices.ts';
import type { BoardLayout, LaidOutBox, LaidOutElement, LaidOutMedia, Rect } from '#shared/whiteboard-layout-core.ts';
import { pageMaskImage } from '#shared/whiteboard-svg-core.ts';
import type { PageOccluder } from '#shared/whiteboard-svg-core.ts';
import { el } from '../dom-helpers.ts';
import { WHEEL_ZOOM_STEP } from './board-edit.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';

const VIEWPORT_WIDTH_PX_BY_KIND = { page: 1280, doc: 800 } as const;
const DOC_CARD_TEXT_MAX_CHARS = 16 * 1024;
const DOC_UNREAD_TEXT = 'This document could not be read.';
const OCCLUDER_REACH = 8;
const PAGE_THEME_VARIABLE_BY_COLOR = { background: '--bg-card', text: '--text', accent: '--accent', line: '--border' } as const;

type PageMedia = LaidOutMedia & { kind: keyof typeof VIEWPORT_WIDTH_PX_BY_KIND };

interface PlacedPage {
  identity: string;
  node: HTMLElement;
  frame: HTMLIFrameElement | null;
  postedDialValues: string;
}

function isPageMedia(media: LaidOutMedia | null): media is PageMedia {
  return media?.kind === 'page' || media?.kind === 'doc';
}

function identityOf(media: PageMedia): string {
  return JSON.stringify([media.asset, media.mime, media.alt]);
}

function viewportWidthOf(box: Pick<LaidOutBox, 'device'>, media: PageMedia): number {
  return box.device ? DEVICE_CATALOG[box.device.name].screen.width : VIEWPORT_WIDTH_PX_BY_KIND[media.kind];
}

function placeNode(node: HTMLElement, media: PageMedia, viewportWidth: number): void {
  node.style.left = `${media.x}px`;
  node.style.top = `${media.y}px`;
  node.style.width = `${media.width}px`;
  node.style.height = `${media.height}px`;
  const scaledContent = node.querySelector<HTMLElement>('.wb-media-page, .wb-media-doc');
  if (!scaledContent) return;
  const scale = media.width / viewportWidth;
  scaledContent.style.width = `${viewportWidth}px`;
  scaledContent.style.height = `${media.height / scale}px`;
  scaledContent.style.transform = `scale(${scale})`;
}

function isOccluder(element: LaidOutElement): element is PageOccluder {
  return element.kind !== 'wire' && element.kind !== 'frame';
}

function overlaps(page: Rect, element: Rect): boolean {
  return element.x - OCCLUDER_REACH < page.x + page.width && element.x + element.width + OCCLUDER_REACH > page.x
    && element.y - OCCLUDER_REACH < page.y + page.height && element.y + element.height + OCCLUDER_REACH > page.y;
}

function occludersAbove(pageBoxId: string, page: Rect, elementsInPaintOrder: readonly LaidOutElement[]): PageOccluder[] {
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

function docCardOf(media: PageMedia): HTMLElement {
  const card = el('div', 'wb-media-doc');
  card.inert = true;
  void fetchBoardDocText(media).then((docText) => {
    card.replaceChildren(docText === null ? el('p', 'wb-media-doc-unread', DOC_UNREAD_TEXT) : renderedDocOpening(docText));
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

function pageFrameOf(media: PageMedia): HTMLIFrameElement {
  const frame = createSandboxedFrame({ source: { kind: 'url', url: `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}?${BOARD_PAGE_TUNED_QUERY}` }, className: 'wb-media-page', title: media.alt || 'page', allowsScripts: true });
  frame.tabIndex = -1;
  return frame;
}

function placedPageOf(page: ShownPage, latestDialValues: () => Readonly<Record<string, DialValue>>): PlacedPage {
  const { boxId, media, identity, viewportWidth } = page;
  const node = el('div', 'wb-media');
  node.dataset.boxId = boxId;
  node.dataset.mediaKind = media.kind;
  if (media.kind === 'doc') {
    node.append(docCardOf(media));
    placeNode(node, media, viewportWidth);
    return { identity, node, frame: null, postedDialValues: '{}' };
  }
  const frame = pageFrameOf(media);
  node.append(frame);
  placeNode(node, media, viewportWidth);
  const placed = { identity, node, frame, postedDialValues: JSON.stringify(media.dialValues) };
  tunePageOnLoad(frame, node, () => {
    const dialValues = latestDialValues();
    placed.postedDialValues = JSON.stringify(dialValues);
    return dialValues;
  });
  return placed;
}

interface ShownPage {
  boxId: string;
  media: PageMedia;
  viewportWidth: number;
  identity: string;
  maskImage: string | null;
}

interface BoardMediaLayerOptions {
  onEscapeFromPage: () => void;
  onZoomFromPage: (clientX: number, clientY: number, viewWidthFactor: number) => void;
  onPanFromPage: (deltaX: number, deltaY: number) => void;
}

function clampToSpan(delta: number, span: number): number {
  return Math.min(span, Math.max(-span, delta));
}

export function createBoardMediaLayer(options: BoardMediaLayerOptions) {
  const layer = el('div', 'wb-media-layer');
  const placedByBoxId = new Map<string, PlacedPage>();
  let shownPages: ShownPage[] = [];
  let liveArea: Rect | null = null;
  let interactiveBoxId: string | null = null;
  let pageListening: AbortController | null = null;

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
        placeNode(placed.node, page.media, page.viewportWidth);
        applyMask(placed.node, page.maskImage);
        postChangedDialValues(page, placed);
        continue;
      }
      const replacement = placedPageOf(page, () => latestDialValuesOf(page.boxId));
      applyMask(replacement.node, page.maskImage);
      markInteractive(page.boxId, replacement);
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

  function sync(layout: BoardLayout, elementIdsInPaintOrder: readonly string[]): void {
    const elementById = new Map(layout.elements.map((element) => [element.id, element]));
    const elementsInPaintOrder = elementIdsInPaintOrder.flatMap((elementId) => elementById.get(elementId) ?? []);
    shownPages = layout.elements.flatMap((element) => {
      if (element.kind !== 'box' || !isPageMedia(element.media)) return [];
      return [{ boxId: element.id, media: element.media, viewportWidth: viewportWidthOf(element, element.media), identity: identityOf(element.media), maskImage: pageMaskImage(element.media, occludersAbove(element.id, element.media, elementsInPaintOrder)) }];
    });
    placeLivePages();
  }

  function showArea(area: Rect): void {
    liveArea = area;
    placeLivePages();
  }

  function clear(): void {
    for (const placed of placedByBoxId.values()) placed.node.remove();
    placedByBoxId.clear();
    shownPages = [];
    setInteractiveBox(null);
  }

  return { element: layer, sync, showArea, clear, setInteractiveBox };
}

export type BoardMediaLayer = ReturnType<typeof createBoardMediaLayer>;
