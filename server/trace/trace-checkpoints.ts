import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import type { TraceCheckpoint } from '../../shared/contracts/trace.ts';
import { TraceCheckpoint as TraceCheckpointSchema } from '../../shared/contracts/trace.ts';
import {
  TRACE_TAIL_SCAN_BYTES,
  committedOffsetFromTraceTailOrNull,
  resumeOffsetFrom,
  withCommittedOffset,
} from '../core/trace-tail-core.ts';
import { isSafePathSegment } from '../core/upload-core.ts';
import { CHECKPOINT_SUFFIX } from './trace-wiring-context.ts';
import type { TraceBinding, TraceResumeState, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceRecordStore } from './trace-record-store.ts';

function committedOffsetOf(binding: TraceBinding): number {
  return Math.max(0, binding.tailState.offset - Buffer.byteLength(binding.tailState.carry, 'utf8'));
}

function createTraceCheckpoints(context: TraceWiringContext, recordStore: TraceRecordStore) {
  const { traceDirectory, maxRememberedSubagents, pendingRecordsBySessionId } = context;
  const { traceFilePath } = recordStore;

  function stampCommittedOffset(glimmervoidSessionId: string, transcriptOffset: number): void {
    const records = pendingRecordsBySessionId.get(glimmervoidSessionId);
    if (!records || records.length === 0) return;
    const last = records[records.length - 1];
    if (!last) return;
    records[records.length - 1] = { ...last, transcriptOffset };
  }

  async function writeCheckpoint(binding: TraceBinding): Promise<void> {
    const offset = committedOffsetOf(binding);
    binding.committedOffsetByTranscriptPath = withCommittedOffset(
      binding.committedOffsetByTranscriptPath,
      binding.transcriptPath,
      offset,
    );
    const checkpoint: TraceCheckpoint = {
      transcriptPath: binding.transcriptPath,
      vendorSessionId: binding.vendorSessionId,
      offset,
      ingestedSubagentPaths: Array.from(binding.subagentPathsWithoutOffset),
      offsetByTranscriptPath: binding.committedOffsetByTranscriptPath,
      subagentOffsetByPath: binding.subagentOffsetByPath,
    };
    await binding.checkpointWriter.write(checkpoint, () => JSON.stringify(checkpoint));
  }

  function checkpointFilePath(glimmervoidSessionId: string): string | null {
    if (!isSafePathSegment(glimmervoidSessionId)) return null;
    return path.join(traceDirectory, `${glimmervoidSessionId}${CHECKPOINT_SUFFIX}`);
  }

  async function readCheckpoint(glimmervoidSessionId: string): Promise<TraceCheckpoint | null> {
    const filePath = checkpointFilePath(glimmervoidSessionId);
    if (!filePath) return null;
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      const parsed = TraceCheckpointSchema.safeParse(raw);
      if (!parsed.success) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async function tracedOffsetOf(
    glimmervoidSessionId: string,
    transcriptPath: string,
    pathBeforeWindow: string | null,
  ): Promise<{ offset: number | null; scannedBytes: number; traceSize: number }> {
    const filePath = traceFilePath(glimmervoidSessionId);
    if (!filePath) return { offset: 0, scannedBytes: 0, traceSize: 0 };
    let handle: FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - TRACE_TAIL_SCAN_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return {
        offset: committedOffsetFromTraceTailOrNull(buffer.subarray(0, bytesRead).toString('utf8'), {
        transcriptPath,
        pathBeforeWindow,
        isWholeFile: start === 0,
        }),
        scannedBytes: bytesRead,
        traceSize: stat.size,
      };
    } catch {
      return { offset: 0, scannedBytes: 0, traceSize: 0 };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function resumeStateFor(
    glimmervoidSessionId: string,
    transcriptPath: string,
    size: number,
  ): Promise<TraceResumeState> {
    const checkpoint = await readCheckpoint(glimmervoidSessionId);
    const traceTail = await tracedOffsetOf(
      glimmervoidSessionId,
      transcriptPath,
      checkpoint ? checkpoint.transcriptPath : null,
    );
    const resume = resumeOffsetFrom(checkpoint, {
      transcriptPath,
      size,
      alreadyTracedOffset: traceTail.offset,
      traceSize: traceTail.traceSize,
    });
    const subagentOffsetByPath = checkpoint ? checkpoint.subagentOffsetByPath : {};
    const subagentPathsWithoutOffset = checkpoint
      ? checkpoint.ingestedSubagentPaths.filter((subagentPath) => !(subagentPath in subagentOffsetByPath))
      : [];
    return {
      offset: resume.offset,
      didReset: resume.didReset,
      didFallbackToTranscriptEnd: resume.didFallbackToTranscriptEnd,
      scannedBytes: traceTail.scannedBytes,
      committedOffsetByTranscriptPath: checkpoint ? checkpoint.offsetByTranscriptPath : {},
      subagentPathsWithoutOffset: subagentPathsWithoutOffset.slice(-maxRememberedSubagents),
      subagentOffsetByPath,
    };
  }

  return { stampCommittedOffset, writeCheckpoint, checkpointFilePath, resumeStateFor };
}

type TraceCheckpoints = ReturnType<typeof createTraceCheckpoints>;

export { committedOffsetOf, createTraceCheckpoints };
export type { TraceCheckpoints };
