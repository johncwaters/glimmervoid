import type { Board, BoardOutline } from '../../shared/contracts/whiteboard.ts';
import type { BoardChrome, TileKey, TileLod } from '../../shared/contracts/whiteboard-tiles.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { LaidOutMedia, Rect } from '../../shared/whiteboard-layout-core.ts';
import type { PinPositions } from '../../shared/whiteboard-ops-core.ts';
import { tileIdOf, tileKeysFor } from '../../shared/whiteboard-tile-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { createLayoutClient } from './layout-client.ts';
import type { ChangedElement } from './layout-client.ts';
import type { LayoutAnswer, ViewerMessage, ViewerTiles } from './layout-worker-core.ts';

interface TileViewer {
  send(message: ServerMessageOf<'whiteboard-tiles'> | ServerMessageOf<'whiteboard-tile-diff'>): void;
}

interface ViewerState {
  viewerId: number;
  boardId: string;
  version: number | null;
  heldKeys: TileKey[];
}

interface BoardView {
  view: Rect;
  lod: TileLod;
}

interface LayoutSummary {
  version: number;
  warnings: string[];
  chrome: BoardChrome;
}

interface PictureImage {
  media: LaidOutMedia;
  width: number;
  height: number;
}

type BoardPictureRead = { ok: true; svgDocument: string; svgDensity: number; maxPixels: number } | { ok: false; error: string };

interface BoardRegionRead {
  focus: Rect;
  elementIds: string[];
  outline: BoardOutline | null;
}

interface BoardTileService {
  view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }): Promise<void>;
  advance(board: Board, changes: readonly ChangedElement[] | null): Promise<LayoutSummary | null>;
  forget(viewer: TileViewer): void;
  forgetBoard(boardId: string): void;
  operatorViewOf(boardId: string): BoardView | null;
  regionOf(board: Board, focus: Rect | null, withOutline: boolean): Promise<BoardRegionRead>;
  pinPositionsOf(board: Board, ids: readonly string[]): Promise<PinPositions>;
  summaryOf(board: Board): Promise<LayoutSummary>;
  pictureImagesOf(board: Board): Promise<PictureImage[]>;
  pictureOf(board: Board, dataUriByAssetId: Record<string, string>): Promise<BoardPictureRead>;
}

function summaryOfAnswer(board: Board, answer: LayoutAnswer): LayoutSummary {
  if (!answer.chrome) throw new Error(`the whiteboard layout sent no chrome for board ${board.id}`);
  return { version: board.version, warnings: answer.warnings ?? [], chrome: answer.chrome };
}

function createBoardTileService({ boardOf, logger }: { boardOf: (boardId: string) => Board | null; logger: Pick<Console, 'warn'> }): BoardTileService {
  const layouts = createLayoutClient();
  const stateByViewer = new Map<TileViewer, ViewerState>();
  const viewerById = new Map<number, TileViewer>();
  const lastViewByBoardId = new Map<string, BoardView>();
  let nextViewerId = 1;

  function viewerTilesOf(boardId: string): ViewerTiles[] {
    return [...stateByViewer.values()].filter((state) => state.boardId === boardId).map(({ viewerId, version, heldKeys }) => ({ viewerId, version, heldKeys }));
  }

  function setViewerVersions(boardId: string, version: number | null): void {
    for (const state of stateByViewer.values()) {
      if (state.boardId === boardId) state.version = version;
    }
  }

  function deliver(boardId: string, version: number, messages: readonly ViewerMessage[]): void {
    for (const message of messages) {
      const viewer = viewerById.get(message.viewerId);
      if (!viewer || stateByViewer.get(viewer)?.boardId !== boardId) continue;
      if (message.kind === 'diff') {
        viewer.send({ type: 'whiteboard-tile-diff', boardId, fromVersion: message.fromVersion, toVersion: version, diff: message.diff });
        continue;
      }
      viewer.send({ type: 'whiteboard-tiles', boardId, version, chrome: message.chrome, tiles: message.tiles });
    }
  }

  async function view(viewer: TileViewer, request: { boardId: string; view: Rect; lod: TileLod; knownVersion: number | null }, board: Board): Promise<void> {
    const previous = stateByViewer.get(viewer);
    const isInSync = previous?.boardId === request.boardId && previous.version === board.version && request.knownVersion === board.version;
    const heldIds = new Set(isInSync ? previous.heldKeys.map(tileIdOf) : []);
    const wantedKeys = tileKeysFor(request.view, request.lod);
    const missingKeys = wantedKeys.filter((key) => !heldIds.has(tileIdOf(key)));
    const viewerId = previous?.viewerId ?? nextViewerId;
    if (!previous) nextViewerId += 1;
    viewerById.set(viewerId, viewer);
    stateByViewer.set(viewer, { viewerId, boardId: request.boardId, version: board.version, heldKeys: wantedKeys });
    if (isInSync && missingKeys.length === 0) return;
    const answer = await layouts.ask(board, { kind: 'tiles', boardId: board.id, keys: missingKeys, withChrome: !isInSync });
    if (stateByViewer.get(viewer)?.boardId !== request.boardId) return;
    viewer.send({ type: 'whiteboard-tiles', boardId: request.boardId, version: board.version, chrome: answer.chrome ?? null, tiles: answer.tiles ?? [] });
  }

  async function advance(board: Board, changes: readonly ChangedElement[] | null): Promise<LayoutSummary | null> {
    const viewers = viewerTilesOf(board.id);
    setViewerVersions(board.id, board.version);
    try {
      const answer = changes ? await layouts.advance(board, changes, viewers) : await layouts.refresh(board, viewers);
      deliver(board.id, board.version, answer.viewerMessages ?? []);
      return summaryOfAnswer(board, answer);
    } catch (error) {
      setViewerVersions(board.id, null);
      logger.warn(`[whiteboard] board ${board.id} could not be laid out: ${errorMessage(error)}`);
      return null;
    }
  }

  function forgetBoard(boardId: string): void {
    layouts.forget(boardId);
    for (const [viewer, state] of stateByViewer) {
      if (state.boardId !== boardId) continue;
      stateByViewer.delete(viewer);
      viewerById.delete(state.viewerId);
    }
  }

  async function regionOf(board: Board, focus: Rect | null, withOutline: boolean): Promise<BoardRegionRead> {
    const answer = await layouts.ask(board, { kind: 'region', boardId: board.id, focus, withOutline });
    if (!answer.focus) throw new Error(`the whiteboard layout sent no focus for board ${board.id}`);
    return { focus: answer.focus, elementIds: answer.elementIds ?? [], outline: answer.outline ?? null };
  }

  async function pinPositionsOf(board: Board, ids: readonly string[]): Promise<PinPositions> {
    const answer = await layouts.ask(board, { kind: 'pins', boardId: board.id, ids: [...ids] });
    const pinnedBoxById = new Map((answer.pinnedBoxes ?? []).map((box) => [box.id, box]));
    return { laidOutBoxOf: (id) => pinnedBoxById.get(id), pinnedOffsetY: answer.pinnedOffsetY ?? 0 };
  }

  async function pictureOf(board: Board, dataUriByAssetId: Record<string, string>): Promise<BoardPictureRead> {
    const answer = await layouts.ask(board, { kind: 'picture', boardId: board.id, dataUriByAssetId });
    if (!answer.picture) throw new Error(`the whiteboard layout sent no picture for board ${board.id}`);
    return answer.picture;
  }

  return {
    view: (viewer, request) => {
      lastViewByBoardId.set(request.boardId, { view: request.view, lod: request.lod });
      const board = boardOf(request.boardId);
      if (!board) return Promise.resolve();
      return view(viewer, request, board).catch((error: unknown) => {
        logger.warn(`[whiteboard] tiles of board ${request.boardId} could not be sent: ${errorMessage(error)}`);
      });
    },
    advance,
    forget: (viewer) => {
      const state = stateByViewer.get(viewer);
      stateByViewer.delete(viewer);
      if (state) viewerById.delete(state.viewerId);
    },
    forgetBoard,
    operatorViewOf: (boardId) => lastViewByBoardId.get(boardId) ?? null,
    regionOf,
    pinPositionsOf,
    summaryOf: async (board) => summaryOfAnswer(board, await layouts.ask(board, { kind: 'summary', boardId: board.id })),
    pictureImagesOf: async (board) => (await layouts.ask(board, { kind: 'picture-images', boardId: board.id })).pictureImages ?? [],
    pictureOf,
  };
}

export { createBoardTileService };
export type { BoardPictureRead, BoardTileService, LayoutSummary, PictureImage, TileViewer };
