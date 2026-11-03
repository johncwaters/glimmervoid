import { boardMediaOriginalFilename, WHITEBOARD_ASSET_ROUTE } from '#shared/contracts/whiteboard.ts';
import type { BoardLayout, LaidOutMedia } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { button } from '../ui/button.ts';

const PAGE_VIEWPORT_WIDTH_PX = 1280;
const ACTIVATE_LABEL_BY_KIND = { video: 'play', page: 'use page' } as const;

interface BoardMediaLayerOptions {
  viewport: HTMLElement;
  boardHost: HTMLElement;
  onOpenFullSize: (boxId: string, alt: string) => void;
}

type LiveMedia = LaidOutMedia & { kind: keyof typeof ACTIVATE_LABEL_BY_KIND };

interface PlacedMedia {
  identity: string;
  node: HTMLElement;
  media: LiveMedia;
}

function isLiveMedia(media: LaidOutMedia | null): media is LiveMedia {
  return media?.kind === 'video' || media?.kind === 'page';
}

function originalHrefOf(media: LaidOutMedia): string {
  return `${WHITEBOARD_ASSET_ROUTE}/${boardMediaOriginalFilename(media)}`;
}

function identityOf(media: LiveMedia): string {
  return JSON.stringify([media.kind, media.asset, media.mime, media.alt]);
}

function placeNode(node: HTMLElement, media: LiveMedia): void {
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

function pageFrameOf(media: LiveMedia): HTMLIFrameElement {
  const frame = createSandboxedFrame({ source: { kind: 'url', url: originalHrefOf(media) }, className: 'wb-media-page', title: media.alt || 'page', allowsScripts: true });
  frame.tabIndex = -1;
  return frame;
}

export function createBoardMediaLayer({ viewport, boardHost, onOpenFullSize }: BoardMediaLayerOptions) {
  const layer = el('div', 'wb-media-layer');
  const placedByBoxId = new Map<string, PlacedMedia>();
  let activeBoxId: string | null = null;

  function placedNodeOf(boxId: string, media: LiveMedia): HTMLElement {
    const node = el('div', 'wb-media');
    node.dataset.boxId = boxId;
    node.dataset.mediaKind = media.kind;
    if (media.kind === 'page') node.append(pageFrameOf(media));
    placeNode(node, media);
    const controls = el('div', 'wb-media-controls');
    const activateButton = button({ variant: 'secondary', label: ACTIVATE_LABEL_BY_KIND[media.kind], action: 'activate-media', onClick: () => activate(boxId) });
    activateButton.classList.add('wb-media-activate');
    const doneButton = button({ variant: 'secondary', label: 'done', action: 'deactivate-media', onClick: () => {
      deactivate();
      viewport.focus();
    } });
    doneButton.classList.add('wb-media-done');
    const fullSizeButton = button({ variant: 'secondary', label: 'full size', action: 'open-media-full-size', onClick: () => {
      deactivate();
      onOpenFullSize(boxId, media.alt);
    } });
    controls.append(activateButton, doneButton, fullSizeButton);
    node.append(controls);
    node.addEventListener('pointerdown', (event) => {
      if (node.hasAttribute('data-active') || controls.contains(event.target instanceof Node ? event.target : null)) event.stopPropagation();
    });
    node.addEventListener('dblclick', (event) => event.stopPropagation());
    node.addEventListener('wheel', (event) => {
      if (node.hasAttribute('data-active')) event.stopPropagation();
    });
    return node;
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (!(event.target instanceof Node) || !boardHost.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    deactivate();
    viewport.focus();
  }

  function activate(boxId: string): void {
    const placed = placedByBoxId.get(boxId);
    if (!placed || activeBoxId === boxId) return;
    deactivate();
    activeBoxId = boxId;
    placed.node.dataset.active = '';
    document.addEventListener('keydown', onEscape, true);
    const frame = placed.node.querySelector<HTMLIFrameElement>('iframe.wb-media-page');
    if (frame) {
      frame.tabIndex = 0;
      placed.node.querySelector<HTMLButtonElement>('.wb-media-done')?.focus();
      return;
    }
    const video = el('video', 'wb-media-video');
    video.src = originalHrefOf(placed.media);
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    placed.node.prepend(video);
    video.focus();
  }

  function deactivate(): void {
    const placed = activeBoxId ? placedByBoxId.get(activeBoxId) : undefined;
    activeBoxId = null;
    document.removeEventListener('keydown', onEscape, true);
    if (!placed) return;
    delete placed.node.dataset.active;
    const video = placed.node.querySelector<HTMLVideoElement>('video.wb-media-video');
    video?.pause();
    video?.remove();
    const frame = placed.node.querySelector<HTMLIFrameElement>('iframe.wb-media-page');
    if (frame) frame.tabIndex = -1;
  }

  function sync(layout: BoardLayout): void {
    const seenBoxIds = new Set<string>();
    for (const element of layout.elements) {
      if (element.kind !== 'box' || !isLiveMedia(element.media)) continue;
      seenBoxIds.add(element.id);
      const identity = identityOf(element.media);
      const placed = placedByBoxId.get(element.id);
      if (placed?.identity === identity) {
        placeNode(placed.node, element.media);
        continue;
      }
      if (activeBoxId === element.id) deactivate();
      const node = placedNodeOf(element.id, element.media);
      if (placed) placed.node.replaceWith(node);
      if (!placed) layer.append(node);
      placedByBoxId.set(element.id, { identity, node, media: element.media });
    }
    for (const [boxId, placed] of placedByBoxId) {
      if (seenBoxIds.has(boxId)) continue;
      if (activeBoxId === boxId) deactivate();
      placed.node.remove();
      placedByBoxId.delete(boxId);
    }
  }

  function clear(): void {
    deactivate();
    for (const placed of placedByBoxId.values()) placed.node.remove();
    placedByBoxId.clear();
  }

  document.addEventListener('pointerdown', (event) => {
    const activeNode = activeBoxId ? placedByBoxId.get(activeBoxId)?.node : undefined;
    if (activeNode && !activeNode.contains(event.target instanceof Node ? event.target : null)) deactivate();
  }, true);
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => !entry.isIntersecting)) deactivate();
  }).observe(viewport);

  return { element: layer, sync, clear, activate, deactivate, activeBoxId: () => activeBoxId };
}

export type BoardMediaLayer = ReturnType<typeof createBoardMediaLayer>;
