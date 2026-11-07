import fsp from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../json-file.ts';
import { RaceRecord } from '../../shared/contracts/race.ts';
import { errorMessage } from '../../shared/text.ts';

function createRaceStore({ directory, log }: { directory: string; log: Pick<Console, 'warn'> }) {
  const fileOf = (raceId: string): string => path.join(directory, `${raceId}.json`);

  async function read(raceId: string): Promise<RaceRecord | null> {
    const text = await fsp.readFile(fileOf(raceId), 'utf8').catch(() => null);
    if (text === null) return null;
    try {
      const parsed = RaceRecord.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      log.warn(`[race] ${fileOf(raceId)} is not a valid race: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`);
    } catch (error) {
      log.warn(`[race] ${fileOf(raceId)} is not JSON: ${errorMessage(error)}`);
    }
    return null;
  }

  async function write(record: RaceRecord): Promise<void> {
    await fsp.mkdir(directory, { recursive: true });
    await writeJsonAtomic(fileOf(record.id), record);
  }

  async function list(): Promise<RaceRecord[]> {
    const names = await fsp.readdir(directory).catch(() => []);
    const records: RaceRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await read(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }

  return { read, write, list };
}

type RaceStore = ReturnType<typeof createRaceStore>;

export { createRaceStore };
export type { RaceStore };
