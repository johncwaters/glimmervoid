import type { Board } from './contracts/whiteboard.ts';
import { layoutBoardWithMemory } from './whiteboard-layout-core.ts';
import type { BoardLayout, LayoutMemory } from './whiteboard-layout-core.ts';

const REMEMBERED_BOARD_COUNT = 8;

interface RememberedLayout {
  version: number;
  elements: Board['elements'];
  layout: BoardLayout;
  memory: LayoutMemory;
}

const rememberedByBoardId = new Map<string, RememberedLayout>();

function layoutBoardRemembered(board: Board): BoardLayout {
  const remembered = rememberedByBoardId.get(board.id);
  if (remembered && remembered.version === board.version && remembered.elements === board.elements) return remembered.layout;
  const { layout, memory } = layoutBoardWithMemory(board, remembered?.memory ?? null);
  rememberedByBoardId.delete(board.id);
  rememberedByBoardId.set(board.id, { version: board.version, elements: board.elements, layout, memory });
  for (const oldestBoardId of rememberedByBoardId.keys()) {
    if (rememberedByBoardId.size <= REMEMBERED_BOARD_COUNT) break;
    rememberedByBoardId.delete(oldestBoardId);
  }
  return layout;
}

export { layoutBoardRemembered };
