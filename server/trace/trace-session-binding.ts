import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import { createTailState } from '../core/transcript-tail-core.ts';
import { createJsonStateWriter } from '../json-file.ts';
import { errorMessage } from '../../shared/text.ts';
import { MANAGER_DECISION_EVENT, ManagerDecision } from '../../shared/contracts/question-manager.ts';
import { MAX_RAW_LINE_CHARS } from '../../shared/contracts/trace.ts';
import { MAX_REMEMBERED_CLOSED_SESSIONS, projectsRoot, trimOldest } from './trace-wiring-context.ts';
import type { TraceBinding, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceRecordStore } from './trace-record-store.ts';
import type { TraceCheckpoints } from './trace-checkpoints.ts';
import type { TraceTranscriptDrain } from './trace-transcript-drain.ts';
import type { TraceSubagentCapture } from './trace-subagent-capture.ts';

interface TraceSession {
  id: string;
  deliveredSecretValues?(): readonly string[];
  on(event: string, listener: (payload: Record<string, unknown>) => void): unknown;
}

interface TraceSessionBindingDeps {
  recordStore: TraceRecordStore;
  checkpoints: TraceCheckpoints;
  drain: TraceTranscriptDrain;
  subagentCapture: TraceSubagentCapture;
}

function predecessorAwaitingDrain(previous: TraceBinding | undefined): TraceBinding | null {
  if (!previous) return null;
  if (previous.hasOpenedTranscript) return previous;
  const inherited = previous.bindingBeforeFirstOpen;
  previous.bindingBeforeFirstOpen = null;
  return inherited;
}

function createTraceSessionBinding(context: TraceWiringContext, deps: TraceSessionBindingDeps) {
  const {
    laneLog,
    bindingByGlimmervoidSessionId,
    awaitingTranscriptByGlimmervoidSessionId,
    closedSessionIds,
    deliveredSecretValuesBySessionId,
    chain,
    isStopped,
  } = context;
  const { traceFilePath, queueRecord, flushSession } = deps.recordStore;
  const { checkpointFilePath, resumeStateFor } = deps.checkpoints;
  const { noteResumeOutcome, drainBinding } = deps.drain;
  const { readSubagentTranscript } = deps.subagentCapture;
  const attachedSessions = new WeakSet<object>();
  const conversationVendorSessionIdByGlimmervoidSessionId = new Map<string, string>();

  async function bindSession(
    glimmervoidSessionId: string,
    vendorSessionId: string,
    vendor: string,
    requestedTranscriptPath: string,
  ): Promise<void> {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const checkpointPath = checkpointFilePath(glimmervoidSessionId);
    if (!checkpointPath) return;
    const containedTranscript = await openContainedFile(requestedTranscriptPath, projectsRoot(), true);
    if (!containedTranscript.ok && containedTranscript.reason === 'missing') {
      awaitingTranscriptByGlimmervoidSessionId.set(glimmervoidSessionId, { id: vendorSessionId, vendor, transcriptPath: requestedTranscriptPath });
    }
    if (!containedTranscript.ok) {
      laneLog.warnOnce(`bind:${glimmervoidSessionId}:${containedTranscript.reason}`, 'transcript refused', {
        session: glimmervoidSessionId,
        path: requestedTranscriptPath,
        root: projectsRoot(),
        reason: containedTranscript.reason,
      });
      return;
    }
    awaitingTranscriptByGlimmervoidSessionId.delete(glimmervoidSessionId);
    const transcriptPath = containedTranscript.file.realPath;
    const transcriptStat = 'handle' in containedTranscript.file ? containedTranscript.file.stat : null;
    if ('handle' in containedTranscript.file) await containedTranscript.file.handle.close().catch(() => {});
    const previous = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (previous) {
      bindingByGlimmervoidSessionId.delete(glimmervoidSessionId);
      await drainBinding(previous);
    }
    const resumed = transcriptStat
      ? await resumeStateFor(glimmervoidSessionId, transcriptPath, transcriptStat.size)
      : null;
    const tailState = createTailState(transcriptStat, { path: transcriptPath });
    tailState.offset = resumed ? resumed.offset : 0;
    const binding: TraceBinding = {
      glimmervoidSessionId,
      vendorSessionId,
      vendor,
      transcriptPath,
      requestedTranscriptPath,
      tailState,
      subagentPathsWithoutOffset: new Set<string>(resumed ? resumed.subagentPathsWithoutOffset : []),
      subagentOffsetByPath: resumed ? resumed.subagentOffsetByPath : {},
      notedFileRefusals: new Set<string>(),
      committedOffsetByTranscriptPath: resumed ? resumed.committedOffsetByTranscriptPath : {},
      checkpointWriter: createJsonStateWriter({
        filePath: checkpointPath,
        warn: (error: unknown) => { laneLog.warn('checkpoint write failed', { error: errorMessage(error) }); },
      }),
      bindingBeforeFirstOpen: transcriptStat ? null : predecessorAwaitingDrain(previous),
      isSkippingOversizedLine: false,
      hasOpenedTranscript: transcriptStat !== null,
      hasWarnedUnreadable: false,
      isClosing: false,
    };
    if (resumed) noteResumeOutcome(binding, resumed);
    bindingByGlimmervoidSessionId.set(glimmervoidSessionId, binding);
    await drainBinding(binding);
  }

  function noteVendorSession(glimmervoidSessionId: string, eventPayload: Record<string, unknown>): void {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const vendorSessionId = typeof eventPayload.id === 'string' ? eventPayload.id : '';
    const vendor = typeof eventPayload.vendor === 'string' ? eventPayload.vendor : 'claude';
    if (!vendorSessionId || vendor !== 'claude') return;
    if (!traceFilePath(glimmervoidSessionId)) return;
    const rawPath = typeof eventPayload.transcriptPath === 'string' ? eventPayload.transcriptPath : '';
    if (!rawPath) return;
    const requestedTranscriptPath = path.resolve(rawPath);
    const bound = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (bound
      && bound.vendorSessionId === vendorSessionId
      && bound.requestedTranscriptPath === requestedTranscriptPath) return;
    chain(() => bindSession(glimmervoidSessionId, vendorSessionId, vendor, requestedTranscriptPath), 'binding failed');
  }

  function noteHookEvent(glimmervoidSessionId: string, eventRecord: Record<string, unknown>): void {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const awaitedTranscript = awaitingTranscriptByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (awaitedTranscript) {
      awaitingTranscriptByGlimmervoidSessionId.delete(glimmervoidSessionId);
      noteVendorSession(glimmervoidSessionId, awaitedTranscript);
    }
    const hookEvent = typeof eventRecord.event === 'string' ? eventRecord.event.toLowerCase() : '';
    if (hookEvent !== 'subagentstop') return;
    const payload = eventRecord.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    chain(
      () => readSubagentTranscript(glimmervoidSessionId, payload as Record<string, unknown>),
      'subagent capture failed',
    );
  }

  function detachSession(glimmervoidSessionId: string): void {
    chain(async () => {
      const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
      if (!binding) return;
      bindingByGlimmervoidSessionId.delete(glimmervoidSessionId);
      await drainBinding(binding);
    }, 'final drain failed');
  }

  async function drainClosingBinding(glimmervoidSessionId: string): Promise<void> {
    const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!binding) return;
    binding.isClosing = true;
    await drainBinding(binding);
  }

  function closeSession(glimmervoidSessionId: string): void {
    closedSessionIds.add(glimmervoidSessionId);
    awaitingTranscriptByGlimmervoidSessionId.delete(glimmervoidSessionId);
    conversationVendorSessionIdByGlimmervoidSessionId.delete(glimmervoidSessionId);
    trimOldest(closedSessionIds, MAX_REMEMBERED_CLOSED_SESSIONS);
    chain(async () => {
      try {
        await drainClosingBinding(glimmervoidSessionId);
      } finally {
        deliveredSecretValuesBySessionId.delete(glimmervoidSessionId);
      }
    }, 'final drain failed');
  }

  function appendConversationRecords(glimmervoidSessionId: string, records: unknown): void {
    if (isStopped() || !Array.isArray(records) || records.length === 0) return;
    for (const record of records) queueRecord(glimmervoidSessionId, record);
    const lastVendorSessionId: unknown = records.at(-1)?.vendorSessionId;
    if (typeof lastVendorSessionId === 'string' && lastVendorSessionId.length > 0) conversationVendorSessionIdByGlimmervoidSessionId.set(glimmervoidSessionId, lastVendorSessionId);
    chain(async () => { await flushSession(glimmervoidSessionId); }, 'conversation append failed');
  }

  function managerDecisionText(decision: ManagerDecision): string {
    if (decision.outcome === 'escalated') return `Question manager passed to you: ${decision.questions.join('; ')} (${decision.reason})`;
    const answered = Object.entries(decision.answers).map(([question, answer]) => `${question}: ${answer}`).join('; ');
    return `Question manager answered ${answered} (${decision.rule})`;
  }

  function appendManagerDecisionNotice(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = ManagerDecision.safeParse(payload.decision);
    if (!parsed.success) return;
    const vendorSessionId = bindingByGlimmervoidSessionId.get(glimmervoidSessionId)?.vendorSessionId
      ?? awaitingTranscriptByGlimmervoidSessionId.get(glimmervoidSessionId)?.id
      ?? conversationVendorSessionIdByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!vendorSessionId) return;
    appendConversationRecords(glimmervoidSessionId, [{
      ts: parsed.data.ts,
      uuid: null,
      parentUuid: null,
      vendorSessionId,
      kind: 'notice',
      text: managerDecisionText(parsed.data).slice(0, MAX_RAW_LINE_CHARS),
    }]);
  }

  function attachSession(session: TraceSession): void {
    if (attachedSessions.has(session)) return;
    attachedSessions.add(session);
    deliveredSecretValuesBySessionId.set(session.id, () => session.deliveredSecretValues?.() ?? []);
    session.on('claude-session-id', (payload) => { noteVendorSession(session.id, payload); });
    session.on('hook-event', (record) => { noteHookEvent(session.id, record); });
    session.on('conversation-records', ({ records }) => { appendConversationRecords(session.id, records); });
    session.on(MANAGER_DECISION_EVENT, (payload) => { appendManagerDecisionNotice(session.id, payload); });
    session.on('exit', () => { detachSession(session.id); });
    session.on('teardown', () => { closeSession(session.id); });
  }

  return { attachSession };
}

export { createTraceSessionBinding };
