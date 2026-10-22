import fs from 'node:fs/promises';
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

async function canonicalOwnedPath(ownedPath: string): Promise<string> {
  const resolvedPath = path.resolve(ownedPath);
  const missingSegments: string[] = [];
  let existingAncestor = resolvedPath;
  while (true) {
    const realAncestor = await fs.realpath(existingAncestor).catch(() => null);
    if (realAncestor !== null) return path.join(realAncestor, ...missingSegments);
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return resolvedPath;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
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
    const canonicalEntry = { ...entry, path: await canonicalOwnedPath(entry.path) };
    entriesByPath.set(ledgerKey(canonicalEntry.path), canonicalEntry);
    await persist();
  }

  async function forget(ownedPath: string): Promise<void> {
    await store.load();
    if (!isLoaded || !entriesByPath.delete(ledgerKey(await canonicalOwnedPath(ownedPath)))) return;
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
