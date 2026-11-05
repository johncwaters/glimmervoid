import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PACK_FILE_NAME } from '../../shared/contracts/pack.ts';
import { PackStoreData, packStoreAfterSet, packStoreSizeError } from '../../shared/contracts/pack-bridge.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { loadJsonStateFile, writeTextAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';

const PACK_DATA_DIR_NAME = 'pack-data';
const DATA_FILE_SUFFIX = '.json';

const PackDataFile = z.strictObject({ packDir: z.string().min(1), data: PackStoreData });
type PackDataFile = z.infer<typeof PackDataFile>;
type PackDataRead = { ok: true; data: PackStoreData } | { ok: false; error: string };
type DataFileRead = { ok: true; file: PackDataFile | null } | { ok: false; error: string };

export function createPackData({ homeDir, panelPackDir }: { homeDir: string; panelPackDir: (packName: string) => string | null }) {
  const writes = createKeyedSerialQueue();
  const dataDir = path.join(homeDir, PACK_DATA_DIR_NAME);
  const dataPathOf = (packName: string) => path.join(dataDir, `${packName}${DATA_FILE_SUFFIX}`);

  async function readDataFile(packName: string): Promise<DataFileRead> {
    const outcome = await loadJsonStateFile({ filePath: dataPathOf(packName), parse: (raw) => PackDataFile.safeParse(raw).data ?? null });
    if (outcome.status === 'loaded') return { ok: true, file: outcome.value };
    if (outcome.status === 'missing' || outcome.status === 'quarantined') return { ok: true, file: null };
    return { ok: false, error: `${dataPathOf(packName)} could not be read: ${errorMessage(outcome.error)}` };
  }

  async function readOwnedData(packName: string, packDir: string): Promise<PackDataRead> {
    const read = await readDataFile(packName);
    if (!read.ok) return read;
    const ownedFile = read.file?.packDir === packDir ? read.file : null;
    return { ok: true, data: ownedFile?.data ?? {} };
  }

  function get(packName: string): Promise<PackDataRead> {
    const packDir = panelPackDir(packName);
    if (packDir === null) return Promise.resolve({ ok: false, error: `${packName} is not an approved pack with panels` });
    return readOwnedData(packName, packDir);
  }

  async function setNow(packName: string, key: string, value: unknown): Promise<PackDataRead> {
    const packDir = panelPackDir(packName);
    if (packDir === null) return { ok: false, error: `${packName} is not an approved pack with panels` };
    const current = await readOwnedData(packName, packDir);
    if (!current.ok) return current;
    const next = packStoreAfterSet(current.data, key, value);
    const sizeError = packStoreSizeError(packName, next);
    if (sizeError !== null) return { ok: false, error: sizeError };
    try {
      await writeTextAtomic(dataPathOf(packName), `${JSON.stringify({ packDir, data: next } satisfies PackDataFile)}\n`, { mkdir: true });
    } catch (error) {
      return { ok: false, error: `Could not save ${dataPathOf(packName)}: ${errorMessage(error)}` };
    }
    return { ok: true, data: next };
  }

  function set(packName: string, key: string, value: unknown): Promise<PackDataRead> {
    return writes.run(packName, () => setNow(packName, key, value));
  }

  async function forgetIfPackRemoved(packName: string): Promise<void> {
    const read = await readDataFile(packName);
    if (!read.ok || read.file === null) return;
    const isManifestGone = await fs.promises.access(path.join(read.file.packDir, PACK_FILE_NAME)).then(() => false, isMissingFileError);
    if (isManifestGone) await fs.promises.rm(dataPathOf(packName), { force: true });
  }

  async function forgetRemovedPacks(): Promise<void> {
    const fileNames = await fs.promises.readdir(dataDir).catch((error: unknown) => (isMissingFileError(error) ? [] : Promise.reject(error)));
    const packNames = fileNames.filter((fileName) => fileName.endsWith(DATA_FILE_SUFFIX)).map((fileName) => fileName.slice(0, -DATA_FILE_SUFFIX.length));
    await Promise.all(packNames.map((packName) => writes.run(packName, () => forgetIfPackRemoved(packName))));
  }

  return { get, set, forgetRemovedPacks };
}

export type PackData = ReturnType<typeof createPackData>;
