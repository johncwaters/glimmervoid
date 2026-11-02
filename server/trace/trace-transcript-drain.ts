import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { openContainedFile } from '../contained-file.ts';
import { applyRead, createTailState, isTailCurrent } from '../core/transcript-tail-core.ts';
import { traceRecordsFromTranscriptLine } from '../core/trace-core.ts';
import {
  MAX_TRANSCRIPT_READ_BYTES,
  completeLineBytes,
  containmentRefusalReason,
  isOversizedPartialLine,
  planContiguousRead,
} from '../core/trace-tail-core.ts';
import type { ContainmentRefusal } from '../core/trace-tail-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { MAX_REMEMBERED_FILE_REFUSALS, projectsRoot, trimOldest } from './trace-wiring-context.ts';
import type { LineContext, TraceBinding, TraceResumeState, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceRecordStore } from './trace-record-store.ts';
import { committedOffsetOf } from './trace-checkpoints.ts';
import type { TraceCheckpoints } from './trace-checkpoints.ts';

interface PendingCommit {
  didAppend: boolean;
  appendedRecordCount: number;
}

function createTraceTranscriptDrain(
  context: TraceWiringContext,
  recordStore: TraceRecordStore,
  checkpoints: TraceCheckpoints,
) {
  const { laneLog, nowFn, pendingRecordsBySessionId } = context;
  const { queueRecord, flushSession } = recordStore;
  const { stampCommittedOffset, writeCheckpoint, resumeStateFor } = checkpoints;

  function queueSessionRecord(binding: TraceBinding, reason: string | null): void {
    queueRecord(binding.glimmervoidSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'session',
      vendor: binding.vendor,
      transcriptPath: binding.transcriptPath,
      ...(reason ? { reason } : {}),
    });
  }

  function noteSkippedBytes(binding: TraceBinding, filePath: string, skippedBytes: number): void {
    queueRecord(binding.glimmervoidSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: `skipped ${skippedBytes} bytes of ${path.basename(filePath)}`,
    });
  }

  function queueFileRefusalNotice(binding: TraceBinding, filePath: string, reason: ContainmentRefusal): boolean {
    const refusalKey = `${filePath}:${reason}`;
    if (binding.notedFileRefusals.has(refusalKey)) return false;
    binding.notedFileRefusals.add(refusalKey);
    trimOldest(binding.notedFileRefusals, MAX_REMEMBERED_FILE_REFUSALS);
    if (reason === 'missing') return false;
    queueRecord(binding.glimmervoidSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: `refused ${path.basename(filePath)}: ${reason}`,
    });
    return true;
  }

  function noteRecoveryFallback(binding: TraceBinding): void {
    queueRecord(binding.glimmervoidSessionId, {
      ts: nowFn(),
      uuid: null,
      parentUuid: null,
      vendorSessionId: binding.vendorSessionId,
      kind: 'notice',
      text: 'recovery could not establish the run, resuming at the transcript end',
    });
  }

  function noteResumeOutcome(binding: TraceBinding, resumed: TraceResumeState): void {
    queueSessionRecord(binding, resumed.didReset ? 'transcript smaller than the stored checkpoint' : null);
    if (!resumed.didFallbackToTranscriptEnd) return;
    noteRecoveryFallback(binding);
    laneLog.warn('trace recovery fell back to the transcript end', {
      session: binding.glimmervoidSessionId,
      path: binding.transcriptPath,
      scannedBytes: resumed.scannedBytes,
    });
  }

  function mapAndAppend(rawLine: string, binding: TraceBinding, context: LineContext = {}): void {
    const records = traceRecordsFromTranscriptLine(rawLine, {
      vendorSessionId: binding.vendorSessionId,
      now: nowFn(),
      ...context,
    });
    for (const record of records) {
      queueRecord(binding.glimmervoidSessionId, record);
    }
  }

  async function readOnce(binding: TraceBinding, handle: FileHandle): Promise<void> {
    const stat = await handle.stat();
    const plan = planContiguousRead(binding.tailState, stat, { maxReadBytes: MAX_TRANSCRIPT_READ_BYTES });
    if (plan.reset) {
      binding.tailState.offset = 0;
      binding.tailState.carry = '';
      binding.isSkippingOversizedLine = false;
      queueSessionRecord(binding, 'transcript reset below the recorded offset');
    }
    if (plan.action === 'skip') return;
    const buffer = Buffer.alloc(plan.end - plan.start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, plan.start);
    if (bytesRead <= 0) return;
    const chunk = buffer.subarray(0, bytesRead);
    const wholeLineBytes = completeLineBytes(chunk);
    const usableBytes = wholeLineBytes > 0 ? wholeLineBytes : bytesRead;
    const lines = applyRead(binding.tailState, {
      text: chunk.subarray(0, usableBytes).toString('utf8'),
      end: plan.start + usableBytes,
      stat,
      dropPartial: binding.isSkippingOversizedLine,
    });
    binding.isSkippingOversizedLine = false;
    for (const line of lines) mapAndAppend(line, binding);
    if (!isOversizedPartialLine(binding.tailState.carry)) return;
    noteSkippedBytes(binding, binding.transcriptPath, Buffer.byteLength(binding.tailState.carry, 'utf8'));
    binding.tailState.carry = '';
    binding.isSkippingOversizedLine = true;
  }

  async function commitPending(binding: TraceBinding): Promise<PendingCommit> {
    stampCommittedOffset(binding.glimmervoidSessionId, committedOffsetOf(binding));
    const recordCount = pendingRecordsBySessionId.get(binding.glimmervoidSessionId)?.length ?? 0;
    const didAppend = await flushSession(binding.glimmervoidSessionId);
    if (!didAppend) return { didAppend, appendedRecordCount: 0 };
    await writeCheckpoint(binding);
    return { didAppend, appendedRecordCount: recordCount };
  }

  async function isTranscriptUnchanged(binding: TraceBinding): Promise<boolean> {
    if (!binding.hasOpenedTranscript || binding.bindingBeforeFirstOpen) return false;
    if (pendingRecordsBySessionId.has(binding.glimmervoidSessionId)) return false;
    try {
      return isTailCurrent(binding.tailState, await fs.promises.stat(binding.transcriptPath));
    } catch {
      return false;
    }
  }

  async function drainBinding(binding: TraceBinding): Promise<void> {
    if (await isTranscriptUnchanged(binding)) return;
    const opened = await openContainedFile(binding.transcriptPath, projectsRoot());
    if (!opened.ok) {
      if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
      if (!binding.hasOpenedTranscript) {
        try {
          await fs.promises.lstat(binding.transcriptPath);
        } catch (error) {
          if (containmentRefusalReason(error) === 'missing') return;
        }
      }
      if (!binding.hasWarnedUnreadable) laneLog.warn('transcript unreadable', { session: binding.glimmervoidSessionId });
      binding.hasWarnedUnreadable = true;
      return;
    }
    binding.hasWarnedUnreadable = false;
    let committedOffsetBeforeRead = committedOffsetOf(binding);
    try {
      if (!binding.hasOpenedTranscript) {
        if (binding.bindingBeforeFirstOpen) await drainBinding(binding.bindingBeforeFirstOpen);
        binding.bindingBeforeFirstOpen = null;
        binding.transcriptPath = opened.file.realPath;
        const stat = await opened.file.handle.stat();
        const resumed = await resumeStateFor(binding.glimmervoidSessionId, binding.transcriptPath, stat.size);
        binding.committedOffsetByTranscriptPath = resumed.committedOffsetByTranscriptPath;
        binding.subagentPathsWithoutOffset = new Set<string>(resumed.subagentPathsWithoutOffset);
        binding.subagentOffsetByPath = resumed.subagentOffsetByPath;
        binding.tailState = createTailState(stat, { path: binding.transcriptPath });
        binding.tailState.offset = resumed.offset;
        binding.hasOpenedTranscript = true;
        noteResumeOutcome(binding, resumed);
        committedOffsetBeforeRead = committedOffsetOf(binding);
      }
      await readOnce(binding, opened.file.handle);
    } catch (error) {
      laneLog.warn('transcript read failed', { error: errorMessage(error) });
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
    const commit = await commitPending(binding);
    if (!commit.didAppend) return;
    const committedOffsetAfterRead = committedOffsetOf(binding);
    if (committedOffsetAfterRead <= committedOffsetBeforeRead) return;
    laneLog.debugNote(
      () => 'drained',
      () => ({
        session: binding.glimmervoidSessionId,
        records: commit.appendedRecordCount,
        bytes: committedOffsetAfterRead - committedOffsetBeforeRead,
        offset: committedOffsetAfterRead,
      }),
    );
  }

  return { noteSkippedBytes, queueFileRefusalNotice, noteResumeOutcome, mapAndAppend, commitPending, drainBinding };
}

type TraceTranscriptDrain = ReturnType<typeof createTraceTranscriptDrain>;

export { createTraceTranscriptDrain };
export type { TraceTranscriptDrain };
