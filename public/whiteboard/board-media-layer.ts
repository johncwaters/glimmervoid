import { boardMediaOriginalFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { BoxMedia } from '#shared/contracts/whiteboard.ts';
import type { BoardLayout, LaidOutElement, LaidOutMedia, Rect } from '#shared/whiteboard-layout-core.ts';
import { pageMaskImage } from '#shared/whiteboard-svg-core.ts';
import type { PageOccluder } from '#shared/whiteboard-svg-core.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';

const VIEWPORT_WIDTH_PX_BY_KIND = { page: 1280, doc: 800 } as const;
const DOC_CARD_TEXT_MAX_CHARS = 16 * 1024;
const DOC_UNREAD_TEXT = 'This document could not be read.';
const OCCLUDER_REACH = 8;

type LiveMedia = LaidOutMedia & { kind: keyof typeof VIEWPORT_WIDTH_PX_BY_KIND };

interface PlacedMedia {
  identity: string;
  node: HTMLElement;
}

function isLiveMedia(media: LaidOutMedia | null): media is LiveMedia {
  return media?.kind === 'page' || media?.kind === 'doc';
}

function identityOf(media: LiveMedia): string {
  return JSON.stringify([media.asset, media.mime, media.alt]);
}

function placeNode(node: HTMLElement, media: LiveMedia): void {
  node.style.left = `${media.x}px`;
  node.style.top = `${media.y}px`;
  node.style.width = `${media.width}px`;
  node.style.height = `${media.height}px`;
  const scaledContent = node.querySelector<HTMLElement>('.wb-media-page, .wb-media-doc');
  if (!scaledContent) return;
  const viewportWidth = VIEWPORT_WIDTH_PX_BY_KIND[media.kind];
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

function docCardOf(media: LiveMedia): HTMLElement {
  const card = el('div', 'wb-media-doc');
  card.inert = true;
  void fetchBoardDocText(media).then((docText) => {
    card.replaceChildren(docText === null ? el('p', 'wb-media-doc-unread', DOC_UNREAD_TEXT) : renderedDocOpening(docText));
  });
  return card;
}

function pageFrameOf(media: LiveMedia): HTMLElement {
  const frame = createSandboxedFrame({ source: { kind: 'url', url: `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}` }, className: 'wb-media-page', title: media.alt || 'page', allowsScripts: true });
  frame.tabIndex = -1;
  return frame;
}

function placedNodeOf(boxId: string, media: LiveMedia): HTMLElement {
  const node = el('div', 'wb-media');
  node.dataset.boxId = boxId;
  node.dataset.mediaKind = media.kind;
  node.append(media.kind === 'doc' ? docCardOf(media) : pageFrameOf(media));
  placeNode(node, media);
  return node;
}

export function createBoardMediaLayer() {
  const layer = el('div', 'wb-media-layer');
  const placedByBoxId = new Map<string, PlacedMedia>();

  function sync(layout: BoardLayout, elementIdsInPaintOrder: readonly string[]): void {
    const seenBoxIds = new Set<string>();
    const elementById = new Map(layout.elements.map((element) => [element.id, element]));
    const elementsInPaintOrder = elementIdsInPaintOrder.flatMap((elementId) => elementById.get(elementId) ?? []);
    for (const element of layout.elements) {
      if (element.kind !== 'box' || !isLiveMedia(element.media)) continue;
      seenBoxIds.add(element.id);
      const identity = identityOf(element.media);
      const placed = placedByBoxId.get(element.id);
      const maskImage = pageMaskImage(element.media, occludersAbove(element.id, element.media, elementsInPaintOrder));
      if (placed?.identity === identity) {
        placeNode(placed.node, element.media);
        applyMask(placed.node, maskImage);
        continue;
      }
      const node = placedNodeOf(element.id, element.media);
      applyMask(node, maskImage);
      if (placed) placed.node.replaceWith(node);
      if (!placed) layer.append(node);
      placedByBoxId.set(element.id, { identity, node });
    }
    for (const [boxId, placed] of placedByBoxId) {
      if (seenBoxIds.has(boxId)) continue;
      placed.node.remove();
      placedByBoxId.delete(boxId);
    }
  }

  function clear(): void {
    for (const placed of placedByBoxId.values()) placed.node.remove();
    placedByBoxId.clear();
  }

  return { element: layer, sync, clear };
}

export type BoardMediaLayer = ReturnType<typeof createBoardMediaLayer>;
