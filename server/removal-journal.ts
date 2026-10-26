import fs from 'node:fs';
import path from 'node:path';
import { glimmervoidHomeDir } from './config-store.ts';
import { appendJsonLine } from './json-file.ts';
import type { RemovalCause, RemovalKind, RemovalRecord } from '../shared/contracts/removal-record.ts';
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

async function recordSweptPath({ cause, kind, path: sweptPath, checksPassed, sessionId = null, journalPath = removalsJournalPath(glimmervoidHomeDir()), log = console }: {
  cause: RemovalCause;
  kind: RemovalKind;
  path: string;
  checksPassed: string[];
  sessionId?: string | null;
  journalPath?: string;
  log?: Pick<Console, 'warn'>;
}): Promise<boolean> {
  return appendRemovalRecord(journalPath, {
    ts: Date.now(), cause, kind, path: sweptPath, branch: null, projectPath: null, sessionId, checksPassed, pid: process.pid,
  }, log);
}

export { appendRemovalRecord, appendRemovalRecordSync, recordSweptPath, removalsJournalPath };
