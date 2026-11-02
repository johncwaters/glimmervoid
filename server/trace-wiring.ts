import { EventEmitter } from 'node:events';

import type { TraceRecord } from '../shared/contracts/trace.ts';
import { MAX_REMEMBERED_SUBAGENTS } from './core/trace-tail-core.ts';
import { createLaneLog } from './lanes/lane-log.ts';
import { configSiblingPath } from './pairings-store.ts';
import { pruneAgedFiles } from './prune-files.ts';
import { errorMessage } from '../shared/text.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../shared/timer-deps.ts';
import type { ClearIntervalFn, SetIntervalFn } from '../shared/timer-deps.ts';
import { createSerialQueue } from './spawn-gate.ts';
import { CHECKPOINT_SUFFIX, TRACE_SUFFIX } from './trace/trace-wiring-context.ts';
import type { TraceBinding, TraceWiringContext } from './trace/trace-wiring-context.ts';
import { createTraceRecordStore } from './trace/trace-record-store.ts';
import type { TracePage, TracePageRequest } from './trace/trace-record-store.ts';
import { createTraceCheckpoints } from './trace/trace-checkpoints.ts';
import { createTraceTranscriptDrain } from './trace/trace-transcript-drain.ts';
import { createTraceSubagentCapture } from './trace/trace-subagent-capture.ts';
import { createTraceSessionBinding } from './trace/trace-session-binding.ts';

const TRACE_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

interface TraceWiringOptions {
  configPath?: string | null;
  logger?: Pick<Console, 'log' | 'warn'> | null;
  debug?: boolean | (() => boolean);
  nowFn?: () => number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  maxRememberedSubagents?: number;
}

async function pruneTraceFiles({
  traceDirectory,
  now = Date.now(),
  isBoundSessionId = () => false,
}: {
  traceDirectory: string;
  now?: number;
  isBoundSessionId?: (glimmervoidSessionId: string) => boolean;
}): Promise<number> {
  const removed = await pruneAgedFiles({
    directory: traceDirectory,
    suffixes: [CHECKPOINT_SUFFIX, TRACE_SUFFIX],
    retainDays: TRACE_RETAIN_DAYS,
    now,
    isRetainedId: isBoundSessionId,
  });
  return removed.length;
}

function createTraceWiring({
  configPath = null,
  logger = console,
  debug = false,
  nowFn = Date.now,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  maxRememberedSubagents = MAX_REMEMBERED_SUBAGENTS,
}: TraceWiringOptions = {}) {
  const traceDirectory = configSiblingPath(configPath, 'traces');
  const emitter = new EventEmitter();
  const bindingByGlimmervoidSessionId = new Map<string, TraceBinding>();
  const awaitingTranscriptByGlimmervoidSessionId = new Map<string, Record<string, unknown>>();
  const pendingRecordsBySessionId = new Map<string, TraceRecord[]>();
  const closedSessionIds = new Set<string>();
  let pruneTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let hasStarted = false;
  let hasStopped = false;
  let stopPromise: Promise<void> | null = null;
  const operationQueue = createSerialQueue();
  const laneLog = createLaneLog({ prefix: '[trace]', logger, debugFlag: debug });

  function chain(step: () => Promise<void>, failure: string): void {
    void operationQueue.run(step).catch((error: unknown) => { laneLog.warn(failure, { error: errorMessage(error) }); });
  }

  const context: TraceWiringContext = {
    traceDirectory,
    emitter,
    laneLog,
    nowFn,
    maxRememberedSubagents,
    bindingByGlimmervoidSessionId,
    awaitingTranscriptByGlimmervoidSessionId,
    pendingRecordsBySessionId,
    closedSessionIds,
    chain,
    isStopped: () => hasStopped,
  };
  const recordStore = createTraceRecordStore(context);
  const checkpoints = createTraceCheckpoints(context, recordStore);
  const drain = createTraceTranscriptDrain(context, recordStore, checkpoints);
  const subagentCapture = createTraceSubagentCapture(context, drain);
  const { attachSession } = createTraceSessionBinding(context, { recordStore, checkpoints, drain, subagentCapture });
  const { readTracePage, flushEverySession } = recordStore;
  const { drainBinding } = drain;

  async function pollBoundTranscripts(): Promise<void> {
    if (hasStopped) return;
    for (const binding of [...bindingByGlimmervoidSessionId.values()]) {
      if (binding.isClosing) continue;
      await drainBinding(binding);
    }
  }

  async function prune(): Promise<void> {
    await pruneTraceFiles({
      traceDirectory,
      now: nowFn(),
      isBoundSessionId: (glimmervoidSessionId) => bindingByGlimmervoidSessionId.has(glimmervoidSessionId),
    });
  }

  async function start(): Promise<void> {
    if (hasStarted || hasStopped) return;
    hasStarted = true;
    await prune();
    pruneTimer = setIntervalFn(() => { chain(prune, 'prune failed'); }, PRUNE_INTERVAL_MS);
    unrefTimer(pruneTimer);
    pollTimer = setIntervalFn(() => {
      if (bindingByGlimmervoidSessionId.size === 0) return;
      chain(pollBoundTranscripts, 'poll failed');
    }, POLL_INTERVAL_MS);
    unrefTimer(pollTimer);
  }

  async function whenIdle(): Promise<void> {
    await operationQueue.idle();
    await flushEverySession();
    for (const binding of [...bindingByGlimmervoidSessionId.values()]) await binding.checkpointWriter.idle();
  }

  async function stopOnce(): Promise<void> {
    if (pruneTimer) clearIntervalFn(pruneTimer);
    if (pollTimer) clearIntervalFn(pollTimer);
    pruneTimer = null;
    pollTimer = null;
    await operationQueue.idle();
    for (const binding of [...bindingByGlimmervoidSessionId.values()]) {
      bindingByGlimmervoidSessionId.delete(binding.glimmervoidSessionId);
      try {
        await drainBinding(binding);
      } catch (error) {
        laneLog.warn('final drain failed', { error: errorMessage(error) });
      }
      await binding.checkpointWriter.idle();
    }
    hasStopped = true;
    await flushEverySession();
  }

  function stop(): Promise<void> {
    if (!stopPromise) stopPromise = stopOnce();
    return stopPromise;
  }

  return {
    attachSession,
    on: emitter.on.bind(emitter),
    readTracePage,
    start,
    stop,
    whenIdle,
  };
}

export { createTraceWiring };
export type { TracePage, TracePageRequest };
