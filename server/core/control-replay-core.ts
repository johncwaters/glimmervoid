import { clock } from '../../shared/clock.ts';
import { SERVER_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';

type ControlMessageRecord = Record<string, unknown> & { type?: unknown; seq?: number };
type StampedControlMessageRecord = ControlMessageRecord & { seq: number };

interface ReplayEntry {
  seq: number;
  ts: number;
  msg: StampedControlMessageRecord;
}

interface ReplayLog {
  stamp(msg: ControlMessageRecord, now?: number): StampedControlMessageRecord;
  nextSeq(): number;
  entriesSince(since: number, now?: number): { entries: ControlMessageRecord[]; evicted: boolean };
  currentSeq(): number;
}

const REPLAYABLE_EXACT = new Set(['notify', 'session-error']);

function isReplayable(type: unknown): boolean {
  return typeof type === 'string' && REPLAYABLE_EXACT.has(type);
}

function shouldStampSeq(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  if (REPLAYABLE_EXACT.has(type)) return true;
  if (!Object.hasOwn(SERVER_MESSAGE_CLASS, type)) return false;
  return SERVER_MESSAGE_CLASS[type as keyof typeof SERVER_MESSAGE_CLASS] === 'collection';
}

function createReplayLog({ maxEntries = 500, maxAgeMs = 5 * 60_000, firstSeq = clock.nowMs() }: {
  maxEntries?: number;
  maxAgeMs?: number;
  firstSeq?: number;
} = {}): ReplayLog {
  const ring: ReplayEntry[] = [];
  let seq = firstSeq;

  let evictedUpTo = firstSeq;

  function evictStale(now: number): void {
    while (ring.length && now - ring[0].ts > maxAgeMs) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
    while (ring.length > maxEntries) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
  }

  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  function stamp(msg: ControlMessageRecord, now: number = clock.nowMs()): StampedControlMessageRecord {
    const stampedSeq = nextSeq();
    const stamped: StampedControlMessageRecord = { ...msg, seq: stampedSeq };
    if (!isReplayable(stamped.type)) return stamped;
    ring.push({ seq: stampedSeq, ts: now, msg: stamped });
    evictStale(now);
    return stamped;
  }

  function entriesSince(since: number, now: number = clock.nowMs()): { entries: ControlMessageRecord[]; evicted: boolean } {
    evictStale(now);
    if (!Number.isFinite(since) || since < 0) return { entries: [], evicted: false };
    const entries = ring.filter((e) => e.seq > since).map((e) => e.msg);
    return { entries, evicted: since < evictedUpTo };
  }

  function currentSeq(): number {
    return seq;
  }

  return { stamp, nextSeq, entriesSince, currentSeq };
}

function stampSerializedControlFrame(rawFrame: string, replayLog: ReplayLog): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return rawFrame;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rawFrame;
  const record = parsed as ControlMessageRecord;
  if (!shouldStampSeq(record.type)) return rawFrame;
  return JSON.stringify({ ...record, seq: replayLog.nextSeq() });
}

export { createReplayLog, isReplayable, stampSerializedControlFrame };
export type { ControlMessageRecord, ReplayLog };
