import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { AwakeEvent, DoormanTenantTable } from '../../shared/contracts/doorman.ts';
import type { DoormanTenant } from '../../shared/contracts/doorman.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { movedSecretPath } from '../../server/secrets/core/secret-files-core.ts';
import { watcherFilesInFolder } from '../watcher/watcher-home.ts';
import type { WatcherFiles } from '../watcher/watcher-home.ts';
import { createGcpRest, isTransientFailure } from './gcp-rest.ts';
import type { GcpRest } from './gcp-rest.ts';
import type { TenantRecordStore } from './tenant-record-store.ts';

type AwakeLedger = {
  identity: string;
  recentEvents(): Promise<AwakeEvent[]>;
  append(awakeEvents: readonly AwakeEvent[]): Promise<void>;
};

type DoormanTenantState = {
  linkSecretHex(tenant: DoormanTenant): Promise<string | null>;
  ledgerOf(tenant: DoormanTenant): AwakeLedger;
  watcherFilesOf(tenant: DoormanTenant): WatcherFiles;
};

type DoormanState = {
  where: string;
  lockFolder: string | null;
  readTable(): Promise<DoormanTenantTable>;
  watchTable(onChange: () => void): () => void;
  tenantState: DoormanTenantState;
  tenantRecords: TenantRecordStore | null;
};

type StoredObject = { bytes: Buffer; generation: string };
type ObjectWrite = 'written' | 'conflict';
type DoormanStateLog = Pick<Console, 'warn'>;

const AWAKE_LEDGER_FILE_NAME = 'awake-ledger.jsonl';
const STATE_TABLE_OBJECT_NAME = 'tenants.json';
const LINK_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const LINK_SECRET_VERSION_ALIAS = 'latest';
const TABLE_RELOAD_SETTLE_MS = 200;
const TABLE_PRESENCE_POLL_MS = 2_000;
const STATE_TABLE_POLL_MS = 10_000;
const LEDGER_WRITE_ATTEMPTS = 5;
const RECENT_LEDGER_MONTHS = 2;
const STORAGE_ORIGIN = 'https://storage.googleapis.com';
const STATE_BUCKET_PATTERN = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/?$/;
const NOT_FOUND: ReadonlySet<number> = new Set([404]);
const PRECONDITION_FAILED: ReadonlySet<number> = new Set([412]);

const ObjectGeneration = z.object({ generation: z.string().min(1) });
const ObjectListPage = z.object({ items: z.array(z.object({ name: z.string() })).default([]), nextPageToken: z.string().optional() });

function awakeEventsIn(ledgerText: string, where: string, log: DoormanStateLog): AwakeEvent[] {
  return ledgerText.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    const parsed = AwakeEvent.safeParse(jsonOrNull(line));
    if (parsed.success) return [parsed.data];
    log.warn(`[doorman] skipped a line of ${where} that is not an awake event`);
    return [];
  });
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ledgerLines(awakeEvents: readonly AwakeEvent[]): string {
  return awakeEvents.map((awakeEvent) => `${JSON.stringify(awakeEvent)}\n`).join('');
}

function linkSecretHexIn(text: string): string | null {
  const secretHex = text.trim();
  return LINK_SECRET_PATTERN.test(secretHex) ? secretHex : null;
}

async function linkSecretHexAt(linkSecretPath: string): Promise<string | null> {
  return linkSecretHexIn(await fsp.readFile(linkSecretPath, 'utf8').catch(() => ''));
}

function createLinkSecretReader(google: GcpRest, log: DoormanStateLog) {
  return async function linkSecretHex(tenant: DoormanTenant): Promise<string | null> {
    const linkSecret = tenant.linkSecret;
    if (linkSecret.kind === 'file') return await linkSecretHexAt(movedSecretPath(linkSecret.path)) ?? linkSecretHexAt(linkSecret.path);
    return google.secretPayload(linkSecret.secret, LINK_SECRET_VERSION_ALIAS).then((payload) => linkSecretHexIn(payload.toString('utf8')), (readError: unknown) => {
      if (isTransientFailure(readError)) throw readError;
      log.warn(`[doorman] reading the link secret of ${tenant.slug} failed: ${readError instanceof Error ? readError.message : String(readError)}`);
      return null;
    });
  };
}

function watcherHomeOf(tenant: DoormanTenant): string {
  if (tenant.watcherHome === null) throw new Error(`tenant ${tenant.slug} has no watcher home, which a tenant table file needs`);
  return tenant.watcherHome;
}

function fileLedger(watcherHome: string, log: DoormanStateLog): AwakeLedger {
  const ledgerPath = path.join(watcherHome, AWAKE_LEDGER_FILE_NAME);
  return {
    identity: ledgerPath,
    recentEvents: async () => {
      const ledgerText = await fsp.readFile(ledgerPath, 'utf8').catch((readError: unknown) => {
        if (isMissingFileError(readError)) return '';
        throw readError;
      });
      return awakeEventsIn(ledgerText, ledgerPath, log);
    },
    append: async (awakeEvents) => {
      await fsp.mkdir(watcherHome, { recursive: true, mode: 0o700 });
      await fsp.appendFile(ledgerPath, ledgerLines(awakeEvents), { mode: 0o600 });
    },
  };
}

function createFileTenantState({ google = createGcpRest(), log = console }: { google?: GcpRest; log?: DoormanStateLog } = {}): DoormanTenantState {
  return {
    linkSecretHex: createLinkSecretReader(google, log),
    ledgerOf: (tenant) => fileLedger(watcherHomeOf(tenant), log),
    watcherFilesOf: (tenant) => watcherFilesInFolder(watcherHomeOf(tenant)),
  };
}

async function readFileTable(tablePath: string): Promise<DoormanTenantTable> {
  const table = DoormanTenantTable.parse(JSON.parse(await fsp.readFile(tablePath, 'utf8')));
  table.tenants.forEach(watcherHomeOf);
  return table;
}

function watchTableFile(tablePath: string, onChange: () => void): () => void {
  let settleTimer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(canonicalizePath(path.dirname(tablePath)), (_event, changedName) => {
    if (changedName !== null && changedName !== path.basename(tablePath)) return;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(onChange, TABLE_RELOAD_SETTLE_MS);
  });
  watcher.on('error', onChange);
  const onTableStat = (current: fs.Stats) => {
    if (current.nlink === 0) onChange();
  };
  fs.watchFile(tablePath, { interval: TABLE_PRESENCE_POLL_MS, persistent: false }, onTableStat);
  return () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    watcher.close();
    fs.unwatchFile(tablePath, onTableStat);
  };
}

function createFileDoormanState({ tablePath, log = console }: { tablePath: string; log?: DoormanStateLog }): DoormanState {
  return {
    where: tablePath,
    lockFolder: path.dirname(path.resolve(tablePath)),
    readTable: () => readFileTable(tablePath),
    watchTable: (onChange) => watchTableFile(tablePath, onChange),
    tenantState: createFileTenantState({ log }),
    tenantRecords: null,
  };
}

function createGcsObjects(bucket: string, google: GcpRest) {
  const objectsUrl = `${STORAGE_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o`;

  async function read(objectName: string): Promise<StoredObject | null> {
    const response = await google.authorizedResponse(`${objectsUrl}/${encodeURIComponent(objectName)}?alt=media`, {}, `reading gs://${bucket}/${objectName}`, NOT_FOUND);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const generation = response.headers.get('x-goog-generation');
    if (generation === null) throw new Error(`gs://${bucket}/${objectName} came back with no generation`);
    return { bytes: Buffer.from(await response.arrayBuffer()), generation };
  }

  async function generationOf(objectName: string): Promise<string | null> {
    const response = await google.authorizedResponse(`${objectsUrl}/${encodeURIComponent(objectName)}?fields=generation`, {}, `reading gs://${bucket}/${objectName}`, NOT_FOUND);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return ObjectGeneration.parse(await response.json()).generation;
  }

  async function write(objectName: string, contents: Buffer | string, ifGeneration: string | null): Promise<ObjectWrite> {
    const precondition = ifGeneration === null ? '' : `&ifGenerationMatch=${encodeURIComponent(ifGeneration)}`;
    const uploadUrl = `${STORAGE_ORIGIN}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}${precondition}`;
    const response = await google.authorizedResponse(uploadUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: typeof contents === 'string' ? contents : new Uint8Array(contents) }, `writing gs://${bucket}/${objectName}`, PRECONDITION_FAILED);
    await response.body?.cancel();
    return response.status === 412 ? 'conflict' : 'written';
  }

  async function namesUnder(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | null = null;
    do {
      const pageQuery: string = pageToken === null ? '' : `&pageToken=${encodeURIComponent(pageToken)}`;
      const page = ObjectListPage.parse(await google.authorizedJson(`${objectsUrl}?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${pageQuery}`, {}, `listing gs://${bucket}/${prefix}`));
      names.push(...page.items.map((item) => item.name));
      pageToken = page.nextPageToken ?? null;
    } while (pageToken !== null);
    return names.sort();
  }

  return { read, generationOf, write, namesUnder };
}

type GcsObjects = ReturnType<typeof createGcsObjects>;

function ledgerMonthOf(awakeEvent: AwakeEvent): string {
  return awakeEvent.at.slice(0, 7);
}

function gcsLedger(objects: GcsObjects, slug: string, log: DoormanStateLog): AwakeLedger {
  const ledgerPrefix = `tenants/${slug}/ledger/`;

  async function appendToMonth(objectName: string, monthEvents: readonly AwakeEvent[]): Promise<void> {
    for (let attempt = 1; attempt <= LEDGER_WRITE_ATTEMPTS; attempt += 1) {
      const stored = await objects.read(objectName);
      const storedLines = new Set((stored?.bytes.toString('utf8') ?? '').split('\n'));
      const unstoredLines = ledgerLines(monthEvents.filter((awakeEvent) => !storedLines.has(JSON.stringify(awakeEvent))));
      if (unstoredLines === '') return;
      const outcome = await objects.write(objectName, Buffer.concat([stored?.bytes ?? Buffer.alloc(0), Buffer.from(unstoredLines)]), stored?.generation ?? '0');
      if (outcome === 'written') return;
    }
    throw new Error(`${objectName} kept changing under ${LEDGER_WRITE_ATTEMPTS} appends`);
  }

  return {
    identity: ledgerPrefix,
    recentEvents: async () => {
      const recentNames = (await objects.namesUnder(ledgerPrefix)).slice(-RECENT_LEDGER_MONTHS);
      const monthTexts = await Promise.all(recentNames.map(async (objectName) => (await objects.read(objectName))?.bytes.toString('utf8') ?? ''));
      return monthTexts.flatMap((monthText, index) => awakeEventsIn(monthText, recentNames[index], log));
    },
    append: async (awakeEvents) => {
      const months = [...new Set(awakeEvents.map(ledgerMonthOf))];
      for (const month of months) await appendToMonth(`${ledgerPrefix}${month}.jsonl`, awakeEvents.filter((awakeEvent) => ledgerMonthOf(awakeEvent) === month));
    },
  };
}

function gcsWatcherFiles(objects: GcsObjects, slug: string): WatcherFiles {
  const watcherPrefix = `tenants/${slug}/watcher/`;
  return {
    read: async (fileName) => (await objects.read(`${watcherPrefix}${fileName}`))?.bytes ?? null,
    write: async (fileName, contents) => {
      await objects.write(`${watcherPrefix}${fileName}`, contents, null);
    },
  };
}

function gcsTenantRecords(objects: GcsObjects): TenantRecordStore {
  return {
    read: (slug: string, recordName: string) => objects.read(`tenants/${slug}/records/${recordName}`),
    write: (slug: string, recordName: string, bytes: Buffer, ifGeneration: string | null) => objects.write(`tenants/${slug}/records/${recordName}`, bytes, ifGeneration ?? '0'),
  };
}

function watchStateTable(objects: GcsObjects, generationRead: () => string | null, onChange: () => void, log: DoormanStateLog): () => void {
  const poll = () => {
    objects.generationOf(STATE_TABLE_OBJECT_NAME).then((generation) => {
      if (generation !== generationRead()) onChange();
    }, (pollError: unknown) => log.warn(`[doorman] checking the tenant table failed: ${pollError instanceof Error ? pollError.message : String(pollError)}`));
  };
  const pollTimer = setInterval(poll, STATE_TABLE_POLL_MS);
  return () => clearInterval(pollTimer);
}

function stateBucketOf(stateUrl: string): string | null {
  return STATE_BUCKET_PATTERN.exec(stateUrl)?.[1] ?? null;
}

function createGcsDoormanState({ bucket, google = createGcpRest(), log = console }: { bucket: string; google?: GcpRest; log?: DoormanStateLog }) {
  const objects = createGcsObjects(bucket, google);
  let tableGenerationRead: string | null = null;

  async function readTable(): Promise<DoormanTenantTable> {
    const stored = await objects.read(STATE_TABLE_OBJECT_NAME);
    if (stored === null) throw new Error(`gs://${bucket}/${STATE_TABLE_OBJECT_NAME} does not exist`);
    const table = DoormanTenantTable.parse(JSON.parse(stored.bytes.toString('utf8')));
    tableGenerationRead = stored.generation;
    return table;
  }

  return {
    where: `gs://${bucket}/${STATE_TABLE_OBJECT_NAME}`,
    lockFolder: null,
    readTable,
    watchTable: (onChange: () => void) => watchStateTable(objects, () => tableGenerationRead, onChange, log),
    tenantState: {
      linkSecretHex: createLinkSecretReader(google, log),
      ledgerOf: (tenant: DoormanTenant) => gcsLedger(objects, tenant.slug, log),
      watcherFilesOf: (tenant: DoormanTenant) => gcsWatcherFiles(objects, tenant.slug),
    },
    tenantRecords: gcsTenantRecords(objects),
  } satisfies DoormanState;
}

export { createFileDoormanState, createFileTenantState, createGcsDoormanState, stateBucketOf };
export type { AwakeLedger, DoormanState, DoormanTenantState };
