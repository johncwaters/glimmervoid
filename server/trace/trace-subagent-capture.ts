import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { openContainedFile } from '../contained-file.ts';
import { applyRead, createTailState } from '../core/transcript-tail-core.ts';
import {
  LINE_BREAK,
  MAX_SUBAGENT_CHUNKS_PER_STOP,
  MAX_TRANSCRIPT_READ_BYTES,
  completeLineBytes,
  isOversizedPartialLine,
  planContiguousRead,
  withCommittedOffset,
} from '../core/trace-tail-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { isPathInside } from '../../shared/paths.ts';
import { realProjectsRoot } from './trace-wiring-context.ts';
import type { LineContext, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceTranscriptDrain } from './trace-transcript-drain.ts';

const NO_BYTES = Buffer.alloc(0);

async function isResumePointMidLine(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset <= 0) return false;
  const byteBeforeOffset = Buffer.alloc(1);
  const { bytesRead } = await handle.read(byteBeforeOffset, 0, 1, offset - 1);
  if (bytesRead <= 0) return false;
  return byteBeforeOffset[0] !== LINE_BREAK;
}

function createTraceSubagentCapture(context: TraceWiringContext, drain: TraceTranscriptDrain) {
  const { laneLog, maxRememberedSubagents, bindingByGlimmervoidSessionId } = context;
  const { noteSkippedBytes, queueFileRefusalNotice, mapAndAppend, commitPending, drainBinding } = drain;

  async function readSubagentTranscript(
    glimmervoidSessionId: string,
    eventPayload: Record<string, unknown>,
  ): Promise<void> {
    const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!binding) return;
    const rawPath = typeof eventPayload.agent_transcript_path === 'string'
      ? eventPayload.agent_transcript_path
      : '';
    if (!rawPath) return;
    const subagentPath = path.resolve(rawPath);
    const subagentRoot = path.dirname(binding.transcriptPath);
    const resolvedProjectsRoot = await realProjectsRoot();
    if (!resolvedProjectsRoot || !isPathInside(resolvedProjectsRoot, subagentRoot, { allowEqual: false })) {
      const reason = resolvedProjectsRoot ? 'outside-root' : 'root-unresolvable';
      laneLog.warnOnce(`subagent:${binding.glimmervoidSessionId}:${reason}`, 'subagent transcript refused', {
        session: binding.glimmervoidSessionId,
        path: subagentPath,
        root: subagentRoot,
        reason,
      });
      return;
    }
    const opened = await openContainedFile(subagentPath, subagentRoot);
    if (!opened.ok) {
      laneLog.warnOnce(`subagent:${binding.glimmervoidSessionId}:${opened.reason}`, 'subagent transcript refused', {
        session: binding.glimmervoidSessionId,
        path: subagentPath,
        root: subagentRoot,
        reason: opened.reason,
      });
      if (!binding.hasOpenedTranscript) return;
      if (!queueFileRefusalNotice(binding, subagentPath, opened.reason)) return;
      await commitPending(binding);
      return;
    }
    let mappedLineCount = 0;
    let bytesRead = 0;
    try {
      await drainBinding(binding);
      if (!binding.hasOpenedTranscript) return;
      const stat = await opened.file.handle.stat();
      const agentId = typeof eventPayload.agent_id === 'string' && eventPayload.agent_id
        ? eventPayload.agent_id
        : undefined;
      const agentType = typeof eventPayload.agent_type === 'string' && eventPayload.agent_type
        ? eventPayload.agent_type
        : undefined;
      const context: LineContext = {
        ...(agentId ? { agentId } : {}),
        ...(agentType ? { agentType } : {}),
      };
      const sidechainState = createTailState(stat, { path: subagentPath });
      const rememberedOffset = binding.subagentOffsetByPath[subagentPath];
      sidechainState.offset = rememberedOffset
        ?? (binding.subagentPathsWithoutOffset.has(subagentPath) ? stat.size : 0);
      let isSkippingOversizedLine = await isResumePointMidLine(opened.file.handle, sidechainState.offset);
      let partialLineBytes = NO_BYTES;
      let committedOffset = sidechainState.offset;
      for (let chunkIndex = 0; chunkIndex < MAX_SUBAGENT_CHUNKS_PER_STOP; chunkIndex += 1) {
        const plan = planContiguousRead(sidechainState, stat, { maxReadBytes: MAX_TRANSCRIPT_READ_BYTES });
        if (plan.reset) {
          sidechainState.offset = 0;
          sidechainState.carry = '';
          partialLineBytes = NO_BYTES;
          isSkippingOversizedLine = false;
          committedOffset = 0;
        }
        if (plan.action === 'skip') break;
        const buffer = Buffer.alloc(plan.end - plan.start);
        const read = await opened.file.handle.read(buffer, 0, buffer.length, plan.start);
        if (read.bytesRead <= 0) break;
        bytesRead += read.bytesRead;
        const carriedBytes = plan.reset ? NO_BYTES : partialLineBytes;
        const readBytes = buffer.subarray(0, read.bytesRead);
        const chunk = carriedBytes.length > 0 ? Buffer.concat([carriedBytes, readBytes]) : readBytes;
        const wholeLineBytes = completeLineBytes(chunk);
        const readEnd = plan.start + read.bytesRead;
        const lines = applyRead(sidechainState, {
          text: chunk.subarray(0, wholeLineBytes).toString('utf8'),
          end: readEnd,
          stat,
          reset: plan.reset,
          dropPartial: isSkippingOversizedLine,
        });
        isSkippingOversizedLine = isSkippingOversizedLine && wholeLineBytes === 0;
        partialLineBytes = isSkippingOversizedLine ? NO_BYTES : chunk.subarray(wholeLineBytes);
        committedOffset = readEnd - partialLineBytes.length;
        mappedLineCount += lines.length;
        for (const line of lines) mapAndAppend(line, binding, context);
        if (!isOversizedPartialLine(partialLineBytes)) continue;
        noteSkippedBytes(binding, subagentPath, partialLineBytes.length);
        partialLineBytes = NO_BYTES;
        committedOffset = readEnd;
        isSkippingOversizedLine = true;
      }
      binding.subagentOffsetByPath = withCommittedOffset(
        binding.subagentOffsetByPath,
        subagentPath,
        committedOffset,
        { maxRemembered: maxRememberedSubagents },
      );
      binding.subagentPathsWithoutOffset.delete(subagentPath);
    } catch (error) {
      laneLog.warn('subagent transcript read failed', { error: errorMessage(error) });
      return;
    } finally {
      await opened.file.handle.close().catch(() => {});
    }
    await commitPending(binding);
    laneLog.debugNote(
      () => 'subagent captured',
      () => ({ session: glimmervoidSessionId, records: mappedLineCount, bytes: bytesRead }),
    );
  }

  return { readSubagentTranscript };
}

type TraceSubagentCapture = ReturnType<typeof createTraceSubagentCapture>;

export { createTraceSubagentCapture };
export type { TraceSubagentCapture };
