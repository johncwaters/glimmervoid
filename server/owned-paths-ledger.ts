import path from 'node:path';
import { createJsonStateStore } from './json-file.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { OwnedPathsLedger } from '../shared/contracts/owned-paths.ts';
import type { OwnedPathEntry } from '../shared/contracts/owned-paths.ts';
import { caseFoldedPathKey } from '../shared/paths.ts';

type OwnedPathsLedgerHandle = ReturnType<typeof createOwnedPathsLedger>;

function ownedPathsLedgerPath(glimmervoidHome: string = glimmervoidHomeDir()): string {
  return path.join(glimmervoidHome, 'owned-paths.json');
}

function ledgerKey(ownedPath: string): string {
  return caseFoldedPathKey(path.resolve(ownedPath));
}

function createOwnedPathsLedger({ filePath, log = console }: { filePath: string; log?: Pick<Console, 'warn'> }) {
  const entriesByPath = new Map<string, OwnedPathEntry>();
  let isLoaded = false;
  const store = createJsonStateStore({
    name: 'owned paths ledger',
    filePath,
    parse: (raw) => OwnedPathsLedger.safeParse(raw).data ?? null,
    adopt: (ledger) => {
      entriesByPath.clear();
      for (const entry of ledger?.entries ?? []) entriesByPath.set(ledgerKey(entry.path), entry);
      isLoaded = true;
    },
    warn: (message, fields) => log.warn(`[owned-paths] ${message} ${JSON.stringify(fields)}`),
  });

  async function persist(): Promise<void> {
    const ledger: OwnedPathsLedger = { version: 1, entries: [...entriesByPath.values()] };
    await store.write(ledger, () => `${JSON.stringify(ledger, null, 2)}\n`);
  }

  async function record(entry: OwnedPathEntry): Promise<void> {
    await store.load();
    if (!isLoaded) return;
    const resolvedEntry = { ...entry, path: path.resolve(entry.path) };
    entriesByPath.set(ledgerKey(resolvedEntry.path), resolvedEntry);
    await persist();
  }

  async function forget(ownedPath: string): Promise<void> {
    await store.load();
    if (!isLoaded || !entriesByPath.delete(ledgerKey(ownedPath))) return;
    await persist();
  }

  async function load(): Promise<{ ok: true; entries: OwnedPathEntry[] } | { ok: false }> {
    await store.load();
    if (!isLoaded) return { ok: false };
    return { ok: true, entries: [...entriesByPath.values()] };
  }

  return { load, record, forget, idle: () => store.idle() };
}

export { createOwnedPathsLedger, ownedPathsLedgerPath };
export type { OwnedPathsLedgerHandle };
