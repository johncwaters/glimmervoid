import type { Board } from '#shared/contracts/whiteboard.ts';

export interface FolderHit {
  id: string;
  kind: string;
}

export function folderToggleTargetOf(hit: FolderHit | null, board: Board | null): string | null {
  if (hit === null || board === null) return null;
  if (hit.kind === 'frame') return hit.id;
  if (hit.kind !== 'box') return null;
  for (const frame of board.elements.valuesOfKind('frame')) {
    if (frame.collapsed && frame.contains.includes(hit.id)) return frame.id;
  }
  return null;
}
