import fs from 'node:fs';
import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import { createTailState } from '../core/transcript-tail-core.ts';
import { createJsonStateWriter } from '../json-file.ts';
import { watchPath } from '../path-watch.ts';
import { errorMessage } from '../../shared/text.ts';
import { MANAGER_DECISION_EVENT, ManagerDecision } from '../../shared/contracts/question-manager.ts';
import { BACKGROUND_TASK_SIGNAL_EVENT, BackgroundTaskSignal, MAX_RAW_LINE_CHARS, REBASELINE_EVENT, RebaselineSignal, SUBAGENT_SIGNAL_EVENT, SubagentSignal } from '../../shared/contracts/trace.ts';
import { MAX_REMEMBERED_CLOSED_SESSIONS, stopFollowingBinding, trimOldest } from './trace-wiring-context.ts';
import { SESSION_DRIVER_EVENTS } from '../../session/drivers/driver.ts';
import type { DriverEvent, DriverListener, SessionDriverEventPayloads } from '../../session/drivers/driver.ts';
import { containmentRootFor, driverSource, relaySourceOf, transcriptSourceOf } from './conversation-sources.ts';
import type { SubscribeDriverEvents, TranscriptConversationSource } from './conversation-sources.ts';
import type { TraceBinding, TraceWiringContext } from './trace-wiring-context.ts';
import type { TraceRecordStore } from './trace-record-store.ts';
import type { TraceCheckpoints } from './trace-checkpoints.ts';
import type { TraceTranscriptDrain } from './trace-transcript-drain.ts';
import type { TraceSubagentCapture } from './trace-subagent-capture.ts';

type SessionEventListener = (payload: Record<string, unknown>) => void;
type DriverSessionListener<EventName extends keyof SessionDriverEventPayloads> = (payload: SessionDriverEventPayloads[EventName]) => void;

interface TraceSession {
  id: string;
  agentId: string;
  launchEnv(): Record<string, string | undefined>;
  deliveredSecretValues?(): readonly string[];
  _driver?: { readonly hasTerminal: boolean };
  on<EventName extends keyof SessionDriverEventPayloads>(event: EventName, listener: DriverSessionListener<EventName>): unknown;
  on(event: string, listener: SessionEventListener): unknown;
  off?<EventName extends keyof SessionDriverEventPayloads>(event: EventName, listener: DriverSessionListener<EventName>): unknown;
  off?(event: string, listener: SessionEventListener): unknown;
  removeListener?<EventName extends keyof SessionDriverEventPayloads>(event: EventName, listener: DriverSessionListener<EventName>): unknown;
  removeListener?(event: string, listener: SessionEventListener): unknown;
}

interface TraceSessionBindingDeps {
  recordStore: TraceRecordStore;
  checkpoints: TraceCheckpoints;
  drain: TraceTranscriptDrain;
  subagentCapture: TraceSubagentCapture;
}

const TRANSCRIPT_WATCH_DEBOUNCE_MS = 50;
const MAX_PENDING_PRE_BIND_RECORDS = 64;

function detachDriverListener<EventName extends keyof SessionDriverEventPayloads>(
  session: TraceSession,
  eventName: EventName,
  listener: DriverSessionListener<EventName>,
): void {
  if (typeof session.off === 'function') {
    session.off(eventName, listener);
    return;
  }
  session.removeListener?.(eventName, listener);
}

function subscribeSessionDriverEvents(
  session: TraceSession,
  onAgentSession: (agentSessionId: string) => void,
  skipReplayBeforeOpen: boolean,
): SubscribeDriverEvents {
  return (listener: DriverListener) => {
    let isSkippingReplay = skipReplayBeforeOpen;
    const forward = <EventName extends keyof SessionDriverEventPayloads>(
      eventName: EventName,
      toDriverEvent: (payload: SessionDriverEventPayloads[EventName]) => DriverEvent | null,
    ): (() => void) => {
      const handler: DriverSessionListener<EventName> = (payload) => {
        const driverEvent = toDriverEvent(payload);
        if (driverEvent !== null) listener(driverEvent);
      };
      session.on(eventName, handler);
      return () => { detachDriverListener(session, eventName, handler); };
    };

    const detachAll: (() => void)[] = [
      forward(SESSION_DRIVER_EVENTS.agentSession, (payload) => {
        isSkippingReplay = false;
        if (payload.agentSessionId.length > 0) onAgentSession(payload.agentSessionId);
        return { kind: 'agent-session', agentSessionId: payload.agentSessionId, isResumed: payload.isResumed };
      }),
      forward(SESSION_DRIVER_EVENTS.prompt, (payload) => ({
        kind: 'prompt',
        agentSessionId: payload.agentSessionId,
        text: payload.text,
      })),
      forward(SESSION_DRIVER_EVENTS.update, (payload) => {
        if (isSkippingReplay) return null;
        return {
          kind: 'update',
          agentSessionId: payload.agentSessionId,
          update: payload.update,
        };
      }),
      forward(SESSION_DRIVER_EVENTS.permission, (payload) => ({
        kind: 'permission',
        request: payload.request,
      })),
      forward(SESSION_DRIVER_EVENTS.question, (payload) => ({
        kind: 'question',
        question: payload.question,
      })),
      forward(SESSION_DRIVER_EVENTS.turnEnd, (payload) => ({
        kind: 'turn-end',
        stopReason: payload.stopReason,
      })),
      forward(SESSION_DRIVER_EVENTS.promptError, (payload) => ({
        kind: 'prompt-error',
        message: payload.message,
      })),
    ];

    return () => {
      for (const detach of detachAll) detach();
    };
  };
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
  const driverStopByGlimmervoidSessionId = new Map<string, () => void>();
  const driverTraceRecordedSessionIds = new Set<string>();
  const conversationVendorSessionIdByGlimmervoidSessionId = new Map<string, string>();
  const pendingRecordsByGlimmervoidSessionId = new Map<string, Record<string, unknown>[]>();
  const launchEnvByGlimmervoidSessionId = new Map<string, () => Record<string, string | undefined>>();

  function hasExistingTraceFile(glimmervoidSessionId: string): boolean {
    const filePath = traceFilePath(glimmervoidSessionId);
    if (!filePath) return false;
    try {
      return fs.statSync(filePath).size > 0;
    } catch {
      return false;
    }
  }

  function stopDriverSubscription(glimmervoidSessionId: string): void {
    const stopDriver = driverStopByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!stopDriver) return;
    driverStopByGlimmervoidSessionId.delete(glimmervoidSessionId);
    stopDriver();
  }

  function stopAllDriverSubscriptions(): void {
    for (const glimmervoidSessionId of [...driverStopByGlimmervoidSessionId.keys()]) {
      stopDriverSubscription(glimmervoidSessionId);
    }
  }

  function hasDriverSubscription(glimmervoidSessionId: string): boolean {
    return driverStopByGlimmervoidSessionId.has(glimmervoidSessionId);
  }

  function ensureDriverSubscription(session: TraceSession): void {
    if (isStopped() || closedSessionIds.has(session.id) || driverStopByGlimmervoidSessionId.has(session.id)) return;
    const skipReplayBeforeOpen = driverTraceRecordedSessionIds.has(session.id) || hasExistingTraceFile(session.id);
    const stopDriver = driverSource().subscribe(
      subscribeSessionDriverEvents(session, (agentSessionId) => {
        conversationVendorSessionIdByGlimmervoidSessionId.set(session.id, agentSessionId);
      }, skipReplayBeforeOpen),
      (records) => {
        if (records.length > 0) driverTraceRecordedSessionIds.add(session.id);
        appendConversationRecords(session.id, records);
      },
      nowFn,
    );
    driverStopByGlimmervoidSessionId.set(session.id, stopDriver);
  }

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
    conversationVendorSessionIdByGlimmervoidSessionId.set(glimmervoidSessionId, vendorSessionId);
    const pendingRecords = takePendingRecords(glimmervoidSessionId, vendorSessionId);
    if (pendingRecords.length > 0) {
      for (const pendingRecord of pendingRecords) queueRecord(glimmervoidSessionId, pendingRecord);
      await flushSession(glimmervoidSessionId);
    }
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
    stopDriverSubscription(glimmervoidSessionId);
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
    stopDriverSubscription(glimmervoidSessionId);
    closedSessionIds.add(glimmervoidSessionId);
    driverTraceRecordedSessionIds.delete(glimmervoidSessionId);
    awaitingTranscriptByGlimmervoidSessionId.delete(glimmervoidSessionId);
    conversationVendorSessionIdByGlimmervoidSessionId.delete(glimmervoidSessionId);
    pendingRecordsByGlimmervoidSessionId.delete(glimmervoidSessionId);
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

  function takePendingRecords(glimmervoidSessionId: string, vendorSessionId: string): Record<string, unknown>[] {
    const pending = pendingRecordsByGlimmervoidSessionId.get(glimmervoidSessionId);
    if (!pending || pending.length === 0) return [];
    pendingRecordsByGlimmervoidSessionId.delete(glimmervoidSessionId);
    return pending.map((record) => ({ ...record, vendorSessionId }));
  }

  function appendConversationRecords(glimmervoidSessionId: string, records: unknown): void {
    if (isStopped() || !Array.isArray(records) || records.length === 0) return;
    const firstVendorSessionId = records.find(
      (record): record is { vendorSessionId: string } => typeof record?.vendorSessionId === 'string' && record.vendorSessionId.length > 0,
    )?.vendorSessionId;
    if (firstVendorSessionId) {
      for (const pendingRecord of takePendingRecords(glimmervoidSessionId, firstVendorSessionId)) queueRecord(glimmervoidSessionId, pendingRecord);
    }
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

  function hasConversationSource(glimmervoidSessionId: string): boolean {
    if (driverStopByGlimmervoidSessionId.has(glimmervoidSessionId)) return true;
    const agentId = agentIdBySessionId.get(glimmervoidSessionId) ?? '';
    return transcriptSourceOf(agentId) !== null || relaySourceOf(agentId) !== null;
  }

  function appendSessionRecord(glimmervoidSessionId: string, record: Record<string, unknown>): void {
    if (isStopped() || closedSessionIds.has(glimmervoidSessionId)) return;
    const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
    if (typeof vendorSessionId === 'string' && vendorSessionId.length > 0) {
      appendConversationRecords(glimmervoidSessionId, [{ ...record, vendorSessionId }]);
      return;
    }
    if (!hasConversationSource(glimmervoidSessionId)) return;
    const pending = pendingRecordsByGlimmervoidSessionId.get(glimmervoidSessionId) ?? [];
    if (pending.length >= MAX_PENDING_PRE_BIND_RECORDS) return;
    pending.push(record);
    pendingRecordsByGlimmervoidSessionId.set(glimmervoidSessionId, pending);
  }

  function appendSentAttachments(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    appendSessionRecord(glimmervoidSessionId, { ts: payload.ts, uuid: null, parentUuid: null, kind: 'attachments', files: payload.files, pastedPrefix: payload.pastedPrefix });
  }

  function appendSentBoardAnswer(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    appendSessionRecord(glimmervoidSessionId, { ts: payload.ts, uuid: null, parentUuid: null, kind: 'board-answer' });
  }

  function appendSubagentSignal(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = SubagentSignal.safeParse(payload);
    if (!parsed.success) return;
    appendSessionRecord(glimmervoidSessionId, { uuid: null, parentUuid: null, kind: 'subagent', ...parsed.data });
  }

  function appendBackgroundTaskSignal(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = BackgroundTaskSignal.safeParse(payload);
    if (!parsed.success) return;
    appendSessionRecord(glimmervoidSessionId, { uuid: null, parentUuid: null, kind: 'background-task', ...parsed.data });
  }

  function appendRestartRecord(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = RebaselineSignal.safeParse(payload);
    if (!parsed.success) return;
    chain(async () => {
      const vendorSessionId = knownVendorSessionId(glimmervoidSessionId);
      if (typeof vendorSessionId !== 'string' || vendorSessionId.length === 0) return;
      appendSessionRecord(glimmervoidSessionId, { ts: nowFn(), uuid: null, parentUuid: null, kind: 'restart', startsNewConversation: parsed.data.startsNewConversation });
    }, 'restart record failed');
  }

  function appendManagerDecisionNotice(glimmervoidSessionId: string, payload: Record<string, unknown>): void {
    const parsed = ManagerDecision.safeParse(payload.decision);
    if (!parsed.success) return;
    appendSessionRecord(glimmervoidSessionId, {
      ts: parsed.data.ts,
      uuid: null,
      parentUuid: null,
      kind: 'notice',
      text: managerDecisionText(parsed.data).slice(0, MAX_RAW_LINE_CHARS),
    });
  }

  function attachSession(session: TraceSession): void {
    if (attachedSessions.has(session)) return;
    attachedSessions.add(session);
    closedSessionIds.delete(session.id);
    deliveredSecretValuesBySessionId.set(session.id, () => session.deliveredSecretValues?.() ?? []);
    agentIdBySessionId.set(session.id, session.agentId);
    launchEnvByGlimmervoidSessionId.set(session.id, () => session.launchEnv());
    stopDriverSubscription(session.id);
    const usesDriverSource = session._driver?.hasTerminal === false;
    if (usesDriverSource) ensureDriverSubscription(session);
    if (!usesDriverSource) {
      session.on('claude-session-id', (payload) => { noteVendorSession(session.id, payload); });
      session.on('hook-event', (record) => { noteHookEvent(session.id, record); });
      session.on('post-turn-check', () => { drainAtTurnEnd(session.id); });
    }
    session.on('conversation-records', ({ records }) => { appendConversationRecords(session.id, records); });
    session.on(MANAGER_DECISION_EVENT, (payload) => { appendManagerDecisionNotice(session.id, payload); });
    session.on('chat-attachments-sent', (payload) => { appendSentAttachments(session.id, payload); });
    session.on('chat-board-answer-sent', (payload) => { appendSentBoardAnswer(session.id, payload); });
    session.on(REBASELINE_EVENT, (payload) => {
      if (usesDriverSource) ensureDriverSubscription(session);
      appendRestartRecord(session.id, payload);
    });
    session.on(SUBAGENT_SIGNAL_EVENT, (payload) => { appendSubagentSignal(session.id, payload); });
    session.on(BACKGROUND_TASK_SIGNAL_EVENT, (payload) => { appendBackgroundTaskSignal(session.id, payload); });
    session.on('exit', () => { detachSession(session.id); });
    session.on('teardown', () => { closeSession(session.id); });
  }

  return { attachSession, hasDriverSubscription, stopAllDriverSubscriptions };
}

export { createTraceSessionBinding };
