import type { AwakeEvent, WakeStartedBy } from '../../shared/contracts/doorman.ts';
import type { AwakeUsage } from '../../shared/contracts/watcher-link.ts';
import { awakeUsageAt, emptyMeterTotal, foldAwakeEvent, isMeteredAwake, recentEdgeWakeTimes } from './doorman-core.ts';
import type { MeterTotal } from './doorman-core.ts';
import type { AwakeLedger } from './doorman-state.ts';
import { isTransientFailure } from './gcp-rest.ts';

type AwakeMeter = {
  note(event: AwakeEvent['event'], startedBy?: WakeStartedBy): void;
  usage(awakeHoursPerMonth: number | null): AwakeUsage;
  isAwake(): boolean;
  lastWokeAtMs(): number | null;
  recentEdgeWakeTimesMs(): number[];
  flushed(): Promise<void>;
};

type LedgerReading = { total: MeterTotal; lastWokeAtMs: number | null; edgeWakeTimesMs: number[] };

function readingOf(awakeEvents: readonly AwakeEvent[], nowMs: number): LedgerReading {
  const wokeEvents = awakeEvents.filter((awakeEvent) => awakeEvent.event === 'woke');
  const lastWoke = wokeEvents.at(-1);
  return {
    total: awakeEvents.reduce(foldAwakeEvent, emptyMeterTotal(0)),
    lastWokeAtMs: lastWoke === undefined ? null : Date.parse(lastWoke.at),
    edgeWakeTimesMs: recentEdgeWakeTimes(wokeEvents.filter((awakeEvent) => awakeEvent.startedBy === 'edge').map((awakeEvent) => Date.parse(awakeEvent.at)), nowMs),
  };
}

async function readLedger(ledger: AwakeLedger, nowMs: number, warn: (message: string) => void): Promise<LedgerReading> {
  try {
    return readingOf(await ledger.recentEvents(), nowMs);
  } catch (readError) {
    if (isTransientFailure(readError)) throw readError;
    warn(`could not read ${ledger.identity}, treating this month as used up until the doorman restarts: ${(readError as Error).message}`);
    return { total: { ...emptyMeterTotal(nowMs), closedAwakeMs: Number.MAX_SAFE_INTEGER }, lastWokeAtMs: null, edgeWakeTimesMs: [] };
  }
}

async function createAwakeMeter({ ledger, now, log }: { ledger: AwakeLedger; now: () => number; log: Pick<Console, 'warn'> }): Promise<AwakeMeter> {
  const warn = (message: string) => log.warn(`[doorman] awake meter: ${message}`);
  const reading = await readLedger(ledger, now(), warn);
  let total = reading.total;
  let lastWokeAtMs = reading.lastWokeAtMs;
  let edgeWakeTimesMs = reading.edgeWakeTimesMs;
  let unwrittenEvents: AwakeEvent[] = [];
  let writes: Promise<void> = Promise.resolve();

  async function appendUnwritten(): Promise<void> {
    if (unwrittenEvents.length === 0) return;
    const awakeEvents = unwrittenEvents;
    unwrittenEvents = [];
    try {
      await ledger.append(awakeEvents);
    } catch (appendError) {
      unwrittenEvents = [...awakeEvents, ...unwrittenEvents];
      warn(`could not append to ${ledger.identity}, keeping ${unwrittenEvents.length} event(s) for the next write: ${(appendError as Error).message}`);
    }
  }

  function note(event: AwakeEvent['event'], startedBy?: WakeStartedBy): void {
    const awakeEvent: AwakeEvent = startedBy === undefined ? { event, at: new Date(now()).toISOString() } : { event, at: new Date(now()).toISOString(), startedBy };
    total = foldAwakeEvent(total, awakeEvent);
    if (event === 'woke') lastWokeAtMs = now();
    if (event === 'woke' && startedBy === 'edge') edgeWakeTimesMs = [...recentEdgeWakeTimes(edgeWakeTimesMs, now()), now()];
    unwrittenEvents.push(awakeEvent);
    writes = writes.then(appendUnwritten);
  }

  return {
    note,
    usage: (awakeHoursPerMonth) => awakeUsageAt(total, awakeHoursPerMonth, now()),
    isAwake: () => isMeteredAwake(total),
    lastWokeAtMs: () => lastWokeAtMs,
    recentEdgeWakeTimesMs: () => recentEdgeWakeTimes(edgeWakeTimesMs, now()),
    flushed: () => writes,
  };
}

export { createAwakeMeter };
export type { AwakeMeter };
