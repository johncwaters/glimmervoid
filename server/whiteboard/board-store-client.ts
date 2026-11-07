import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { boardStoreWorkerPath } from '../runtime-paths.ts';
import { BOARD_STORE_FILENAME, StoreReply, boardDeltaOf, recordOfRows } from './board-store-core.ts';
import type { Rect, StoreRequestBody } from './board-store-core.ts';
import type { BoardRecord } from '../../shared/contracts/whiteboard.ts';

type StoreAnswer = Extract<StoreReply, { ok: true }>;

interface PendingRequest {
  resolve: (answer: StoreAnswer) => void;
  reject: (error: Error) => void;
}

interface BoardStore {
  loadAll(): Promise<{ records: BoardRecord[]; unreadableBoardIds: string[] }>;
  boardIds(): Promise<Set<string>>;
  save(before: BoardRecord | null, after: BoardRecord): Promise<void>;
  saveMany(records: readonly BoardRecord[]): Promise<void>;
  remove(boardId: string): Promise<void>;
  setRects(boardId: string, rectsByElementId: Record<string, Rect>): Promise<void>;
  queryRegion(boardId: string, region: Rect, limit: number): Promise<string[]>;
  searchText(boardId: string, query: string, limit: number): Promise<string[]>;
}

function createBoardStore(boardsRoot: string): BoardStore {
  const databasePath = path.join(boardsRoot, BOARD_STORE_FILENAME);
  const pendingByRequestId = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let worker: Worker | null = null;

  function failAll(failedWorker: Worker, error: Error): void {
    if (worker !== failedWorker) return;
    worker = null;
    for (const pending of pendingByRequestId.values()) pending.reject(error);
    pendingByRequestId.clear();
  }

  function startWorker(): Worker {
    const started = new Worker(boardStoreWorkerPath, { workerData: databasePath });
    started.on('error', (error: unknown) => failAll(started, error instanceof Error ? error : new Error(String(error))));
    started.on('exit', (exitCode) => failAll(started, new Error(`the board store stopped with exit code ${exitCode}`)));
    started.on('message', (message: unknown) => {
      const reply = StoreReply.safeParse(message);
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

  function request(body: StoreRequestBody): Promise<StoreAnswer> {
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

  async function loadAll(): Promise<{ records: BoardRecord[]; unreadableBoardIds: string[] }> {
    const answer = await request({ kind: 'load-all' });
    const records: BoardRecord[] = [];
    const unreadableBoardIds: string[] = [];
    for (const rows of answer.boards ?? []) {
      const record = recordOfRows(rows);
      if (record) records.push(record);
      if (!record) unreadableBoardIds.push(rows.boardId);
    }
    return { records, unreadableBoardIds };
  }

  return {
    loadAll,
    boardIds: async () => new Set((await request({ kind: 'board-ids' })).boardIds ?? []),
    save: async (before, after) => { await request({ kind: 'write', deltas: [boardDeltaOf(before, after)] }); },
    saveMany: async (records) => { await request({ kind: 'write', deltas: records.map((record) => boardDeltaOf(null, record)) }); },
    remove: async (boardId) => { await request({ kind: 'delete', boardId }); },
    setRects: async (boardId, rectsByElementId) => { await request({ kind: 'set-rects', boardId, rectsByElementId }); },
    queryRegion: async (boardId, region, limit) => (await request({ kind: 'query-region', boardId, region, limit })).elementIds ?? [],
    searchText: async (boardId, query, limit) => (await request({ kind: 'search-text', boardId, query, limit })).elementIds ?? [],
  };
}

export { createBoardStore };
