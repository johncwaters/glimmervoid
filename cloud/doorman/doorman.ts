import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { createProxyServer } from 'httpxy';
import { credentialStoreKey, directionKey } from '../link/core/link-signing-core.ts';
import { createNudgeSender, createProbeRunner } from '../watcher/probe-runner.ts';
import { createWatcherHome } from '../watcher/watcher-home.ts';
import { createWatcherListener } from '../watcher/watcher-listener.ts';
import { canonicalizePath } from '../../shared/canonical-paths.ts';
import { DoormanTenantTable } from '../../shared/contracts/doorman.ts';
import type { DoormanTenant } from '../../shared/contracts/doorman.ts';
import { headersAtEdge, isConnectFailure, isWakeAllowed, nextForwardState, routeRequest } from './doorman-core.ts';
import type { DoormanRoute, ForwardState } from './doorman-core.ts';

type HostAdapter = { wake(tenantSlug: string): Promise<void> };
type DoormanTunables = { holdTimeoutMs: number; wakeCooldownMs: number; maxHeldPerTenant: number; readinessPollMs: number };
type WakeOutcome = 'answering' | 'no-adapter' | 'cooling-down' | 'unreachable';
type TenantGate = { state: ForwardState; heldCount: number; wakePromise: Promise<WakeOutcome> | null; lastWakeAtMs: number | null };
type TenantWatcher = { handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>; stop(): void };
type TenantEntry = { tenant: DoormanTenant; gate: TenantGate; watcher: TenantWatcher | null; watcherSecretHex: string | null; watcherStart: Promise<TenantWatcher | null> | null };
type DoormanLog = Pick<Console, 'log' | 'warn'>;

const DEFAULT_TUNABLES: DoormanTunables = Object.freeze({ holdTimeoutMs: 60_000, wakeCooldownMs: 30_000, maxHeldPerTenant: 64, readinessPollMs: 500 });
const READINESS_ATTEMPT_TIMEOUT_MS = 2000;
const RETRY_AFTER_SECONDS = '5';
const LOOPBACK_HOST = '127.0.0.1';
const LINK_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const TABLE_RELOAD_SETTLE_MS = 200;

async function readLinkSecretHex(linkSecretPath: string): Promise<string | null> {
  const secretHex = await fsp.readFile(linkSecretPath, 'utf8').then((text) => text.trim(), () => '');
  return LINK_SECRET_PATTERN.test(secretHex) ? secretHex : null;
}

async function readTenantTable(tablePath: string): Promise<DoormanTenantTable> {
  return DoormanTenantTable.parse(JSON.parse(await fsp.readFile(tablePath, 'utf8')));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerStatus(response: http.ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify({ error: http.STATUS_CODES[status] ?? 'error' }));
}

function answerBusy(response: http.ServerResponse): void {
  answerStatus(response, 503, { 'retry-after': RETRY_AFTER_SECONDS });
}

function refuseUpgrade(socket: Duplex, status: number): void {
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nconnection: close\r\n\r\n`);
  socket.destroy();
}

function hasRequestBody(request: http.IncomingMessage): boolean {
  return request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0;
}

function causeOf(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

async function createTenantWatcher(tenant: DoormanTenant, linkSecret: Buffer, { forwardFetch, probeFetch, now, log }: { forwardFetch: typeof fetch; probeFetch: typeof fetch; now: () => number; log: DoormanLog }): Promise<TenantWatcher> {
  const home = createWatcherHome({ homeDir: tenant.watcherHome, credentialKey: credentialStoreKey(linkSecret), log });
  const nudges = createNudgeSender({ serverUrl: tenant.serverUrl, signingKey: directionKey(linkSecret, 'watcher-to-server'), fetchFn: forwardFetch, now, log });
  const runner = createProbeRunner({ home, nudges, fetchFn: probeFetch, now, log });
  const listener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), now, log });
  await runner.start();
  return {
    handle: listener.handle,
    stop: () => {
      runner.stop();
      nudges.stop();
    },
  };
}

function createDoorman({ table: initialTable, hostAdapter = null, tunables = DEFAULT_TUNABLES, probeFetch = fetch, now = Date.now, log = console }: {
  table: DoormanTenantTable;
  hostAdapter?: HostAdapter | null;
  tunables?: DoormanTunables;
  probeFetch?: typeof fetch;
  now?: () => number;
  log?: DoormanLog;
}) {
  const proxy = createProxyServer({ xfwd: false, changeOrigin: false });
  const entriesBySlug = new Map<string, TenantEntry>();
  let table = initialTable;

  async function waitUntilAnswering(serverUrl: string, deadlineMs: number): Promise<boolean> {
    while (now() < deadlineMs) {
      try {
        const response = await fetch(serverUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(READINESS_ATTEMPT_TIMEOUT_MS) });
        await response.body?.cancel();
        return true;
      } catch {
        await sleep(tunables.readinessPollMs);
      }
    }
    return false;
  }

  async function runWake(entry: TenantEntry, adapter: HostAdapter): Promise<WakeOutcome> {
    await adapter.wake(entry.tenant.slug).catch((wakeError: unknown) => {
      log.warn(`[doorman] waking ${entry.tenant.slug} failed: ${errorMessage(wakeError)}`);
    });
    const isAnswering = await waitUntilAnswering(entry.tenant.serverUrl, now() + tunables.holdTimeoutMs);
    entry.gate.state = nextForwardState(entry.gate.state, isAnswering ? 'connected' : 'holdTimedOut');
    return isAnswering ? 'answering' : 'unreachable';
  }

  function wakeTenant(entry: TenantEntry): Promise<WakeOutcome> {
    if (entry.gate.wakePromise !== null) return entry.gate.wakePromise;
    if (hostAdapter === null) return Promise.resolve('no-adapter');
    if (!isWakeAllowed(entry.gate.lastWakeAtMs, now(), tunables.wakeCooldownMs)) return Promise.resolve('cooling-down');
    entry.gate.state = nextForwardState(entry.gate.state, entry.gate.state === 'unreachable' ? 'cooldownPassedAndRequest' : 'connectFailed');
    entry.gate.lastWakeAtMs = now();
    const wakePromise = runWake(entry, hostAdapter).finally(() => {
      entry.gate.wakePromise = null;
    });
    entry.gate.wakePromise = wakePromise;
    return wakePromise;
  }

  async function holdUntilAwake(entry: TenantEntry): Promise<WakeOutcome | 'over-capacity'> {
    if (entry.gate.heldCount >= tunables.maxHeldPerTenant) return 'over-capacity';
    entry.gate.heldCount += 1;
    try {
      return await wakeTenant(entry);
    } finally {
      entry.gate.heldCount -= 1;
    }
  }

  async function forwardAfterHold(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse, bodyless: Readable | undefined): Promise<void> {
    const outcome = await holdUntilAwake(entry);
    if (outcome === 'no-adapter') return answerStatus(response, 502);
    if (outcome !== 'answering') return answerBusy(response);
    if (response.destroyed) return;
    await proxy.web(request, response, { target: entry.tenant.serverUrl, buffer: bodyless }).catch((forwardError: unknown) => {
      log.warn(`[doorman] forwarding to ${entry.tenant.slug} failed after waking it: ${errorMessage(forwardError)}`);
      answerStatus(response, 502);
    });
  }

  async function forwardWeb(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (entry.gate.state !== 'answering') return forwardAfterHold(entry, request, response, undefined);
    try {
      await proxy.web(request, response, { target: entry.tenant.serverUrl });
    } catch (forwardError) {
      if (!isConnectFailure(forwardError) || response.headersSent) {
        log.warn(`[doorman] forwarding to ${entry.tenant.slug} failed: ${errorMessage(forwardError)}`);
        return answerStatus(response, 502);
      }
      if (hostAdapter === null) return answerStatus(response, 502);
      if (hasRequestBody(request)) {
        void wakeTenant(entry);
        return answerBusy(response);
      }
      return forwardAfterHold(entry, request, response, Readable.from([]));
    }
  }

  async function forwardUpgrade(entry: TenantEntry, request: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    if (entry.gate.state !== 'answering') {
      const outcome = await holdUntilAwake(entry);
      if (outcome === 'no-adapter') return refuseUpgrade(socket, 502);
      if (outcome !== 'answering') return refuseUpgrade(socket, 503);
    }
    await proxy.ws(request, socket, { target: entry.tenant.serverUrl }, head).catch((forwardError: unknown) => {
      if (isConnectFailure(forwardError) && hostAdapter !== null) void wakeTenant(entry);
      refuseUpgrade(socket, 502);
    });
  }

  function routeOf(request: http.IncomingMessage): DoormanRoute | { kind: 'refuse'; status: 400 } {
    const requestUrl = URL.parse(request.url ?? '/', 'http://doorman');
    if (requestUrl === null) return { kind: 'refuse', status: 400 };
    return routeRequest(table, request.headers.host, requestUrl.pathname);
  }

  function entryFor(tenant: DoormanTenant): TenantEntry | null {
    return entriesBySlug.get(tenant.slug) ?? null;
  }

  async function handleWatcherRequest(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const watcher = await ensureWatcher(entry);
    if (watcher === null) return answerBusy(response);
    return watcher.handle(request, response);
  }

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const route = routeOf(request);
    if (route.kind === 'refuse') return answerStatus(response, route.status);
    const entry = entryFor(route.tenant);
    if (entry === null) return answerBusy(response);
    if (route.kind === 'watcher') return handleWatcherRequest(entry, request, response);
    request.headers = headersAtEdge(request.headers, table.tenantDomain !== null);
    return forwardWeb(entry, request, response);
  }

  async function handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy());
    if (!(socket instanceof net.Socket)) return refuseUpgrade(socket, 400);
    const route = routeOf(request);
    if (route.kind === 'refuse') return refuseUpgrade(socket, route.status);
    if (route.kind === 'watcher') return refuseUpgrade(socket, 404);
    const entry = entryFor(route.tenant);
    if (entry === null) return refuseUpgrade(socket, 503);
    request.headers = headersAtEdge(request.headers, table.tenantDomain !== null);
    return forwardUpgrade(entry, request, socket, head);
  }

  function stopWatcher(entry: TenantEntry): void {
    entry.watcher?.stop();
    entry.watcher = null;
    entry.watcherSecretHex = null;
  }

  async function startWatcher(entry: TenantEntry): Promise<TenantWatcher | null> {
    const secretHex = await readLinkSecretHex(entry.tenant.linkSecretPath);
    if (secretHex === null) {
      log.warn(`[doorman] tenant ${entry.tenant.slug} has no link secret at ${entry.tenant.linkSecretPath} yet`);
      return null;
    }
    const forwardFetch: typeof fetch = async (input, init) => {
      try {
        return await fetch(input, init);
      } catch (fetchError) {
        if (!isConnectFailure(causeOf(fetchError)) || await wakeTenant(entry) !== 'answering') throw fetchError;
        return fetch(input, init);
      }
    };
    const watcher = await createTenantWatcher(entry.tenant, Buffer.from(secretHex, 'hex'), { forwardFetch, probeFetch, now, log }).catch((startError: unknown) => {
      log.warn(`[doorman] tenant ${entry.tenant.slug} watcher did not start: ${errorMessage(startError)}`);
      return null;
    });
    if (watcher === null) return null;
    if (isClosed || entriesBySlug.get(entry.tenant.slug) !== entry) {
      watcher.stop();
      return null;
    }
    entry.watcher = watcher;
    entry.watcherSecretHex = secretHex;
    return watcher;
  }

  function ensureWatcher(entry: TenantEntry): Promise<TenantWatcher | null> {
    if (entry.watcher !== null) return Promise.resolve(entry.watcher);
    if (entry.watcherStart !== null) return entry.watcherStart;
    const watcherStart = startWatcher(entry).finally(() => {
      entry.watcherStart = null;
    });
    entry.watcherStart = watcherStart;
    return watcherStart;
  }

  async function refreshWatcher(entry: TenantEntry): Promise<void> {
    await entry.watcherStart;
    if (entry.watcher !== null && await readLinkSecretHex(entry.tenant.linkSecretPath) === entry.watcherSecretHex) return;
    stopWatcher(entry);
    await ensureWatcher(entry);
  }

  async function applyTableNow(nextTable: DoormanTenantTable): Promise<void> {
    table = nextTable;
    const nextTenantsBySlug = new Map(nextTable.tenants.map((tenant) => [tenant.slug, tenant]));
    for (const [slug, entry] of entriesBySlug) {
      const nextTenant = nextTenantsBySlug.get(slug);
      if (nextTenant !== undefined && JSON.stringify(nextTenant) === JSON.stringify(entry.tenant)) continue;
      stopWatcher(entry);
      entriesBySlug.delete(slug);
    }
    for (const tenant of nextTable.tenants) {
      if (entriesBySlug.has(tenant.slug)) continue;
      const gate: TenantGate = { state: 'answering', heldCount: 0, wakePromise: null, lastWakeAtMs: null };
      entriesBySlug.set(tenant.slug, { tenant, gate, watcher: null, watcherSecretHex: null, watcherStart: null });
    }
    await Promise.all([...entriesBySlug.values()].map(refreshWatcher));
  }

  let tableUpdates: Promise<void> = Promise.resolve();
  let isClosed = false;

  function applyTable(nextTable: DoormanTenantTable): Promise<void> {
    const update = tableUpdates.then(() => applyTableNow(nextTable));
    tableUpdates = update.catch(() => {});
    return update;
  }

  const server = http.createServer((request, response) => void handleRequest(request, response));
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void handleUpgrade(request, socket, head));

  async function listen(port: number): Promise<number> {
    await applyTable(table);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, LOOPBACK_HOST, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  function close(): Promise<void> {
    isClosed = true;
    for (const entry of entriesBySlug.values()) stopWatcher(entry);
    entriesBySlug.clear();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, applyTable, close };
}

function portFromOption(rawPort: string | null): number | null {
  if (rawPort === null) return 0;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function refuse(reason: string): number {
  console.error(`doorman: ${reason}`);
  return 1;
}

function watchTenantTable(tablePath: string, onChange: () => void): () => void {
  let settleTimer: NodeJS.Timeout | null = null;
  const watcher = fs.watch(canonicalizePath(path.dirname(tablePath)), (_event, changedName) => {
    if (changedName !== null && changedName !== path.basename(tablePath)) return;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(onChange, TABLE_RELOAD_SETTLE_MS);
  });
  return () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    watcher.close();
  };
}

function untilStopped(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });
}

async function runDoormanCli({ tablePath, rawPort }: { tablePath: string | null; rawPort: string | null }): Promise<number> {
  if (tablePath === null) return refuse('--tenants must name the tenant table file');
  const port = portFromOption(rawPort);
  if (port === null) return refuse('--port must be a port from 0 to 65535');
  const table = await readTenantTable(tablePath).catch((readError: unknown) => new Error(errorMessage(readError)));
  if (table instanceof Error) return refuse(`${tablePath} is not a tenant table: ${table.message}`);
  const doorman = createDoorman({ table });
  const boundPort = await doorman.listen(port);
  console.log(`[doorman] listening on ${LOOPBACK_HOST}:${boundPort} for ${table.tenants.length} tenant(s)`);
  const reload = () => {
    readTenantTable(tablePath).then(doorman.applyTable, (reloadError: unknown) => {
      console.warn(`[doorman] kept the previous tenant table: ${errorMessage(reloadError)}`);
    });
  };
  const stopWatching = watchTenantTable(tablePath, reload);
  process.on('SIGHUP', reload);
  await untilStopped();
  stopWatching();
  process.off('SIGHUP', reload);
  await doorman.close();
  return 0;
}

export { createDoorman, runDoormanCli };
export type { HostAdapter };
