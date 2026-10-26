import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLine } from './json-file.ts';
import type { RemovalRecord } from '../shared/contracts/removal-record.ts';
import { errorMessage } from '../shared/text.ts';

function removalsJournalPath(glimmervoidHome: string): string {
  return path.join(glimmervoidHome, 'logs', 'removals.jsonl');
}

async function appendRemovalRecord(journalPath: string, record: RemovalRecord, log: Pick<Console, 'warn'> = console): Promise<boolean> {
  return appendJsonLine(journalPath, record, { mkdir: true }).then(() => true, (error: unknown) => {
    log.warn(`[removals] kept ${record.path ?? record.branch} because its removal record could not be written: ${errorMessage(error)}`);
    return false;
  });
}

function appendRemovalRecordSync(journalPath: string, record: RemovalRecord, log: Pick<Console, 'warn'> = console): boolean {
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (error) {
    log.warn(`[removals] kept ${record.path ?? record.branch} because its removal record could not be written: ${errorMessage(error)}`);
    return false;
  }
}

export { appendRemovalRecord, appendRemovalRecordSync, removalsJournalPath };
