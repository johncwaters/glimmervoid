import fsp from 'node:fs/promises';
import path from 'node:path';
import { AwakeEvent } from '../../shared/contracts/doorman.ts';
import type { AwakeUsage } from '../../shared/contracts/watcher-link.ts';
import { awakeUsageAt, emptyMeterTotal, foldAwakeEvent, isMeteredAwake } from './doorman-core.ts';
import type { MeterTotal } from './doorman-core.ts';

type AwakeMeter = {
  note(event: AwakeEvent['event']): void;
  usage(awakeHoursPerMonth: number | null): AwakeUsage;
  isAwake(): boolean;
  flushed(): Promise<void>;
};

const AWAKE_LEDGER_FILE_NAME = 'awake-ledger.jsonl';

function parsedLedgerLine(line: string): AwakeEvent | null {
  try {
    const parsed = AwakeEvent.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function totalFromLedger(ledgerPath: string, nowMs: number, warn: (message: string) => void): Promise<MeterTotal> {
  let ledgerText = '';
  try {
    ledgerText = await fsp.readFile(ledgerPath, 'utf8');
  } catch (readError) {
    if (!isMissingFileError(readError)) {
      warn(`could not read ${ledgerPath}, treating this month as used up until the doorman restarts: ${(readError as Error).message}`);
      return { ...emptyMeterTotal(nowMs), closedAwakeMs: Number.MAX_SAFE_INTEGER };
    }
  }
  let total = emptyMeterTotal(0);
  for (const line of ledgerText.split('\n')) {
    if (line.trim() === '') continue;
    const awakeEvent = parsedLedgerLine(line);
    if (awakeEvent === null) {
      warn(`skipped a line of ${ledgerPath} that is not an awake event`);
      continue;
    }
    total = foldAwakeEvent(total, awakeEvent);
  }
  return total;
}

async function createAwakeMeter({ watcherHome, now, log }: { watcherHome: string; now: () => number; log: Pick<Console, 'warn'> }): Promise<AwakeMeter> {
  const ledgerPath = path.join(watcherHome, AWAKE_LEDGER_FILE_NAME);
  const warn = (message: string) => log.warn(`[doorman] awake meter: ${message}`);
  let total = await totalFromLedger(ledgerPath, now(), warn);
  let unwrittenLines: string[] = [];
  let writes: Promise<void> = Promise.resolve();

  async function appendUnwritten(): Promise<void> {
    if (unwrittenLines.length === 0) return;
    const lines = unwrittenLines;
    unwrittenLines = [];
    try {
      await fsp.mkdir(watcherHome, { recursive: true, mode: 0o700 });
      await fsp.appendFile(ledgerPath, lines.join(''), { mode: 0o600 });
    } catch (appendError) {
      unwrittenLines = [...lines, ...unwrittenLines];
      warn(`could not append to ${ledgerPath}, keeping ${unwrittenLines.length} event(s) for the next write: ${(appendError as Error).message}`);
    }
  }

  function note(event: AwakeEvent['event']): void {
    const awakeEvent: AwakeEvent = { event, at: new Date(now()).toISOString() };
    total = foldAwakeEvent(total, awakeEvent);
    unwrittenLines.push(`${JSON.stringify(awakeEvent)}\n`);
    writes = writes.then(appendUnwritten);
  }

  return {
    note,
    usage: (awakeHoursPerMonth) => awakeUsageAt(total, awakeHoursPerMonth, now()),
    isAwake: () => isMeteredAwake(total),
    flushed: () => writes,
  };
}

export { createAwakeMeter };
export type { AwakeMeter };
