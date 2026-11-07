import { boardMediaOriginalFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { BoardLayout, LaidOutElement, LaidOutMedia, Rect } from '#shared/whiteboard-layout-core.ts';
import { pageMaskImage } from '#shared/whiteboard-svg-core.ts';
import type { PageOccluder } from '#shared/whiteboard-svg-core.ts';
import { el } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';

const PAGE_VIEWPORT_WIDTH_PX = 1280;
const OCCLUDER_REACH = 8;

type PageMedia = LaidOutMedia & { kind: 'page' };

interface PlacedPage {
  identity: string;
  node: HTMLElement;
}

function isPageMedia(media: LaidOutMedia | null): media is PageMedia {
  return media?.kind === 'page';
}

function identityOf(media: PageMedia): string {
  return JSON.stringify([media.asset, media.mime, media.alt]);
}

function placeNode(node: HTMLElement, media: PageMedia): void {
  node.style.left = `${media.x}px`;
  node.style.top = `${media.y}px`;
  node.style.width = `${media.width}px`;
  node.style.height = `${media.height}px`;
  const frame = node.querySelector<HTMLIFrameElement>('iframe.wb-media-page');
  if (!frame) return;
  const scale = media.width / PAGE_VIEWPORT_WIDTH_PX;
  frame.style.width = `${PAGE_VIEWPORT_WIDTH_PX}px`;
  frame.style.height = `${media.height / scale}px`;
  frame.style.transform = `scale(${scale})`;
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

function placedNodeOf(boxId: string, media: PageMedia): HTMLElement {
  const node = el('div', 'wb-media');
  node.dataset.boxId = boxId;
  node.dataset.mediaKind = media.kind;
  const frame = createSandboxedFrame({ source: { kind: 'url', url: `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}` }, className: 'wb-media-page', title: media.alt || 'page', allowsScripts: true });
  frame.tabIndex = -1;
  node.append(frame);
  placeNode(node, media);
  return node;
}

interface ShownPage {
  boxId: string;
  media: PageMedia;
  identity: string;
  maskImage: string | null;
}

export function createBoardMediaLayer() {
  const layer = el('div', 'wb-media-layer');
  const placedByBoxId = new Map<string, PlacedPage>();
  let shownPages: ShownPage[] = [];
  let liveArea: Rect | null = null;

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
        placeNode(placed.node, page.media);
        applyMask(placed.node, page.maskImage);
        continue;
      }
      const node = placedNodeOf(page.boxId, page.media);
      applyMask(node, page.maskImage);
      if (placed) placed.node.replaceWith(node);
      if (!placed) layer.append(node);
      placedByBoxId.set(page.boxId, { identity: page.identity, node });
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
      return [{ boxId: element.id, media: element.media, identity: identityOf(element.media), maskImage: pageMaskImage(element.media, occludersAbove(element.id, element.media, elementsInPaintOrder)) }];
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
  }

  return { element: layer, sync, showArea, clear };
}

export type BoardMediaLayer = ReturnType<typeof createBoardMediaLayer>;
