import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isMissingFileError } from '../../shared/text.ts';

type StoredRecord = { bytes: Buffer; generation: string };
type RecordWriteOutcome = 'written' | 'conflict';

type TenantRecordStore = {
  read(slug: string, name: string): Promise<StoredRecord | null>;
  write(slug: string, name: string, bytes: Buffer, ifGeneration: string | null): Promise<RecordWriteOutcome>;
};

const RECORD_NAME_PATTERN = /^[a-z0-9-]{1,60}$/;
const RECORDS_FOLDER = 'records';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_FOLDER_MODE = 0o700;

function generationOf(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createFileTenantRecordStore({ watcherHomeFor }: { watcherHomeFor: (slug: string) => string | null }): TenantRecordStore {
  const writesByPath = new Map<string, Promise<RecordWriteOutcome>>();

  function recordPath(slug: string, name: string): string {
    if (!RECORD_NAME_PATTERN.test(name)) throw new Error(`record name ${name} is not allowed`);
    const watcherHome = watcherHomeFor(slug);
    if (watcherHome === null) throw new Error(`tenant ${slug} is not in the table`);
    return path.join(watcherHome, RECORDS_FOLDER, name);
  }

  async function readAt(filePath: string): Promise<StoredRecord | null> {
    try {
      const bytes = await fsp.readFile(filePath);
      return { bytes, generation: generationOf(bytes) };
    } catch (readError) {
      if (isMissingFileError(readError)) return null;
      throw readError;
    }
  }

  async function writeAt(filePath: string, bytes: Buffer, ifGeneration: string | null): Promise<RecordWriteOutcome> {
    const current = await readAt(filePath);
    if ((current?.generation ?? null) !== ifGeneration) return 'conflict';
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_FOLDER_MODE });
    const partialPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.partial`;
    await fsp.writeFile(partialPath, bytes, { mode: PRIVATE_FILE_MODE });
    await fsp.rename(partialPath, filePath);
    return 'written';
  }

  function read(slug: string, name: string): Promise<StoredRecord | null> {
    return readAt(recordPath(slug, name));
  }

  function write(slug: string, name: string, bytes: Buffer, ifGeneration: string | null): Promise<RecordWriteOutcome> {
    const filePath = recordPath(slug, name);
    const previousWrite = writesByPath.get(filePath) ?? Promise.resolve('written' as const);
    const thisWrite = previousWrite.catch(() => 'conflict' as const).then(() => writeAt(filePath, bytes, ifGeneration));
    writesByPath.set(filePath, thisWrite);
    void thisWrite.finally(() => {
      if (writesByPath.get(filePath) === thisWrite) writesByPath.delete(filePath);
    }).catch(() => {});
    return thisWrite;
  }

  return { read, write };
}

export { createFileTenantRecordStore, generationOf };
export type { RecordWriteOutcome, StoredRecord, TenantRecordStore };
