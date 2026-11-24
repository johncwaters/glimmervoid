import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import { createTailState } from '../core/transcript-tail-core.ts';
import { createJsonStateWriter } from '../json-file.ts';
import { watchPath } from '../path-watch.ts';
import { errorMessage } from '../../shared/text.ts';
import { MANAGER_DECISION_EVENT, ManagerDecision } from '../../shared/contracts/question-manager.ts';
import { BACKGROUND_TASK_SIGNAL_EVENT, BackgroundTaskSignal, MAX_RAW_LINE_CHARS, SUBAGENT_SIGNAL_EVENT, SubagentSignal } from '../../shared/contracts/trace.ts';
import { MAX_REMEMBERED_CLOSED_SESSIONS, stopFollowingBinding, trimOldest } from './trace-wiring-context.ts';
import { containmentRootFor, relaySourceOf, transcriptSourceOf } from './conversation-sources.ts';
import type { TranscriptConversationSource } from './conversation-sources.ts';
import type { TraceBinding, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceRecordStore } from './trace-record-store.ts';
import type { TraceCheckpoints } from './trace-checkpoints.ts';
import type { TraceTranscriptDrain } from './trace-transcript-drain.ts';
import type { TraceSubagentCapture } from './trace-subagent-capture.ts';

interface TraceSession {
  id: string;
  agentId: string;
  launchEnv(): Record<string, string | undefined>;
  deliveredSecretValues?(): readonly string[];
  on(event: string, listener: (payload: Record<string, unknown>) => void): unknown;
}

interface TraceSessionBindingDeps {
  recordStore: TraceRecordStore;
  checkpoints: TraceCheckpoints;
  drain: TraceTranscriptDrain;
  subagentCapture: TraceSubagentCapture;
}

const TRANSCRIPT_WATCH_DEBOUNCE_MS = 50;

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
    agentIdBySessionId,
    chain,
    isStopped,
    nowFn,
  } = context;
  const { traceFilePath, queueRecord, flushSession } = deps.recordStore;
  const { checkpointFilePath, resumeStateFor } = deps.checkpoints;
  const { noteResumeOutcome, drainBinding } = deps.drain;
  const { readSubagentTranscript } = deps.subagentCapture;
  const attachedSessions = new WeakSet<object>();
  const conversationVendorSessionIdByGlimmervoidSessionId = new Map<string, string>();
  const launchEnvByGlimmervoidSessionId = new Map<string, () => Record<string, string | undefined>>();

  async function bindSession(
    glimmervoidSessionId: string,
    vendorSessionId: string,
    vendor: string,
    source: TranscriptConversationSource,
    requestedTranscriptPath: string,
  ): Promise<void> {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const checkpointPath = checkpointFilePath(glimmervoidSessionId);
    if (!checkpointPath) return;
    const launchEnv = launchEnvByGlimmervoidSessionId.get(glimmervoidSessionId)?.() ?? process.env;
    const containmentRoot = containmentRootFor(source, launchEnv, requestedTranscriptPath);
    const containedTranscript = await openContainedFile(requestedTranscriptPath, containmentRoot, true);
    if (!containedTranscript.ok && containedTranscript.reason === 'missing') {
      awaitingTranscriptByGlimmervoidSessionId.set(glimmervoidSessionId, { id: vendorSessionId, vendor, transcriptPath: requestedTranscriptPath });
    }
    if (!containedTranscript.ok) {
      laneLog.warnOnce(`bind:${glimmervoidSessionId}:${containedTranscript.reason}`, 'transcript refused', {
        session: glimmervoidSessionId,
        path: requestedTranscriptPath,
        root: containmentRoot,
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
      source,
      containmentRoot,
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
      stopFollowingTranscript: () => {},
    };
    if (resumed) noteResumeOutcome(binding, resumed);
    for (const replaced of [previous, previous?.bindingBeforeFirstOpen]) {
      if (replaced && replaced !== binding.bindingBeforeFirstOpen) replaced.stopFollowingTranscript();
    }
    bindingByGlimmervoidSessionId.set(glimmervoidSessionId, binding);
    binding.stopFollowingTranscript = watchPath(transcriptPath, () => drainWhileBound(binding), {
      debounceMs: TRANSCRIPT_WATCH_DEBOUNCE_MS,
      onUnwatchable: (target, reason) => laneLog.warnOnce(`watch:${glimmervoidSessionId}`, 'transcript unwatchable; trace fills at turn end', { session: glimmervoidSessionId, path: target, reason }),
    });
    await drainBinding(binding);
  }

  function drainAtTurnEnd(glimmervoidSessionId: string): void {
    chain(async () => {
      const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
      if (isStopped() || !binding || binding.isClosing) return;
      await drainBinding(binding);
    }, 'turn-end drain failed');
  }

  function drainWhileBound(binding: TraceBinding): void {
    chain(async () => {
      const current = bindingByGlimmervoidSessionId.get(binding.glimmervoidSessionId);
      const drainTarget = current === binding || current?.bindingBeforeFirstOpen === binding ? current : null;
      if (drainTarget === null) {
        binding.stopFollowingTranscript();
        return;
      }
      if (isStopped() || drainTarget.isClosing) return;
      await drainBinding(drainTarget);
    }, 'drain failed');
  }

  function locateAndBind(glimmervoidSessionId: string, vendorSessionId: string, vendor: string, source: TranscriptConversationSource, bound: TraceBinding | undefined): void {
    const { locateTranscript } = source;
    if (!locateTranscript || bound?.vendorSessionId === vendorSessionId) return;
    chain(async () => {
      const launchEnv = launchEnvByGlimmervoidSessionId.get(glimmervoidSessionId)?.() ?? process.env;
      const locatedPath = await locateTranscript(vendorSessionId, launchEnv);
      if (!locatedPath) {
        if (closedSessionIds.has(glimmervoidSessionId)) return;
        awaitingTranscriptByGlimmervoidSessionId.set(glimmervoidSessionId, { id: vendorSessionId, vendor, transcriptPath: '' });
        return;
      }
      await bindSession(glimmervoidSessionId, vendorSessionId, vendor, source, locatedPath);
    }, 'transcript locate failed');
  }

  function noteVendorSession(glimmervoidSessionId: string, eventPayload: Record<string, unknown>): void {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const vendorSessionId = typeof eventPayload.id === 'string' ? eventPayload.id : '';
    const source = transcriptSourceOf(agentIdBySessionId.get(glimmervoidSessionId) ?? '');
    if (!vendorSessionId || !source) return;
    const vendor = typeof eventPayload.vendor === 'string' ? eventPayload.vendor : '';
    if (!vendor) return;
    if (!traceFilePath(glimmervoidSessionId)) return;
    const rawPath = typeof eventPayload.transcriptPath === 'string' ? eventPayload.transcriptPath : '';
    const bound = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!rawPath) {
      locateAndBind(glimmervoidSessionId, vendorSessionId, vendor, source, bound);
      return;
    }
    const requestedTranscriptPath = path.resolve(rawPath);
    if (bound
      && bound.vendorSessionId === vendorSessionId
      && bound.requestedTranscriptPath === requestedTranscriptPath) return;
    chain(() => bindSession(glimmervoidSessionId, vendorSessionId, vendor, source, requestedTranscriptPath), 'binding failed');
  }

  function noteHookEvent(glimmervoidSessionId: string, eventRecord: Record<string, unknown>): void {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const awaitedTranscript = awaitingTranscriptByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (awaitedTranscript) {
      awaitingTranscriptByGlimmervoidSessionId.delete(glimmervoidSessionId);
      noteVendorSession(glimmervoidSessionId, awaitedTranscript);
    }
    const hookEvent = typeof eventRecord.event === 'string' ? eventRecord.event.toLowerCase() : '';
    const payload = eventRecord.payload;
    const relaySource = relaySourceOf(agentIdBySessionId.get(glimmervoidSessionId) ?? '');
    if (relaySource && hookEvent === relaySource.hookEvent.toLowerCase()) {
      appendConversationRecords(glimmervoidSessionId, relaySource.recordsFromPayload(payload, nowFn()));
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const payloadRecord = payload as Record<string, unknown>;
    const isSubagentStop = hookEvent === 'subagentstop'
      || (hookEvent === 'stop' && typeof payloadRecord.agent_id === 'string' && payloadRecord.agent_id.length > 0);
    if (!isSubagentStop) return;
    chain(
      () => readSubagentTranscript(glimmervoidSessionId, payloadRecord),
      'subagent capture failed',
    );
  }

  function detachSession(glimmervoidSessionId: string): void {
    chain(async () => {
      const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
      if (!binding) return;
      bindingByGlimmervoidSessionId.delete(glimmervoidSessionId);
      stopFollowingBinding(binding);
      await drainBinding(binding);
    }, 'final drain failed');
  }

  async function drainClosingBinding(glimmervoidSessionId: string): Promise<void> {
    const binding = bindingByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!binding) return;
    binding.isClosing = closedSessionIds.has(glimmervoidSessionId);
    if (binding.isClosing) stopFollowingBinding(binding);
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
        if (closedSessionIds.has(glimmervoidSessionId)) forgetSessionInputs(glimmervoidSessionId);
      }
    }, 'final drain failed');
  }

  function forgetSessionInputs(glimmervoidSessionId: string): void {
    deliveredSecretValuesBySessionId.delete(glimmervoidSessionId);
    agentIdBySessionId.delete(glimmervoidSessionId);
    launchEnvByGlimmervoidSessionId.delete(glimmervoidSessionId);
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

  function knownVendorSessionId(glimmervoidSessionId: string): unknown {
    return bindingByGlimmervoidSessionId.get(glimmervoidSessionId)?.vendorSessionId
      ?? awaitingTranscriptByGlimmervoidSessionId.get(glimmervoidSessionId)?.id
      ?? conversationVendorSessionIdByGlimmervoidSessionId.get(glimmervoidSessionId);
  }

  function appendSentAttachments(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
    if (!vendorSessionId) return;
    appendConversationRecords(glimmervoidSessionId, [{ ts: payload.ts, uuid: null, parentUuid: null, vendorSessionId, kind: 'attachments', files: payload.files, pastedPrefix: payload.pastedPrefix }]);
  }

  function appendSentBoardAnswer(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
    if (!vendorSessionId) return;
    appendConversationRecords(glimmervoidSessionId, [{ ts: payload.ts, uuid: null, parentUuid: null, vendorSessionId, kind: 'board-answer' }]);
  }

  function appendSubagentSignal(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = SubagentSignal.safeParse(payload);
    if (!parsed.success) return;
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
    if (!vendorSessionId) return;
    appendConversationRecords(glimmervoidSessionId, [{ uuid: null, parentUuid: null, vendorSessionId, kind: 'subagent', ...parsed.data }]);
  }

  function appendBackgroundTaskSignal(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = BackgroundTaskSignal.safeParse(payload);
    if (!parsed.success) return;
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
    if (!vendorSessionId) return;
    appendConversationRecords(glimmervoidSessionId, [{ uuid: null, parentUuid: null, vendorSessionId, kind: 'background-task', ...parsed.data }]);
  }

  function appendManagerDecisionNotice(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = ManagerDecision.safeParse(payload.decision);
    if (!parsed.success) return;
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
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
    closedSessionIds.delete(session.id);
    deliveredSecretValuesBySessionId.set(session.id, () => session.deliveredSecretValues?.() ?? []);
    agentIdBySessionId.set(session.id, session.agentId);
    launchEnvByGlimmervoidSessionId.set(session.id, () => session.launchEnv());
    session.on('claude-session-id', (payload) => { noteVendorSession(session.id, payload); });
    session.on('hook-event', (record) => { noteHookEvent(session.id, record); });
    session.on('conversation-records', ({ records }) => { appendConversationRecords(session.id, records); });
    session.on(MANAGER_DECISION_EVENT, (payload) => { appendManagerDecisionNotice(session.id, payload); });
    session.on('chat-attachments-sent', (payload) => { appendSentAttachments(session.id, payload); });
    session.on('chat-board-answer-sent', (payload) => { appendSentBoardAnswer(session.id, payload); });
    session.on(SUBAGENT_SIGNAL_EVENT, (payload) => { appendSubagentSignal(session.id, payload); });
    session.on(BACKGROUND_TASK_SIGNAL_EVENT, (payload) => { appendBackgroundTaskSignal(session.id, payload); });
    session.on('post-turn-check', () => { drainAtTurnEnd(session.id); });
    session.on('exit', () => { detachSession(session.id); });
    session.on('teardown', () => { closeSession(session.id); });
  }

  return { attachSession };
}

export { createTraceSessionBinding };
