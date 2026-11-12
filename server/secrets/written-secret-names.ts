import path from 'node:path';

import { createJsonStateStore } from '../json-file.ts';
import { WrittenSecretNames } from '../../shared/contracts/secrets.ts';

interface WrittenSecretNamesStore {
  remember(directory: string, names: readonly string[]): Promise<void>;
  namesIn(directory: string): Promise<readonly string[]>;
}

function createWrittenSecretNames({ filePath, log = console }: { filePath: string; log?: Pick<Console, 'warn'> }): WrittenSecretNamesStore {
  let namesByDirectory: Record<string, string[]> = {};
  let isLoaded = false;
  const store = createJsonStateStore({
    name: 'written secret names',
    filePath,
    parse: (raw) => WrittenSecretNames.safeParse(raw).data ?? null,
    adopt: (record) => {
      namesByDirectory = { ...record?.namesByDirectory };
      isLoaded = true;
    },
    warn: (message, fields) => log.warn(`[secrets] ${message} ${JSON.stringify(fields)}`),
  });

  async function remember(directory: string, names: readonly string[]): Promise<void> {
    await store.load();
    if (!isLoaded) return;
    const directoryKey = path.resolve(directory);
    namesByDirectory[directoryKey] = [...new Set([...(namesByDirectory[directoryKey] ?? []), ...names])].sort();
    const record: WrittenSecretNames = { version: 1, namesByDirectory };
    await store.write(record, () => `${JSON.stringify(record, null, 2)}\n`);
  }

  async function namesIn(directory: string): Promise<readonly string[]> {
    await store.load();
    return namesByDirectory[path.resolve(directory)] ?? [];
  }

  return { remember, namesIn };
}

export { createWrittenSecretNames };
