import { clock } from '../../shared/clock.ts';
import { SERVER_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';

type ControlMessageRecord = Record<string, unknown> & { type?: unknown; seq?: number };
type StampedControlMessageRecord = ControlMessageRecord & { seq: number };

interface ReplayEntry {
  seq: number;
  ts: number;
  msg: StampedControlMessageRecord;
}

interface HandshakeCursorRecord {
  sentSeqs: number[];
  maxSentSeq: number;
  ts: number;
}

interface ReplayLog {
  stamp(msg: ControlMessageRecord, now?: number): StampedControlMessageRecord;
  nextSeq(): number;
  resolveSince(since: number, now?: number): number;
  recordHandshakeCursors(mappings: ReadonlyArray<{ sentSeq: number; cursor: number }>, now?: number): void;
  entriesSince(since: number, now?: number): { entries: StampedControlMessageRecord[]; evicted: boolean };
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
  const cursorRecords: HandshakeCursorRecord[] = [];
  const cursorBySentSeq = new Map<number, number>();
  let sizeEvictedCursorMaxSeq = 0;
  let sizeEvictedCursorAtMs = 0;
  let seq = firstSeq;

  let evictedUpTo = firstSeq;

  function dropCursorRecord(record: HandshakeCursorRecord): void {
    for (const sentSeq of record.sentSeqs) cursorBySentSeq.delete(sentSeq);
  }

  function evictStale(now: number): void {
    while (ring.length && now - ring[0].ts > maxAgeMs) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
    while (ring.length > maxEntries) {
      evictedUpTo = ring[0].seq;
      ring.shift();
    }
    while (cursorRecords.length && now - cursorRecords[0].ts > maxAgeMs) {
      const expired = cursorRecords.shift();
      if (expired) dropCursorRecord(expired);
    }
    while (cursorRecords.length > maxEntries) {
      const evictedRecord = cursorRecords.shift();
      if (!evictedRecord) continue;
      dropCursorRecord(evictedRecord);
      sizeEvictedCursorMaxSeq = Math.max(sizeEvictedCursorMaxSeq, evictedRecord.maxSentSeq);
      sizeEvictedCursorAtMs = now;
    }
    if (sizeEvictedCursorMaxSeq > 0 && now - sizeEvictedCursorAtMs > maxAgeMs) {
      sizeEvictedCursorMaxSeq = 0;
      sizeEvictedCursorAtMs = 0;
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

  function resolveSince(since: number, now: number = clock.nowMs()): number {
    evictStale(now);
    return cursorBySentSeq.get(since) ?? since;
  }

  function recordHandshakeCursors(mappings: ReadonlyArray<{ sentSeq: number; cursor: number }>, now: number = clock.nowMs()): void {
    const sentSeqs: number[] = [];
    let maxSentSeq = 0;
    for (const { sentSeq, cursor } of mappings) {
      if (!Number.isFinite(sentSeq) || !Number.isFinite(cursor) || cursor < 0 || cursor >= sentSeq) continue;
      cursorBySentSeq.set(sentSeq, cursor);
      sentSeqs.push(sentSeq);
      if (sentSeq > maxSentSeq) maxSentSeq = sentSeq;
    }
    if (sentSeqs.length === 0) return;
    cursorRecords.push({ sentSeqs, maxSentSeq, ts: now });
    evictStale(now);
  }

  function entriesSince(since: number, now: number = clock.nowMs()): { entries: StampedControlMessageRecord[]; evicted: boolean } {
    evictStale(now);
    if (!Number.isFinite(since) || since < 0) return { entries: [], evicted: false };
    const mappedCursor = cursorBySentSeq.get(since);
    if (mappedCursor === undefined && sizeEvictedCursorMaxSeq > 0 && since <= sizeEvictedCursorMaxSeq && ring.length > 0) {
      return { entries: ring.map((entry) => entry.msg), evicted: true };
    }
    const effectiveSince = mappedCursor ?? since;
    const entries = ring.filter((entry) => entry.seq > effectiveSince).map((entry) => entry.msg);
    return { entries, evicted: effectiveSince < evictedUpTo };
  }

  function currentSeq(): number {
    return seq;
  }

  return { stamp, nextSeq, resolveSince, recordHandshakeCursors, entriesSince, currentSeq };
}

function stampSerializedControlFrameWithSeq(rawFrame: string, replayLog: ReplayLog): { frame: string; seq: number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return { frame: rawFrame, seq: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { frame: rawFrame, seq: null };
  const record = parsed as ControlMessageRecord;
  if (!shouldStampSeq(record.type)) return { frame: rawFrame, seq: null };
  const seq = replayLog.nextSeq();
  return { frame: JSON.stringify({ ...record, seq }), seq };
}

export { createReplayLog, isReplayable, stampSerializedControlFrameWithSeq };
export type { ControlMessageRecord, ReplayLog };
