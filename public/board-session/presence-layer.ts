import type { Board } from '#shared/contracts/whiteboard.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import type { BoardRenderer } from '../whiteboard/board-gl-renderer.ts';

const FACE_SIZE = 28;
const GLOW_PADDING = 6;

interface BranchFace {
  boxId: string;
  agentId: string | null;
  agentLabel: string;
}

interface PresenceMarks {
  workedBoxId: string | null;
  glowingBoxIds: readonly string[];
  agentId: string | null;
  agentLabel: string;
  branchFaces: readonly BranchFace[];
}

export interface PresenceLayer {
  element: HTMLElement;
  paint(marks: PresenceMarks, board: Board | null): void;
}

function collapsedFrameOf(board: Board | null, boxId: string): string | null {
  if (!board) return null;
  for (const element of board.elements.values()) {
    if (element.kind === 'frame' && element.collapsed && element.contains.includes(boxId)) return element.id;
  }
  return null;
}

function shownBoundsOf(renderer: BoardRenderer, board: Board | null, boxId: string): Rect | null {
  const frameId = collapsedFrameOf(board, boxId);
  if (frameId !== null) return renderer.boundsOf(frameId) ?? renderer.boundsOf(boxId);
  return renderer.boundsOf(boxId);
}

function place(node: HTMLElement, rect: Rect): void {
  node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

export function createPresenceLayer(renderer: BoardRenderer): PresenceLayer {
  const element = el('div', 'bs-presence');
  element.setAttribute('aria-hidden', 'true');
  const face = el('span', 'bs-face bs-presence-face');
  const glows = el('div', 'bs-presence-glows');
  const branchFaces = el('div', 'bs-presence-branches');
  element.append(glows, branchFaces, face);
  face.hidden = true;

  return {
    element,
    paint: (marks, board) => {
      const glowRects = marks.glowingBoxIds.flatMap((boxId) => shownBoundsOf(renderer, board, boxId) ?? []);
      glows.replaceChildren(...glowRects.map((rect) => {
        const glow = el('span', 'bs-presence-glow');
        place(glow, { x: rect.x - GLOW_PADDING, y: rect.y - GLOW_PADDING, width: rect.width + GLOW_PADDING * 2, height: rect.height + GLOW_PADDING * 2 });
        return glow;
      }));
      branchFaces.replaceChildren(...marks.branchFaces.flatMap((branchFace) => {
        const rect = shownBoundsOf(renderer, board, branchFace.boxId);
        if (rect === null) return [];
        const node = el('span', 'bs-face bs-face-branch bs-presence-face bs-presence-branch');
        paintAgentMark(node, branchFace.agentId, branchFace.agentLabel);
        place(node, { x: rect.x - FACE_SIZE / 2, y: rect.y - FACE_SIZE / 2, width: FACE_SIZE, height: FACE_SIZE });
        return [node];
      }));
      const workedRect = marks.workedBoxId === null ? null : shownBoundsOf(renderer, board, marks.workedBoxId);
      if (workedRect === null) {
        face.hidden = true;
        return;
      }
      paintAgentMark(face, marks.agentId, marks.agentLabel);
      face.hidden = false;
      place(face, { x: workedRect.x + workedRect.width - FACE_SIZE / 2, y: workedRect.y - FACE_SIZE / 2, width: FACE_SIZE, height: FACE_SIZE });
    },
  };
}
