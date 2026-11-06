import type { Board } from './contracts/whiteboard.ts';
import { layoutBoardWithMemory } from './whiteboard-layout-core.ts';
import type { BoardLayout, LayoutMemory } from './whiteboard-layout-core.ts';

const REMEMBERED_BOARD_COUNT = 8;

interface RememberedLayout {
  version: number;
  layout: BoardLayout;
  memory: LayoutMemory;
}

const rememberedByBoardId = new Map<string, RememberedLayout>();

function layoutBoardRemembered(board: Board): BoardLayout {
  const { layout, memory } = layoutBoardWithMemory(board, rememberedByBoardId.get(board.id)?.memory ?? null);
  rememberedByBoardId.delete(board.id);
  rememberedByBoardId.set(board.id, { version: board.version, layout, memory });
  for (const oldestBoardId of rememberedByBoardId.keys()) {
    if (rememberedByBoardId.size <= REMEMBERED_BOARD_COUNT) break;
    rememberedByBoardId.delete(oldestBoardId);
  }
  return layout;
}

function rememberedLayoutOf(board: Board): BoardLayout | null {
  const remembered = rememberedByBoardId.get(board.id);
  if (!remembered) return null;
  return remembered.version === board.version ? remembered.layout : layoutBoardRemembered(board);
}

export { layoutBoardRemembered, rememberedLayoutOf };
