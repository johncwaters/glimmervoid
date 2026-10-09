
import type { EventEmitter } from 'node:events';
import {
  DEFAULT_FLUSH_MS, appendChunk, createTerminalAccumulator, flushAccumulator, rebaseline,
} from './core/ingest-terminal-core.ts';
import type { TerminalIngestEvent } from './core/ingest-terminal-core.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';
import { errorMessage } from '../shared/text.ts';
import { DEFAULT_TIMER_FNS } from './core/timer-deps.ts';
import type { ClearTimeoutFn, SetTimeoutFn } from './core/timer-deps.ts';
import { createCoalescedTimer } from './core/coalesce-timer.ts';

interface TappableSession {
  id: string;
  on: EventEmitter['on'];
  off: EventEmitter['off'];
  effectiveCwd?: () => string | null;
}

interface SessionTap {
  sessionId: string;
  session: TappableSession;
  detach(): void;
  flushNow(): void;
  readonly isDetached: boolean;
}

interface TerminalIngestOptions {
  publish?: (event: TerminalIngestEvent) => unknown;
  sourceConfig?: { flushMs?: number };
  logger?: LaneLogger | null;
  nowFn?: () => number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

function createTerminalIngest({
  publish,
  sourceConfig = {},
  logger = console,
  nowFn = Date.now,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
}: TerminalIngestOptions = {}) {
  if (typeof publish !== 'function') throw new Error('createTerminalIngest requires publish');
  const publishEvent = publish;
  const flushMs = typeof sourceConfig.flushMs === 'number' && Number.isFinite(sourceConfig.flushMs) && sourceConfig.flushMs > 0
    ? sourceConfig.flushMs
    : DEFAULT_FLUSH_MS;
  const tapsBySessionId = new Map<string, SessionTap>();

  const { note, warn } = createLaneLog({ prefix: '[ingest]', logger });

  function rootOf(sess: TappableSession): string | null {
    try {
      const cwd = typeof sess.effectiveCwd === 'function' ? sess.effectiveCwd() : null;
      return typeof cwd === 'string' && cwd ? cwd : null;
    } catch {
      return null;
    }
  }

  function attachSessionTap(sess: TappableSession | null | undefined): SessionTap | null {
    if (!sess || typeof sess.on !== 'function' || !sess.id) return null;
    const existing = tapsBySessionId.get(sess.id);
    if (existing && existing.session === sess) return existing;
    if (existing) existing.detach();

    const state = createTerminalAccumulator({ sessionId: sess.id, root: rootOf(sess), ...sourceConfig });
    let detached = false;
    const flushTimer = createCoalescedTimer({ mode: 'leading', delayMs: flushMs, run: () => flush(), setTimeoutFn, clearTimeoutFn });

    function cancelFlush(): void {
      flushTimer.cancel();
    }

    const flush = (): void => {
      const event = flushAccumulator(state, { now: nowFn() });
      if (!event) return;
      try {
        publishEvent(event);
      } catch (error) {
        warn(`publish failed for session ${sess.id}: ${errorMessage(error)}`);
      }
    };

    function armFlush(): void {
      if (detached) return;
      flushTimer.schedule();
    }

    const onData = (chunk: string) => {
      if (detached) return;
      appendChunk(state, chunk);
      armFlush();
    };
    const onRebaseline = () => {
      cancelFlush();
      rebaseline(state);
    };
    const onExit = () => {
      cancelFlush();
      flush();
      rebaseline(state);
    };

    const detach = (): void => {
      if (detached) return;
      detached = true;
      cancelFlush();
      rebaseline(state);
      try {
        sess.off('data', onData);
        sess.off('rebaseline', onRebaseline);
        sess.off('exit', onExit);
      } catch (error) {
        warn(`detach for session ${sess.id} failed: ${errorMessage(error)}`);
      }
      if (tapsBySessionId.get(sess.id) === tap) tapsBySessionId.delete(sess.id);
      note(`terminal source: detached the tap on session ${sess.id} (${tapsBySessionId.size} tapped)`);
    };

    sess.on('data', onData);
    sess.on('rebaseline', onRebaseline);
    sess.on('exit', onExit);

    const tap: SessionTap = {
      sessionId: sess.id,
      session: sess,
      detach,
      flushNow: flush,
      get isDetached() { return detached; },
    };
    tapsBySessionId.set(sess.id, tap);
    note(`terminal source: attached a tap to session ${sess.id} (${tapsBySessionId.size} tapped)`);
    return tap;
  }

  function detachSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!sess || !sess.id) return false;
    const tap = tapsBySessionId.get(sess.id);
    if (!tap || tap.session !== sess) return false;
    tap.detach();
    return true;
  }

  function hasSessionTap(sess: TappableSession | null | undefined): boolean {
    if (!sess || !sess.id) return false;
    return tapsBySessionId.get(sess.id)?.session === sess;
  }

  function stop(): void {
    for (const tap of [...tapsBySessionId.values()]) tap.detach();
    tapsBySessionId.clear();
  }

  return {
    name: 'terminal',
    attachSessionTap,
    detachSessionTap,
    hasSessionTap,
    stop,
    get tapCount() { return tapsBySessionId.size; },
  };
}

export { createTerminalIngest };
export type { SessionTap, TappableSession, TerminalIngestOptions };
