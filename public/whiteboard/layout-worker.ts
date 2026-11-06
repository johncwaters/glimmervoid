import type { Board } from '#shared/contracts/whiteboard.ts';
import { layoutBoardRemembered } from '#shared/whiteboard-layout-cache.ts';

interface LayoutRequest {
  requestNumber: number;
  board: Board;
}

self.addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  const { requestNumber, board } = event.data;
  self.postMessage({ requestNumber, boardId: board.id, layout: layoutBoardRemembered(board) });
});
