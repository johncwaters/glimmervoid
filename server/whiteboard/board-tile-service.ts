import type { Board, BoardHead, BoardOutline } from '../../shared/contracts/whiteboard.ts';
import type { BoardBackdrop, BoardChrome, TileKey, TileLod } from '../../shared/contracts/whiteboard-tiles.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { LaidOutMedia, Rect } from '../../shared/whiteboard-layout-core.ts';
import type { PictureOptions } from '../../mcp/core/board-reading.ts';
import type { Author, PinPositions } from '../../shared/contracts/whiteboard-ops-core.ts';
import { OPERATOR_AUTHOR } from '../../shared/contracts/whiteboard-ops-core.ts';
import { AGENT_CHANGE_BOXES_MAX } from '../../shared/contracts/control/whiteboard-messages.ts';
import type { AgentChange } from '../../shared/contracts/control/whiteboard-messages.ts';
import { backdropOfBoard, tileIdOf, tileKeysFor } from '../../shared/contracts/whiteboard-tile-core.ts';
import { boardIndexOf } from '../../shared/whiteboard-board-index.ts';
import { errorMessage } from '../../shared/text.ts';
import { createLayoutClient } from './layout-client.ts';
import type { ChangedElement } from './layout-client.ts';
import type { LayoutAnswer, OpenStep, SavedLayoutWrite, TileSight, ViewerMessage, ViewerTiles } from './layout-worker-core.ts';
import { clock } from '../../shared/clock.ts';
import type { BoardOpenStep } from '../../shared/contracts/telemetry.ts';

interface TileViewer {
  send(message: ServerMessageOf<'whiteboard-tiles'> | ServerMessageOf<'whiteboard-tile-diff'>): void;
}

interface ViewerState {
  viewerId: number;
  boardId: string;
  version: number | null;
  heldKeys: TileKey[];
}

interface ViewRequest {
  boardId: string;
  view: Rect;
  lod: TileLod;
  scale: number | null;
  knownVersion: number | null;
}

interface BoardFraming {
  head: BoardHead;
  elementCount: number;
  backdrop: BoardBackdrop | null;
}

interface TileSource {
  version: number;
  fetch(keys: TileKey[], withChrome: boolean, sight: TileSight): Promise<LayoutAnswer>;
  framing(answer: LayoutAnswer): BoardFraming;
}

interface BoardView {
  view: Rect;
  lod: TileLod;
  scale: number | null;
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

type BoardPictureRead = { ok: true; svgDocument: string; svgDensity: number; maxPixels: number; frame: Rect } | { ok: false; error: string };

interface BoardRegionRead {
  focus: Rect;
  elementIds: string[];
  outline: BoardOutline | null;
}

interface OpenStepLog {
  mark(step: BoardOpenStep, fields?: Record<string, number>): void;
  addWorkerSteps(steps: readonly OpenStep[]): void;
}

interface BoardTileService {
  view(viewer: TileViewer, request: ViewRequest, openSteps?: OpenStepLog): Promise<void>;
  viewCached(viewer: TileViewer, request: ViewRequest, openSteps?: OpenStepLog): Promise<boolean>;
  isViewing(viewer: TileViewer, boardId: string): boolean;
  hold(board: Board): Promise<void>;
  advance(board: Board, changes: readonly ChangedElement[] | null, author: Author | null): Promise<LayoutSummary | null>;
  forget(viewer: TileViewer): void;
  forgetBoard(boardId: string): void;
  operatorViewOf(boardId: string): BoardView | null;
  regionOf(board: Board, focus: Rect | null, withOutline: boolean): Promise<BoardRegionRead>;
  pinPositionsOf(board: Board, ids: readonly string[]): Promise<PinPositions>;
  summaryOf(board: Board): Promise<LayoutSummary>;
  warningsNamingOf(board: Board, elementIds: readonly string[]): Promise<string[]>;
  pictureImagesOf(board: Board, options: PictureOptions): Promise<PictureImage[]>;
  pictureOf(board: Board, dataUriByAssetId: Record<string, string>, options: PictureOptions): Promise<BoardPictureRead>;
}

function headOf(board: Board): BoardFraming {
  const { elements, ...head } = board;
  return { head, elementCount: boardIndexOf(elements).elementCount, backdrop: backdropOfBoard(board) };
}

function summaryOfAnswer(board: Board, answer: LayoutAnswer): LayoutSummary {
  if (!answer.chrome) throw new Error(`the whiteboard layout sent no chrome for board ${board.id}`);
  return { version: board.version, warnings: answer.warnings ?? [], chrome: answer.chrome };
}

interface TileServiceOptions {
  boardOf: (boardId: string) => Board | null;
  unloadedBoardOf: (boardId: string) => Board | null;
  layoutCachePath: string | null;
  logger: Pick<Console, 'warn'>;
  onSavedLayoutWritten: (written: SavedLayoutWrite) => void;
  broadcastAgentChange: (message: ServerMessageOf<'whiteboard-agent-change'>) => void;
}

function createBoardTileService({ boardOf, unloadedBoardOf, layoutCachePath, logger, onSavedLayoutWritten, broadcastAgentChange }: TileServiceOptions): BoardTileService {
  const layouts = createLayoutClient({ cachePath: layoutCachePath, onSavedLayoutWritten });
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

  function deliver(board: Board, messages: readonly ViewerMessage[]): void {
    const { id: boardId, version } = board;
    const { head, elementCount, backdrop } = headOf(board);
    for (const message of messages) {
      const viewer = viewerById.get(message.viewerId);
      if (!viewer || stateByViewer.get(viewer)?.boardId !== boardId) continue;
      if (message.kind === 'diff') {
        viewer.send({ type: 'whiteboard-tile-diff', boardId, fromVersion: message.fromVersion, toVersion: version, head, elementCount, backdrop, diff: message.diff });
        continue;
      }
      viewer.send({ type: 'whiteboard-tiles', boardId, version, head, elementCount, backdrop, chrome: message.chrome, elementsInView: null, tiles: message.tiles });
    }
  }

  function forgetViewer(viewer: TileViewer): void {
    const state = stateByViewer.get(viewer);
    stateByViewer.delete(viewer);
    if (state) viewerById.delete(state.viewerId);
  }

  async function sendView(viewer: TileViewer, request: ViewRequest, source: TileSource, openSteps: OpenStepLog | undefined): Promise<boolean> {
    const previous = stateByViewer.get(viewer);
    const isInSync = previous?.boardId === request.boardId && previous.version === source.version && request.knownVersion === source.version;
    const heldIds = new Set(isInSync ? previous.heldKeys.map(tileIdOf) : []);
    const wantedKeys = tileKeysFor(request.view, request.lod);
    const missingKeys = wantedKeys.filter((key) => !heldIds.has(tileIdOf(key)));
    const viewerId = previous?.viewerId ?? nextViewerId;
    if (!previous) nextViewerId += 1;
    viewerById.set(viewerId, viewer);
    stateByViewer.set(viewer, { viewerId, boardId: request.boardId, version: source.version, heldKeys: wantedKeys });
    if (isInSync && missingKeys.length === 0) return true;
    const sight = request.scale === null ? null : { view: request.view, scale: request.scale };
    const answer = await source.fetch(missingKeys, !isInSync, sight);
    if (answer.openSteps) openSteps?.addWorkerSteps(answer.openSteps);
    if (answer.isCacheMiss) {
      forgetViewer(viewer);
      return false;
    }
    openSteps?.mark('tiles answered', { tiles: answer.tiles?.length ?? 0 });
    const viewerState = stateByViewer.get(viewer);
    if (viewerState?.boardId !== request.boardId) return true;
    const tiles = answer.tiles ?? [];
    if (tiles.length < missingKeys.length) viewerState.heldKeys = [];
    viewer.send({ type: 'whiteboard-tiles', boardId: request.boardId, version: source.version, ...source.framing(answer), chrome: answer.chrome ?? null, elementsInView: answer.elementsInView ?? null, tiles });
    openSteps?.mark('tiles sent');
    return true;
  }

  function loadedSource(board: Board): TileSource {
    return {
      version: board.version,
      fetch: (keys, withChrome, sight) => layouts.ask(board, { kind: 'tiles', boardId: board.id, keys, withChrome, sight }),
      framing: () => headOf(board),
    };
  }

  function cachedSource(board: Board): TileSource {
    const { elements: _elements, ...head } = board;
    return {
      version: board.version,
      fetch: (keys, withChrome, sight) => layouts.cachedTiles(board.id, board, keys, withChrome, sight),
      framing: (answer) => ({ head, elementCount: answer.elementCount ?? 0, backdrop: backdropOfBoard(board) }),
    };
  }

  async function agentChangeOf(board: Board, changes: readonly ChangedElement[], author: Author | null): Promise<AgentChange | null> {
    if (!author || author.id === OPERATOR_AUTHOR.id) return null;
    const changedBoxes = changes.flatMap(({ after }) => (after?.kind === 'box' ? [after] : [])).slice(0, AGENT_CHANGE_BOXES_MAX);
    if (changedBoxes.length === 0) return null;
    const pins = await pinPositionsOf(board, changedBoxes.map((box) => box.id));
    const boxes = changedBoxes.flatMap(({ id, title }) => {
      const laidOut = pins.laidOutBoxOf(id);
      return laidOut ? [{ id, title, rect: { x: laidOut.x, y: laidOut.y, width: laidOut.width, height: laidOut.height } }] : [];
    });
    return boxes.length === 0 ? null : { author: { id: author.id, name: author.name }, boxes };
  }

  async function sendAgentChange(board: Board, changes: readonly ChangedElement[], author: Author | null): Promise<void> {
    const agentChange = await agentChangeOf(board, changes, author).catch((error: unknown) => {
      logger.warn(`[whiteboard] board ${board.id} could not locate the boxes an agent changed: ${errorMessage(error)}`);
      return null;
    });
    if (agentChange) broadcastAgentChange({ type: 'whiteboard-agent-change', boardId: board.id, version: board.version, at: clock.nowMs(), change: agentChange });
  }

  async function advance(board: Board, changes: readonly ChangedElement[] | null, author: Author | null): Promise<LayoutSummary | null> {
    const viewers = viewerTilesOf(board.id);
    setViewerVersions(board.id, board.version);
    try {
      const answer = changes ? await layouts.advance(board, changes, viewers) : await layouts.refresh(board, viewers);
      deliver(board, answer.viewerMessages ?? []);
      if (changes) await sendAgentChange(board, changes, author);
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

  async function pictureOf(board: Board, dataUriByAssetId: Record<string, string>, options: PictureOptions): Promise<BoardPictureRead> {
    const answer = await layouts.ask(board, { kind: 'picture', boardId: board.id, dataUriByAssetId, options });
    if (!answer.picture) throw new Error(`the whiteboard layout sent no picture for board ${board.id}`);
    return answer.picture;
  }

  return {
    view: async (viewer, request, openSteps) => {
      lastViewByBoardId.set(request.boardId, { view: request.view, lod: request.lod, scale: request.scale });
      const board = boardOf(request.boardId);
      if (!board) return;
      await sendView(viewer, request, loadedSource(board), openSteps).catch((error: unknown) => {
        logger.warn(`[whiteboard] tiles of board ${request.boardId} could not be sent: ${errorMessage(error)}`);
      });
    },
    viewCached: async (viewer, request, openSteps) => {
      const board = unloadedBoardOf(request.boardId);
      if (!board) return false;
      lastViewByBoardId.set(request.boardId, { view: request.view, lod: request.lod, scale: request.scale });
      return sendView(viewer, request, cachedSource(board), openSteps).catch(() => false);
    },
    isViewing: (viewer, boardId) => stateByViewer.get(viewer)?.boardId === boardId,
    hold: (board) => layouts.hold(board),
    advance,
    forget: forgetViewer,
    forgetBoard,
    operatorViewOf: (boardId) => lastViewByBoardId.get(boardId) ?? null,
    regionOf,
    pinPositionsOf,
    summaryOf: async (board) => summaryOfAnswer(board, await layouts.ask(board, { kind: 'summary', boardId: board.id })),
    warningsNamingOf: async (board, elementIds) => (await layouts.ask(board, { kind: 'warnings-naming', boardId: board.id, ids: [...elementIds] })).warnings ?? [],
    pictureImagesOf: async (board, options) => (await layouts.ask(board, { kind: 'picture-images', boardId: board.id, options })).pictureImages ?? [],
    pictureOf,
  };
}

export { createBoardTileService };
export type { BoardPictureRead, BoardTileService, LayoutSummary, OpenStepLog, PictureImage, TileViewer };
