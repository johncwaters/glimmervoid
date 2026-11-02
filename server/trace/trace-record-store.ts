import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { TraceRecord as TraceRecordSchema } from '../../shared/contracts/trace.ts';
import { containmentRefusalReason } from '../core/trace-tail-core.ts';
import { readSessionTracePage } from '../session/core/session-trace-core.ts';
import { isSafePathSegment } from '../core/upload-core.ts';
import { appendJsonLines } from '../json-file.ts';
import { errorMessage } from '../../shared/text.ts';
import { TRACE_SUFFIX } from './trace-wiring-context.ts';
import type { TraceWiringContext } from './trace-wiring-context.ts';

interface TracePageRequest {
  after: number;
  endingAt?: number | 'tail';
}

interface TracePage {
  records: TraceRecord[];
  start: number;
  next: number;
  reset: boolean;
  path: string;
}

function isRewoundCursor(request: TracePageRequest, next: number): boolean {
  if (request.endingAt !== undefined) return false;
  return next < request.after;
}

function createTraceRecordStore(context: TraceWiringContext) {
  const { traceDirectory, emitter, laneLog, nowFn, bindingByGlimmervoidSessionId, pendingRecordsBySessionId } = context;
  let hasEnsuredDirectory = false;

  function traceFilePath(glimmervoidSessionId: string): string | null {
    if (!isSafePathSegment(glimmervoidSessionId)) return null;
    return path.join(traceDirectory, `${glimmervoidSessionId}${TRACE_SUFFIX}`);
  }

  async function readTracePage(glimmervoidSessionId: string, request: TracePageRequest): Promise<TracePage> {
    const filePath = traceFilePath(glimmervoidSessionId);
    if (!filePath) return { records: [], start: 0, next: 0, reset: isRewoundCursor(request, 0), path: '' };
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const openHandle = handle;
      const stat = await openHandle.stat();
      const page = await readSessionTracePage({
        after: request.after,
        ...(request.endingAt !== undefined ? { endingAt: request.endingAt } : {}),
        size: stat.size,
        now: nowFn(),
        vendorSessionId: bindingByGlimmervoidSessionId.get(glimmervoidSessionId)?.vendorSessionId ?? 'unknown',
        readBytes: async (offset: number, byteCount: number) => {
          const buffer = Buffer.alloc(byteCount);
          const { bytesRead } = await openHandle.read(buffer, 0, byteCount, offset);
          return buffer.subarray(0, bytesRead);
        },
      });
      return { ...page, reset: isRewoundCursor(request, page.next), path: filePath };
    } catch (error) {
      if (containmentRefusalReason(error) !== 'missing') throw error;
      return { records: [], start: 0, next: 0, reset: isRewoundCursor(request, 0), path: filePath };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function queueRecord(glimmervoidSessionId: string, record: unknown): void {
    if (!traceFilePath(glimmervoidSessionId)) return;
    const parsed = TraceRecordSchema.safeParse(record);
    if (!parsed.success) {
      laneLog.warn('record refused', { session: glimmervoidSessionId });
      return;
    }
    const existing = pendingRecordsBySessionId.get(glimmervoidSessionId);
    if (existing) {
      existing.push(parsed.data);
      return;
    }
    pendingRecordsBySessionId.set(glimmervoidSessionId, [parsed.data]);
  }

  function requeueAtHead(glimmervoidSessionId: string, records: TraceRecord[]): void {
    const queuedSince = pendingRecordsBySessionId.get(glimmervoidSessionId) || [];
    pendingRecordsBySessionId.set(glimmervoidSessionId, [...records, ...queuedSince]);
  }

  async function flushSession(glimmervoidSessionId: string): Promise<boolean> {
    const records = pendingRecordsBySessionId.get(glimmervoidSessionId);
    pendingRecordsBySessionId.delete(glimmervoidSessionId);
    const filePath = traceFilePath(glimmervoidSessionId);
    if (!filePath || !records || records.length === 0) return true;
    try {
      await appendJsonLines(filePath, records, { mkdir: !hasEnsuredDirectory, mode: 0o600 });
      hasEnsuredDirectory = true;
      emitter.emit('trace-appended', { id: glimmervoidSessionId });
      return true;
    } catch (error) {
      laneLog.warn('append failed', { session: glimmervoidSessionId, error: errorMessage(error) });
      requeueAtHead(glimmervoidSessionId, records);
      return false;
    }
  }

  async function flushEverySession(): Promise<void> {
    for (const glimmervoidSessionId of [...pendingRecordsBySessionId.keys()]) await flushSession(glimmervoidSessionId);
  }

  return { traceFilePath, readTracePage, queueRecord, flushSession, flushEverySession };
}

type TraceRecordStore = ReturnType<typeof createTraceRecordStore>;

export { createTraceRecordStore };
export type { TracePage, TracePageRequest, TraceRecordStore };
