import type { Board } from './contracts/whiteboard.ts';
import { layoutBoardWithMemory } from './whiteboard-layout-core.ts';
import type { BoardLayout, LayoutMemory } from './whiteboard-layout-core.ts';

const REMEMBERED_BOARD_COUNT = 8;

const memoryByBoardId = new Map<string, LayoutMemory>();

function layoutBoardRemembered(board: Board): BoardLayout {
  const { layout, memory } = layoutBoardWithMemory(board, memoryByBoardId.get(board.id) ?? null);
  memoryByBoardId.delete(board.id);
  memoryByBoardId.set(board.id, memory);
  for (const oldestBoardId of memoryByBoardId.keys()) {
    if (memoryByBoardId.size <= REMEMBERED_BOARD_COUNT) break;
    memoryByBoardId.delete(oldestBoardId);
  }
  return layout;
}

export { layoutBoardRemembered };
