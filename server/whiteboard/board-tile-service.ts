import type { Board } from '../../shared/contracts/whiteboard.ts';
import type { TileKey, TileLod } from '../../shared/contracts/whiteboard-tiles.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import type { BoardLayout, Rect } from '../../shared/whiteboard-layout-core.ts';
import { tileDiffFor, tileIdOf, tileIndexOf, tileKeysFor, tileOf } from '../../shared/whiteboard-tile-core.ts';
import type { TileIndex } from '../../shared/whiteboard-tile-core.ts';

interface TileViewer {
  send(message: ServerMessageOf<'whiteboard-tiles'> | ServerMessageOf<'whiteboard-tile-diff'>): void;
}

interface ViewerState {
  boardId: string;
  index: TileIndex;
  heldKeys: TileKey[];
}

interface BoardView {
  view: Rect;
  lod: TileLod;
}

interface BoardTileService {
  view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }): void;
  boardChanged(boardId: string, layout: BoardLayout | null): void;
  forget(viewer: TileViewer): void;
  operatorViewOf(boardId: string): BoardView | null;
  indexOf(boardId: string): TileIndex | null;
}

function createBoardTileService({ boardOf }: { boardOf: (boardId: string) => Board | null }): BoardTileService {
  const indexByBoardId = new Map<string, { board: Board; index: TileIndex }>();
  const stateByViewer = new Map<TileViewer, ViewerState>();
  const lastViewByBoardId = new Map<string, BoardView>();

  function viewersOf(boardId: string): [TileViewer, ViewerState][] {
    return [...stateByViewer].filter(([, state]) => state.boardId === boardId);
  }

  function indexFor(boardId: string, layout: BoardLayout | null): TileIndex | null {
    const board = boardOf(boardId);
    if (!board) return null;
    const cached = indexByBoardId.get(boardId);
    if (cached?.board === board) return cached.index;
    const index = tileIndexOf(layout ?? layoutBoard(board), board.version);
    indexByBoardId.set(boardId, { board, index });
    return index;
  }

  function view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }): void {
    lastViewByBoardId.set(request.boardId, { view: request.view, lod: request.lod });
    const index = indexFor(request.boardId, null);
    if (!index) return;
    const previous = stateByViewer.get(viewer);
    const isInSync = previous?.boardId === request.boardId && previous.index === index && request.knownVersion === index.version;
    const heldIds = new Set(isInSync ? previous.heldKeys.map(tileIdOf) : []);
    const wantedKeys = tileKeysFor(request.view, request.lod);
    const missingKeys = wantedKeys.filter((key) => !heldIds.has(tileIdOf(key)));
    stateByViewer.set(viewer, { boardId: request.boardId, index, heldKeys: wantedKeys });
    if (isInSync && missingKeys.length === 0) return;
    viewer.send({ type: 'whiteboard-tiles', boardId: request.boardId, version: index.version, chrome: isInSync ? null : index.chrome, tiles: missingKeys.map((key) => tileOf(index, key)) });
  }

  function boardChanged(boardId: string, layout: BoardLayout | null): void {
    const viewers = viewersOf(boardId);
    if (viewers.length === 0) {
      indexByBoardId.delete(boardId);
      return;
    }
    const next = indexFor(boardId, layout);
    if (!next) {
      indexByBoardId.delete(boardId);
      for (const [viewer] of viewers) stateByViewer.delete(viewer);
      return;
    }
    for (const [viewer, state] of viewers) {
      if (state.index === next) continue;
      viewer.send({ type: 'whiteboard-tile-diff', boardId, fromVersion: state.index.version, toVersion: next.version, diff: tileDiffFor(state.index, next, state.heldKeys) });
      state.index = next;
    }
  }

  return {
    view,
    boardChanged,
    forget: (viewer) => {
      stateByViewer.delete(viewer);
    },
    operatorViewOf: (boardId) => lastViewByBoardId.get(boardId) ?? null,
    indexOf: (boardId) => indexFor(boardId, null),
  };
}

export { createBoardTileService };
export type { BoardTileService, TileViewer };
