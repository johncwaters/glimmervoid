import type { Board } from '../../shared/contracts/whiteboard.ts';
import type { TileKey, TileLod } from '../../shared/contracts/whiteboard-tiles.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import { lineageLayoutOf } from '../../shared/whiteboard-layout-cache.ts';
import type { LayoutAdvance } from '../../shared/whiteboard-layout-cache.ts';
import type { Rect } from '../../shared/whiteboard-layout-core.ts';
import { patchTileIndex, tileDiffFor, tileDiffOf, tileIdOf, tileIndexOf, tileKeysFor, tileOf } from '../../shared/whiteboard-tile-core.ts';
import type { TileIndex } from '../../shared/whiteboard-tile-core.ts';
import type { TileDiff } from '../../shared/contracts/whiteboard-tiles.ts';

interface TileViewer {
  send(message: ServerMessageOf<'whiteboard-tiles'> | ServerMessageOf<'whiteboard-tile-diff'>): void;
}

interface ViewerState {
  boardId: string;
  version: number;
  heldKeys: TileKey[];
}

interface ChangeSource {
  fromVersion: number;
  diffFor: (heldKeys: readonly TileKey[]) => TileDiff;
}

interface BoardView {
  view: Rect;
  lod: TileLod;
}

interface BoardTileService {
  view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }): void;
  boardChanged(boardId: string, advance: LayoutAdvance | null): void;
  forget(viewer: TileViewer): void;
  operatorViewOf(boardId: string): BoardView | null;
  indexOf(boardId: string): TileIndex | null;
}

function createBoardTileService({ boardOf }: { boardOf: (boardId: string) => Board | null }): BoardTileService {
  const indexByBoardId = new Map<string, TileIndex>();
  const lineageByBoardId = new Map<string, number>();
  const stateByViewer = new Map<TileViewer, ViewerState>();
  const lastViewByBoardId = new Map<string, BoardView>();

  function viewersOf(boardId: string): [TileViewer, ViewerState][] {
    return [...stateByViewer].filter(([, state]) => state.boardId === boardId);
  }

  function indexFor(boardId: string): TileIndex | null {
    const board = boardOf(boardId);
    if (!board) return null;
    const cached = indexByBoardId.get(boardId);
    if (cached?.version === board.version) return cached;
    const { lineage, layout } = lineageLayoutOf(board);
    const index = tileIndexOf(layout, board.version, board);
    indexByBoardId.set(boardId, index);
    lineageByBoardId.set(boardId, lineage);
    return index;
  }

  function view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }): void {
    lastViewByBoardId.set(request.boardId, { view: request.view, lod: request.lod });
    const index = indexFor(request.boardId);
    if (!index) return;
    const previous = stateByViewer.get(viewer);
    const isInSync = previous?.boardId === request.boardId && previous.version === index.version && request.knownVersion === index.version;
    const heldIds = new Set(isInSync ? previous.heldKeys.map(tileIdOf) : []);
    const wantedKeys = tileKeysFor(request.view, request.lod);
    const missingKeys = wantedKeys.filter((key) => !heldIds.has(tileIdOf(key)));
    stateByViewer.set(viewer, { boardId: request.boardId, version: index.version, heldKeys: wantedKeys });
    if (isInSync && missingKeys.length === 0) return;
    viewer.send({ type: 'whiteboard-tiles', boardId: request.boardId, version: index.version, chrome: isInSync ? null : index.chrome, tiles: missingKeys.map((key) => tileOf(index, key)) });
  }

  function sendChange(boardId: string, previous: ChangeSource | null, next: TileIndex): void {
    for (const [viewer, state] of viewersOf(boardId)) {
      const fromVersion = state.version;
      state.version = next.version;
      if (previous?.fromVersion === fromVersion) {
        viewer.send({ type: 'whiteboard-tile-diff', boardId, fromVersion, toVersion: next.version, diff: previous.diffFor(state.heldKeys) });
        continue;
      }
      viewer.send({ type: 'whiteboard-tiles', boardId, version: next.version, chrome: next.chrome, tiles: state.heldKeys.map((key) => tileOf(next, key)) });
    }
  }

  function forgetBoard(boardId: string): void {
    indexByBoardId.delete(boardId);
    lineageByBoardId.delete(boardId);
    for (const [viewer] of viewersOf(boardId)) stateByViewer.delete(viewer);
  }

  function boardChanged(boardId: string, advance: LayoutAdvance | null): void {
    const board = boardOf(boardId);
    if (!board) {
      forgetBoard(boardId);
      return;
    }
    const cached = indexByBoardId.get(boardId) ?? null;
    if (cached?.version === board.version) return;
    const isSameLineage = advance !== null && lineageByBoardId.get(boardId) === advance.lineage;
    if (cached && advance && isSameLineage && !advance.delta.isRebuilt && cached.version === board.version - 1) {
      const fromVersion = cached.version;
      const changes = patchTileIndex(cached, board, { version: board.version, chrome: advance.chrome, changed: advance.delta.changed, removedIds: advance.delta.removedIds });
      sendChange(boardId, { fromVersion, diffFor: (heldKeys) => tileDiffOf(cached, changes, heldKeys) }, cached);
      return;
    }
    indexByBoardId.delete(boardId);
    if (viewersOf(boardId).length === 0) return;
    const next = indexFor(boardId);
    if (!next) return;
    sendChange(boardId, cached ? { fromVersion: cached.version, diffFor: (heldKeys) => tileDiffFor(cached, next, heldKeys) } : null, next);
  }

  return {
    view,
    boardChanged,
    forget: (viewer) => {
      stateByViewer.delete(viewer);
    },
    operatorViewOf: (boardId) => lastViewByBoardId.get(boardId) ?? null,
    indexOf: (boardId) => indexFor(boardId),
  };
}

export { createBoardTileService };
export type { BoardTileService, TileViewer };
