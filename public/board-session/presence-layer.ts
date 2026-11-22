import type { Board } from '#shared/contracts/whiteboard.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import type { ChatPhase } from '../chat/chat-activity-core.ts';
import type { RunningSubagent } from '../chat/status-rail-core.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createPressable } from '../ui/pressable.ts';

const FACE_SIZE = 28;
const FACE_GAP = 6;
const GLOW_PADDING = 6;

export interface SessionFace {
  sessionId: string;
  boxId: string | null;
  agentId: string | null;
  agentLabel: string;
  isMain: boolean;
  isBranch: boolean;
  phase: ChatPhase;
  statusText: string | null;
  subagents: readonly RunningSubagent[];
}

interface PresenceMarks {
  glowingBoxIds: readonly string[];
  faces: readonly SessionFace[];
}

export interface PresenceLayer {
  element: HTMLElement;
  roster: HTMLElement;
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

function subagentFaceOf(subagent: RunningSubagent): HTMLElement {
  return el('span', 'bs-face bs-face-sub', subagent.type.slice(0, 1).toUpperCase());
}

function whoOf(face: SessionFace, onFacePicked: (face: SessionFace) => void): HTMLElement {
  const who = el('div', 'bs-who');
  who.dataset.phase = face.phase;
  who.dataset.sessionId = face.sessionId;
  const faceButton = createPressable(['bs-face', 'bs-presence-face', face.isMain ? 'bs-face-main' : '', face.isBranch ? 'bs-face-branch bs-presence-branch' : ''].filter(Boolean).join(' '));
  faceButton.dataset.action = 'board-session-address-face';
  faceButton.setAttribute('aria-label', `Message ${face.agentLabel}`);
  paintAgentMark(faceButton, face.agentId, face.agentLabel);
  faceButton.addEventListener('pointerdown', (event) => event.stopPropagation());
  faceButton.addEventListener('click', () => onFacePicked(face));
  who.append(faceButton, ...face.subagents.map(subagentFaceOf));
  if (face.subagents.length > 0) who.append(el('span', 'bs-who-subagents', face.subagents.map((subagent) => subagent.type).join(', ')));
  if (face.statusText !== null) who.append(el('span', 'bs-who-status', face.statusText));
  return who;
}

export function createPresenceLayer(boundsOf: (boxId: string) => Rect | null, onFacePicked: (face: SessionFace) => void): PresenceLayer {
  const element = el('div', 'bs-presence');
  const glows = el('div', 'bs-presence-glows');
  glows.setAttribute('aria-hidden', 'true');
  const faces = el('div', 'bs-presence-faces');
  element.append(glows, faces);
  const roster = el('div', 'bs-roster');

  return {
    element,
    roster,
    paint: (marks, board) => {
      const frameIdByBoxId = collapsedFrameIdByBoxIdOf(board);
      const shownBoundsOf = (boxId: string): Rect | null => {
        const frameId = frameIdByBoxId.get(boxId);
        return (frameId === undefined ? null : boundsOf(frameId)) ?? boundsOf(boxId);
      };
      glows.replaceChildren(...marks.glowingBoxIds.flatMap((boxId) => {
        const rect = shownBoundsOf(boxId);
        if (rect === null) return [];
        const glow = el('span', 'bs-presence-glow');
        place(glow, { x: rect.x - GLOW_PADDING, y: rect.y - GLOW_PADDING, width: rect.width + GLOW_PADDING * 2, height: rect.height + GLOW_PADDING * 2 });
        return [glow];
      }));
      const facesOnBoxCount = new Map<string, number>();
      const boardWhos: HTMLElement[] = [];
      const rosterWhos: HTMLElement[] = [];
      for (const face of marks.faces) {
        const rect = face.boxId === null ? null : shownBoundsOf(face.boxId);
        const who = whoOf(face, onFacePicked);
        if (rect === null || face.boxId === null) {
          rosterWhos.push(who);
          continue;
        }
        const stackIndex = facesOnBoxCount.get(face.boxId) ?? 0;
        facesOnBoxCount.set(face.boxId, stackIndex + 1);
        who.style.transform = `translate(${rect.x + rect.width - FACE_SIZE / 2}px, ${rect.y - FACE_SIZE / 2 - stackIndex * (FACE_SIZE + FACE_GAP)}px)`;
        boardWhos.push(who);
      }
      faces.replaceChildren(...boardWhos);
      roster.replaceChildren(...rosterWhos);
      roster.hidden = rosterWhos.length === 0;
    },
  };
}
