import type { Board } from '#shared/contracts/whiteboard.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { createPressable } from '../ui/pressable.ts';

export type GlowTier = 'read' | 'named' | 'edited';
export const GLOW_TIER_RANK: Readonly<Record<GlowTier, number>> = { read: 0, named: 1, edited: 2 };

const GLOW_PADDING = 6;
const REPO_MARK_SIZE = 24;
const REPO_MARK_INSET = 8;

interface RepoAgentMark {
  repoKey: string;
  repoName: string;
  anchorBoxId: string;
  agentId: string | null;
}

interface PresenceMarks {
  glows: readonly { boxId: string; tier: GlowTier }[];
  repoAgents: readonly RepoAgentMark[];
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

export function createPresenceLayer(boundsOf: (boxId: string) => Rect | null, pickRepoAgent: (repoKey: string) => void): PresenceLayer {
  const element = el('div', 'bs-presence');
  const glows = el('div', 'bs-presence-glows');
  glows.setAttribute('aria-hidden', 'true');
  const repoAgents = el('div', 'bs-presence-repo-agents');
  element.append(glows, repoAgents);
  let paintedGlowsKey: string | null = null;
  let paintedRepoAgentsKey: string | null = null;

  const paintRepoAgents = (marks: readonly RepoAgentMark[], shownBoundsOf: (boxId: string) => Rect | null) => {
    const shownMarks = marks.flatMap((mark) => {
      const card = shownBoundsOf(mark.anchorBoxId);
      return card === null || mark.agentId === null ? [] : [{ mark, rect: { x: card.x + card.width - REPO_MARK_SIZE - REPO_MARK_INSET, y: card.y - REPO_MARK_SIZE / 2, width: REPO_MARK_SIZE, height: REPO_MARK_SIZE } }];
    });
    const repoAgentsKey = shownMarks.map(({ mark, rect }) => `${mark.repoKey} ${mark.agentId} ${mark.repoName} ${rect.x} ${rect.y}`).join('|');
    if (repoAgentsKey === paintedRepoAgentsKey) return;
    paintedRepoAgentsKey = repoAgentsKey;
    repoAgents.replaceChildren(...shownMarks.map(({ mark, rect }) => {
      const pressable = createPressable('bs-repo-agent');
      pressable.dataset.repoKey = mark.repoKey;
      pressable.setAttribute('aria-label', `Branch agent of ${mark.repoName}`);
      const face = el('span', 'bs-repo-agent-face');
      paintAgentMark(face, mark.agentId, mark.agentId);
      pressable.append(face);
      pressable.addEventListener('pointerdown', (event) => event.stopPropagation());
      pressable.addEventListener('click', () => pickRepoAgent(mark.repoKey));
      place(pressable, rect);
      return pressable;
    }));
  };

  return {
    element,
    paint: (marks, board) => {
      const shownBoundsOf = shownBoundsOfBoard(board, boundsOf);
      paintRepoAgents(marks.repoAgents, shownBoundsOf);
      const shownGlows = marks.glows.flatMap(({ boxId, tier }) => {
        const rect = shownBoundsOf(boxId);
        return rect === null ? [] : [{ tier, rect: { x: rect.x - GLOW_PADDING, y: rect.y - GLOW_PADDING, width: rect.width + GLOW_PADDING * 2, height: rect.height + GLOW_PADDING * 2 } }];
      });
      const glowsKey = shownGlows.map(({ tier, rect }) => `${tier} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`).join('|');
      if (glowsKey === paintedGlowsKey) return;
      paintedGlowsKey = glowsKey;
      glows.replaceChildren(...shownGlows.map(({ tier, rect }) => {
        const glow = el('span', 'bs-presence-glow');
        glow.dataset.tier = tier;
        place(glow, rect);
        return glow;
      }));
    },
  };
}
