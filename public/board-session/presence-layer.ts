import type { Board } from '#shared/contracts/whiteboard.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';

export type GlowTier = 'read' | 'named' | 'edited';
export const GLOW_TIER_RANK: Readonly<Record<GlowTier, number>> = { read: 0, named: 1, edited: 2 };

const GLOW_PADDING = 6;

interface PresenceMarks {
  glows: readonly { boxId: string; tier: GlowTier }[];
}

export interface PresenceLayer {
  element: HTMLElement;
  paint(marks: PresenceMarks, board: Board | null): void;
}

function collapsedFrameIdByBoxIdOf(board: Board | null): Map<string, string> {
  const frameIdByBoxId = new Map<string, string>();
  if (!board) return frameIdByBoxId;
  for (const element of board.elements.values()) {
    if (element.kind !== 'frame' || !element.collapsed) continue;
    for (const boxId of element.contains) frameIdByBoxId.set(boxId, element.id);
  }
  return frameIdByBoxId;
}

function place(node: HTMLElement, rect: Rect): void {
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

export function shownBoundsOfBoard(board: Board | null, boundsOf: (boxId: string) => Rect | null): (boxId: string) => Rect | null {
  const frameIdByBoxId = collapsedFrameIdByBoxIdOf(board);
  return (boxId) => {
    const frameId = frameIdByBoxId.get(boxId);
    return (frameId === undefined ? null : boundsOf(frameId)) ?? boundsOf(boxId);
  };
}

export function shownMapBoundsOfBoard(board: Board | null, boundsOf: (boxId: string) => Rect | null): Rect[] {
  if (!board) return [];
  const frameIdByBoxId = collapsedFrameIdByBoxIdOf(board);
  const shownIds = new Set<string>();
  for (const element of board.elements.values()) {
    if (element.kind === 'box') shownIds.add(frameIdByBoxId.get(element.id) ?? element.id);
  }
  return [...shownIds].flatMap((shownId) => boundsOf(shownId) ?? []);
}

export function createPresenceLayer(boundsOf: (boxId: string) => Rect | null): PresenceLayer {
  const element = el('div', 'bs-presence');
  const glows = el('div', 'bs-presence-glows');
  glows.setAttribute('aria-hidden', 'true');
  element.append(glows);

  return {
    element,
    paint: (marks, board) => {
      const shownBoundsOf = shownBoundsOfBoard(board, boundsOf);
      glows.replaceChildren(...marks.glows.flatMap(({ boxId, tier }) => {
        const rect = shownBoundsOf(boxId);
        if (rect === null) return [];
        const glow = el('span', 'bs-presence-glow');
        glow.dataset.tier = tier;
        place(glow, { x: rect.x - GLOW_PADDING, y: rect.y - GLOW_PADDING, width: rect.width + GLOW_PADDING * 2, height: rect.height + GLOW_PADDING * 2 });
        return [glow];
      }));
    },
  };
}
