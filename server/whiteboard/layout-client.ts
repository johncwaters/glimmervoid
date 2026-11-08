import os from 'node:os';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import type { Board, Element } from '../../shared/contracts/whiteboard.ts';
import type { TileKey } from '../../shared/contracts/whiteboard-tiles.ts';
import { layoutWorkerPath } from '../runtime-paths.ts';
import { ELEMENT_PAGE_SIZE } from './board-store-core.ts';
import { LayoutReply, SavedLayoutWritten } from './layout-worker-core.ts';
import type { LayoutAnswer, LayoutRequestBody, SavedLayoutWrite, ViewerTiles } from './layout-worker-core.ts';
import type { LayoutStamp } from './layout-cache.ts';

const WORKER_HEAP_SHARE = 0.5;
const BYTES_PER_MB = 2 ** 20;

interface ChangedElement {
  id: string;
  after: Element | null;
  isAppended: boolean;
}

interface PendingRequest {
  resolve: (answer: LayoutAnswer) => void;
  reject: (error: Error) => void;
}

interface BoardSync {
  syncId: number;
  version: number;
  held: Promise<void>;
  posted: Promise<void>;
}

interface LayoutClient {
  hold(board: Board): Promise<void>;
  advance(board: Board, changes: readonly ChangedElement[], viewers: readonly ViewerTiles[]): Promise<LayoutAnswer>;
  refresh(board: Board, viewers: readonly ViewerTiles[]): Promise<LayoutAnswer>;
  ask(board: Board, body: LayoutRequestBody): Promise<LayoutAnswer>;
  cachedTiles(boardId: string, stamp: LayoutStamp, keys: readonly TileKey[], withChrome: boolean): Promise<LayoutAnswer>;
  forget(boardId: string): void;
}

function createLayoutClient({ cachePath, onSavedLayoutWritten }: { cachePath: string | null; onSavedLayoutWritten: (written: SavedLayoutWrite) => void }): LayoutClient {
  const pendingByRequestId = new Map<number, PendingRequest>();
  const syncByBoardId = new Map<string, BoardSync>();
  let nextRequestId = 1;
  let nextSyncId = 1;
  let worker: Worker | null = null;

  function failAll(failedWorker: Worker, error: Error): void {
    if (worker !== failedWorker) return;
    worker = null;
    syncByBoardId.clear();
    for (const pending of pendingByRequestId.values()) pending.reject(error);
    pendingByRequestId.clear();
  }

  function startWorker(): Worker {
    const maxOldGenerationSizeMb = Math.floor((os.totalmem() * WORKER_HEAP_SHARE) / BYTES_PER_MB);
    const started = new Worker(layoutWorkerPath, { workerData: cachePath, resourceLimits: { maxOldGenerationSizeMb } });
    started.on('error', (error: unknown) => failAll(started, error instanceof Error ? error : new Error(String(error))));
    started.on('exit', (exitCode) => failAll(started, new Error(`the whiteboard layout stopped with exit code ${exitCode}`)));
    started.on('message', (message: unknown) => {
      const written = SavedLayoutWritten.safeParse(message);
      if (written.success) {
        onSavedLayoutWritten(written.data.savedLayoutWritten);
        return;
      }
      const reply = LayoutReply.safeParse(message);
      if (!reply.success) return;
      const pending = pendingByRequestId.get(reply.data.requestId);
      if (!pending) return;
      pendingByRequestId.delete(reply.data.requestId);
      if (pendingByRequestId.size === 0) started.unref();
      if (reply.data.ok) {
        pending.resolve(reply.data);
        return;
      }
      pending.reject(new Error(reply.data.error));
    });
    return started;
  }

  function post(body: LayoutRequestBody): Promise<LayoutAnswer> {
    const running = worker ?? startWorker();
    worker = running;
    const requestId = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pendingByRequestId.set(requestId, { resolve, reject });
      running.ref();
      running.postMessage({ ...body, requestId });
    });
  }

  function forgetSyncOnFailure(boardId: string, sync: BoardSync, answer: Promise<LayoutAnswer>): void {
    answer.catch(() => {
      if (isCurrentSync(boardId, sync)) syncByBoardId.delete(boardId);
    });
  }

  function isCurrentSync(boardId: string, sync: BoardSync): boolean {
    return syncByBoardId.get(boardId)?.syncId === sync.syncId;
  }

  async function elementsTheWorkerLacks(board: Board, after: Promise<void>, sync: BoardSync): Promise<readonly Element[]> {
    await after;
    if (!isCurrentSync(board.id, sync)) return [];
    const { elements: _elements, ...head } = board;
    const started = post({ kind: 'sync-start', syncId: sync.syncId, head, elementCount: board.elements.size });
    forgetSyncOnFailure(board.id, sync, started);
    const answer = await started.catch(() => null);
    if (!answer?.isCacheMiss || !isCurrentSync(board.id, sync)) return [];
    return [...board.elements.values()];
  }

  function postBoard(board: Board, after: Promise<void>, sync: BoardSync): Pick<BoardSync, 'held' | 'posted'> {
    const started = elementsTheWorkerLacks(board, after, sync);
    return { held: started.then(() => undefined), posted: started.then((elements) => postPages(board, elements, sync)) };
  }

  async function postPages(board: Board, elements: readonly Element[], sync: BoardSync): Promise<void> {
    const { syncId } = sync;
    const syncWorker = worker;
    for (let start = 0; start < elements.length; start += ELEMENT_PAGE_SIZE) {
      await yieldToEventLoop();
      if (!isCurrentSync(board.id, sync) || worker !== syncWorker) return;
      forgetSyncOnFailure(board.id, sync, post({ kind: 'sync-elements', syncId, boardId: board.id, elements: elements.slice(start, start + ELEMENT_PAGE_SIZE) }));
    }
  }

  function syncFor(board: Board): BoardSync {
    const held = syncByBoardId.get(board.id);
    if (held?.version === board.version) return held;
    const sync: BoardSync = { syncId: nextSyncId, version: board.version, held: Promise.resolve(), posted: Promise.resolve() };
    nextSyncId += 1;
    syncByBoardId.set(board.id, sync);
    const postedBoard = postBoard(board, held?.posted ?? Promise.resolve(), sync);
    sync.held = postedBoard.held;
    sync.posted = postedBoard.posted;
    return sync;
  }

  async function ask(board: Board, body: LayoutRequestBody): Promise<LayoutAnswer> {
    const sync = syncFor(board);
    await sync.posted;
    if (!isCurrentSync(board.id, sync)) throw new Error(`the whiteboard layout lost board ${board.id} while this request waited; try again`);
    return post(body);
  }

  function hold(board: Board): Promise<void> {
    return syncFor(board).held;
  }

  function refresh(board: Board, viewers: readonly ViewerTiles[]): Promise<LayoutAnswer> {
    return ask(board, { kind: 'refresh', boardId: board.id, viewers: [...viewers] });
  }

  function advance(board: Board, changes: readonly ChangedElement[], viewers: readonly ViewerTiles[]): Promise<LayoutAnswer> {
    const held = syncByBoardId.get(board.id);
    if (held?.version !== board.version - 1) return refresh(board, viewers);
    const { elements: _elements, ...head } = board;
    const sync: BoardSync = { syncId: held.syncId, version: board.version, held: held.held, posted: held.posted };
    syncByBoardId.set(board.id, sync);
    const answer = held.posted.then(() => {
      if (!isCurrentSync(board.id, sync)) throw new Error(`the whiteboard layout lost board ${board.id} while this put waited`);
      return post({ kind: 'advance', head, changes: [...changes], viewers: [...viewers] });
    });
    forgetSyncOnFailure(board.id, sync, answer);
    return answer;
  }

  function forget(boardId: string): void {
    const held = syncByBoardId.get(boardId);
    syncByBoardId.delete(boardId);
    if (!worker) return;
    void (held?.posted ?? Promise.resolve()).then(() => post({ kind: 'forget', boardId })).catch(() => {});
  }

  function cachedTiles(boardId: string, stamp: LayoutStamp, keys: readonly TileKey[], withChrome: boolean): Promise<LayoutAnswer> {
    return post({ kind: 'cached-tiles', boardId, version: stamp.version, updatedAt: stamp.updatedAt, keys: [...keys], withChrome });
  }

  return { hold, advance, refresh, ask, cachedTiles, forget };
}

export { createLayoutClient };
export type { ChangedElement };
