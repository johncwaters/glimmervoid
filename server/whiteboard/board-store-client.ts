import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { boardStoreWorkerPath } from '../runtime-paths.ts';
import { BOARD_STORE_FILENAME, ELEMENT_PAGE_SIZE, StoreReply, addParsedElements, boardDeltaOf, headRowsOf, recordOfRows, upgradedRecordOfRows } from './board-store-core.ts';
import type { StagedElements } from './board-store-core.ts';
import type { Rect, StoreRequestBody } from './board-store-core.ts';
import type { BoardRecord } from '../../shared/contracts/whiteboard.ts';
import { elementTableOf } from '../../shared/whiteboard-element-table.ts';

type StoreAnswer = Extract<StoreReply, { ok: true }>;

interface PendingRequest {
  resolve: (answer: StoreAnswer) => void;
  reject: (error: Error) => void;
}

interface BoardStore {
  loadHeads(): Promise<{ records: BoardRecord[]; unreadableBoardIds: string[] }>;
  loadElements(head: BoardRecord, markStep?: (step: string, fields: Record<string, number>) => void): Promise<BoardRecord | null>;
  assetIds(): Promise<Set<string>>;
  boardsLinkingTo(boardId: string): Promise<string[]>;
  boardIds(): Promise<Set<string>>;
  save(before: BoardRecord | null, after: BoardRecord, staged?: StagedElements | null): Promise<void>;
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

  async function loadHeads(): Promise<{ records: BoardRecord[]; unreadableBoardIds: string[] }> {
    const answer = await request({ kind: 'load-heads' });
    const records: BoardRecord[] = [];
    const unreadableBoardIds: string[] = [];
    for (const rows of answer.heads ?? []) {
      const record = recordOfRows(rows, elementTableOf());
      if (record) records.push(record);
      if (!record) unreadableBoardIds.push(rows.boardId);
    }
    return { records, unreadableBoardIds };
  }

  async function forEachElementPage(boardId: string, takePage: (elementBodies: readonly string[]) => boolean): Promise<boolean> {
    let afterSlot = 0;
    let isLastPage = false;
    while (!isLastPage) {
      const page = await request({ kind: 'load-board', boardId, afterSlot, limit: ELEMENT_PAGE_SIZE });
      const elementBodies = page.elementBodies ?? [];
      if (!takePage(elementBodies)) return false;
      isLastPage = elementBodies.length < ELEMENT_PAGE_SIZE || page.lastSlot === undefined;
      afterSlot = page.lastSlot ?? afterSlot;
    }
    return true;
  }

  async function upgradedRecordOf(head: BoardRecord): Promise<BoardRecord | null> {
    const elementBodies: string[] = [];
    await forEachElementPage(head.board.id, (page) => {
      elementBodies.push(...page);
      return true;
    });
    return upgradedRecordOfRows(headRowsOf(head), elementBodies);
  }

  async function loadElements(head: BoardRecord, markStep?: (step: string, fields: Record<string, number>) => void): Promise<BoardRecord | null> {
    const elements = elementTableOf();
    const startedAt = performance.now();
    let pageCount = 0;
    let parseMs = 0;
    let longestPageParseMs = 0;
    const isCurrentShape = await forEachElementPage(head.board.id, (page) => {
      const parseStartedAt = performance.now();
      const isParsed = addParsedElements(elements, page);
      const pageParseMs = performance.now() - parseStartedAt;
      pageCount += 1;
      parseMs += pageParseMs;
      longestPageParseMs = Math.max(longestPageParseMs, pageParseMs);
      return isParsed;
    });
    markStep?.('store pages read and parsed', { pages: pageCount, readMs: Math.round(performance.now() - startedAt - parseMs), parseMs: Math.round(parseMs), longestPageParseMs: Math.round(longestPageParseMs) });
    if (!isCurrentShape) return upgradedRecordOf(head);
    return recordOfRows(headRowsOf(head), elements) ?? upgradedRecordOf(head);
  }

  return {
    loadHeads,
    loadElements,
    assetIds: async () => new Set((await request({ kind: 'asset-ids' })).assetIds ?? []),
    boardsLinkingTo: async (boardId) => (await request({ kind: 'boards-linking-to', boardId })).boardIds ?? [],
    boardIds: async () => new Set((await request({ kind: 'board-ids' })).boardIds ?? []),
    save: async (before, after, staged = null) => { await request({ kind: 'write', deltas: [boardDeltaOf(before, after, staged)] }); },
    saveMany: async (records) => { await request({ kind: 'write', deltas: records.map((record) => boardDeltaOf(null, record)) }); },
    remove: async (boardId) => { await request({ kind: 'delete', boardId }); },
    setRects: async (boardId, rectsByElementId) => { await request({ kind: 'set-rects', boardId, rectsByElementId }); },
    queryRegion: async (boardId, region, limit) => (await request({ kind: 'query-region', boardId, region, limit })).elementIds ?? [],
    searchText: async (boardId, query, limit) => (await request({ kind: 'search-text', boardId, query, limit })).elementIds ?? [],
  };
}

export { createBoardStore };
