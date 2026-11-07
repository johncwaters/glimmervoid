import { applyWhiteboardRemoved, applyWhiteboardsSnapshot } from '../../whiteboard/board-store.ts';
import { applyBoardTileDiff, applyBoardTiles, forgetTilesOf, resyncTilesIfBehind } from '../../whiteboard/board-tile-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'whiteboards-snapshot': (msg) => {
    applyWhiteboardsSnapshot(msg);
    resyncTilesIfBehind(new Map(msg.boards.map((board) => [board.id, board.version])));
  },
  'whiteboard-removed': (msg) => {
    forgetTilesOf(msg.boardId);
    applyWhiteboardRemoved(msg);
  },
  'whiteboard-tiles': (msg) => applyBoardTiles(msg),
  'whiteboard-tile-diff': (msg) => applyBoardTileDiff(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as whiteboardHandlers };
