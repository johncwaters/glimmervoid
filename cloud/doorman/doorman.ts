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
import { DOORMAN_LOCK_FILE_NAME, DOORMAN_PORT_FILE_NAME, DoormanTenantTable } from '../../shared/contracts/doorman.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { movedSecretPath } from '../../server/secrets/core/secret-files-core.ts';
import { loadFileLocks } from '../../server/session-temp/session-temp-locks.ts';
import { stampProcessOutputLines } from '../../server/log-stamp.ts';
import type { DoormanGithubApp, DoormanTenant, DoormanTenantTableInput } from '../../shared/contracts/doorman.ts';
import type { AwakeUsage, GithubTokenAnswer, HostStopOutcome } from '../../shared/contracts/watcher-link.ts';
import { createAwakeMeter } from './awake-meter.ts';
import type { AwakeMeter } from './awake-meter.ts';
import { edgeWakeRetryAfterMs, headersAtEdge, isConnectFailure, isOverCap, isTokenFreshForServer, isWakeAllowed, mintRetryDelayMs, nextForwardState, recentEdgeWakeTimes, routeRequest, tokenRefreshDelayMs, wantsWakingPage } from './doorman-core.ts';
import { createGcpHostAdapter } from './gcp-host.ts';
import type { HostAdapter } from './gcp-host.ts';
import { createGithubAppMinter } from './github-app.ts';
import type { GithubAppMinter } from './github-app.ts';
import type { DoormanRoute, ForwardState } from './doorman-core.ts';
import { clock } from '../../shared/clock.ts';

type DoormanTunables = { holdTimeoutMs: number; wakeCooldownMs: number; maxHeldPerTenant: number; readinessPollMs: number; meterTickMs: number; maxEdgeWakesPerHour: number };
type WakeOutcome = 'answering' | 'no-adapter' | 'cooling-down' | 'unreachable' | 'over-cap' | 'wake-limited';
type WakeStartedBy = 'edge' | 'watcher';
type TenantGate = { state: ForwardState; heldCount: number; wakePromise: Promise<WakeOutcome> | null; lastWakeAtMs: number | null; edgeWakeTimesMs: number[]; stopStartedAtMs: number | null };
type TenantWatcher = { handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>; githubTokenChanged(): void; stop(): void };
type HeldGithubToken = { token: string; expiresAtMs: number };
type TenantGithubToken = { held: HeldGithubToken | null; mint: Promise<HeldGithubToken | null> | null; refreshTimer: NodeJS.Timeout | null; failedAttempts: number; nextMintAllowedAtMs: number };
type TenantEntry = { tenant: DoormanTenant; gate: TenantGate; meter: AwakeMeter | null; watcher: TenantWatcher | null; watcherSecretHex: string | null; watcherStart: Promise<TenantWatcher | null> | null; github: TenantGithubToken };
type DoormanLog = Pick<Console, 'log' | 'warn'>;

const DEFAULT_TUNABLES: DoormanTunables = Object.freeze({ holdTimeoutMs: 60_000, wakeCooldownMs: 30_000, maxHeldPerTenant: 64, readinessPollMs: 500, meterTickMs: 60_000, maxEdgeWakesPerHour: 4 });
const READINESS_ATTEMPT_TIMEOUT_MS = 2000;
const RETRY_AFTER_SECONDS = '5';
const LOOPBACK_HOST = '127.0.0.1';
const LINK_SECRET_PATTERN = /^[0-9a-f]{64}$/;
const TABLE_RELOAD_SETTLE_MS = 200;
const TABLE_PRESENCE_POLL_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

async function linkSecretHexAt(linkSecretPath: string): Promise<string | null> {
  const secretHex = await fsp.readFile(linkSecretPath, 'utf8').then((text) => text.trim(), () => '');
  return LINK_SECRET_PATTERN.test(secretHex) ? secretHex : null;
}

async function readLinkSecretHex(linkSecretPath: string): Promise<string | null> {
  return await linkSecretHexAt(movedSecretPath(linkSecretPath)) ?? linkSecretHexAt(linkSecretPath);
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

function answerOverCap(response: http.ServerResponse, { usage, awakeHoursPerMonth, nowMs }: { usage: AwakeUsage; awakeHoursPerMonth: number | null; nowMs: number }): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const secondsUntilReset = Math.max(1, Math.ceil((Date.parse(usage.periodEndsAt) - nowMs) / 1000));
  response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(secondsUntilReset) });
  response.end(`This Glimmervoid host has used its ${awakeHoursPerMonth} awake hours for this month. It can wake again at ${usage.periodEndsAt}.\n`);
}

function hostPage({ heading, lines, refreshSeconds }: { heading: string; lines: string[]; refreshSeconds: number | null }): string {
  const refresh = refreshSeconds === null ? '' : `<meta http-equiv="refresh" content="${refreshSeconds}">`;
  const paragraphs = lines.map((line) => `<p>${line}</p>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${heading}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#d8d4e8;background:#0d0b14}h1{font-size:1.25rem;font-weight:600}</style></head><body><h1>${heading}</h1>${paragraphs}</body></html>`;
}

function answerHostPage(response: http.ServerResponse, page: string, retryAfterSeconds: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(retryAfterSeconds), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
  response.end(page);
}

function answerWakingPage(response: http.ServerResponse): void {
  answerHostPage(response, hostPage({ heading: 'Waking your Glimmervoid', lines: ['It was asleep to save its awake hours.', 'This takes about 15 seconds and the page reloads on its own.'], refreshSeconds: Number(RETRY_AFTER_SECONDS) }), Number(RETRY_AFTER_SECONDS));
}

function answerWakeLimited(response: http.ServerResponse, { retryAfterMs, isBrowser }: { retryAfterMs: number; isBrowser: boolean }) {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  if (!isBrowser) return answerStatus(response, 503, { 'retry-after': String(retryAfterSeconds) });
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  answerHostPage(response, hostPage({ heading: 'Woken too often this hour', lines: ['This Glimmervoid host was woken from outside too many times in the last hour, so it stays asleep to save its awake hours.', `It can be woken again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`], refreshSeconds: null }), retryAfterSeconds);
}

function refuseUpgrade(socket: Duplex, status: number, extraHeaderLines = ''): void {
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n${extraHeaderLines}connection: close\r\n\r\n`);
  socket.destroy();
}

function hasRequestBody(request: http.IncomingMessage): boolean {
  return request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? 0) > 0;
}

function causeOf(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

async function createTenantWatcher(tenant: DoormanTenant, linkSecret: Buffer, { forwardFetch, probeFetch, stopHost, githubTokenFallback, mintGithubToken, awakeUsage, now, log }: { forwardFetch: typeof fetch; probeFetch: typeof fetch; stopHost: () => Promise<HostStopOutcome>; githubTokenFallback: () => string | null; mintGithubToken: () => Promise<GithubTokenAnswer | null>; awakeUsage: () => AwakeUsage | null; now: () => number; log: DoormanLog }): Promise<TenantWatcher> {
  const home = createWatcherHome({ homeDir: tenant.watcherHome, credentialKey: credentialStoreKey(linkSecret), log });
  const nudges = createNudgeSender({ serverUrl: tenant.serverUrl, signingKey: directionKey(linkSecret, 'watcher-to-server'), fetchFn: forwardFetch, now, log });
  const runner = createProbeRunner({ home, nudges, fetchFn: probeFetch, now, log, githubTokenFallback });
  const listener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), stopHost, mintGithubToken, awakeUsage, now, log });
  await runner.start();
  return {
    handle: listener.handle,
    githubTokenChanged: runner.githubTokenFallbackChanged,
    stop: () => {
      runner.stop();
      nudges.stop();
    },
  };
}

function createDoorman({ table: initialTable, hostAdapter = null, tunables = DEFAULT_TUNABLES, probeFetch = fetch, githubAppFetch = fetch, now = clock.nowMs, log = console }: {
  table: DoormanTenantTableInput;
  hostAdapter?: HostAdapter | null;
  tunables?: DoormanTunables;
  probeFetch?: typeof fetch;
  githubAppFetch?: typeof fetch;
  now?: () => number;
  log?: DoormanLog;
}) {
  const proxy = createProxyServer({ xfwd: false, changeOrigin: false });
  const entriesBySlug = new Map<string, TenantEntry>();
  const metersByWatcherHome = new Map<string, Promise<AwakeMeter>>();
  const entryByForwardedRequest = new WeakMap<http.IncomingMessage, TenantEntry>();
  proxy.on('proxyRes', (_upstreamResponse, request) => noteAnsweredFor(request));
  proxy.on('proxyReqWs', (upstreamRequest, request) => upstreamRequest.once('upgrade', () => noteAnsweredFor(request)));
  let meterTimer: NodeJS.Timeout | null = null;
  let table = DoormanTenantTable.parse(initialTable);
  let githubApp: { app: DoormanGithubApp; minter: GithubAppMinter } | null = null;

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

  function adapterFor(entry: TenantEntry): HostAdapter | null {
    return entry.tenant.host === null ? null : hostAdapter;
  }

  function noteHostWoke(entry: TenantEntry, startedBy: WakeStartedBy): void {
    entry.meter?.note('woke');
    if (startedBy === 'edge') entry.gate.edgeWakeTimesMs.push(now());
  }

  async function runWake(entry: TenantEntry, adapter: HostAdapter, startedBy: WakeStartedBy): Promise<WakeOutcome> {
    await adapter.wake(entry.tenant).then(() => noteHostWoke(entry, startedBy), (wakeError: unknown) => {
      log.warn(`[doorman] waking ${entry.tenant.slug} failed: ${errorMessage(wakeError)}`);
    });
    const isAnswering = await waitUntilAnswering(entry.tenant.serverUrl, now() + tunables.holdTimeoutMs);
    if (!isAnswering) noteHostDown(entry);
    entry.gate.state = nextForwardState(entry.gate.state, isAnswering ? 'connected' : 'holdTimedOut');
    return isAnswering ? 'answering' : 'unreachable';
  }

  function overCapUsage(entry: TenantEntry): AwakeUsage | null {
    const usage = entry.meter?.usage(entry.tenant.awakeHoursPerMonth) ?? null;
    return usage !== null && isOverCap(usage) ? usage : null;
  }

  function edgeWakeRetryAfterFor(entry: TenantEntry): number | null {
    entry.gate.edgeWakeTimesMs = recentEdgeWakeTimes(entry.gate.edgeWakeTimesMs, now());
    return edgeWakeRetryAfterMs(entry.gate.edgeWakeTimesMs, now(), tunables.maxEdgeWakesPerHour);
  }

  function wakeTenant(entry: TenantEntry, startedBy: WakeStartedBy): Promise<WakeOutcome> {
    if (entry.gate.wakePromise !== null) return entry.gate.wakePromise;
    const adapter = adapterFor(entry);
    if (adapter === null) return Promise.resolve('no-adapter');
    if (overCapUsage(entry) !== null) return Promise.resolve('over-cap');
    if (!isWakeAllowed(entry.gate.lastWakeAtMs, now(), tunables.wakeCooldownMs)) return Promise.resolve('cooling-down');
    if (startedBy === 'edge' && edgeWakeRetryAfterFor(entry) !== null) return Promise.resolve('wake-limited');
    entry.gate.state = nextForwardState(entry.gate.state, entry.gate.state === 'unreachable' ? 'cooldownPassedAndRequest' : 'connectFailed');
    entry.gate.lastWakeAtMs = now();
    const wakePromise = runWake(entry, adapter, startedBy).finally(() => {
      entry.gate.wakePromise = null;
    });
    entry.gate.wakePromise = wakePromise;
    return wakePromise;
  }

  function noteAnsweredFor(request: http.IncomingMessage): void {
    const entry = entryByForwardedRequest.get(request);
    if (entry === undefined || entry.meter === null || entry.meter.isAwake() || entry.gate.stopStartedAtMs !== null) return;
    entry.meter.note('observed-awake');
  }

  function noteHostDown(entry: TenantEntry): void {
    if (entry.meter?.isAwake()) entry.meter.note('slept');
  }

  function forwardedFor(entry: TenantEntry, request: http.IncomingMessage): void {
    entryByForwardedRequest.set(request, entry);
  }

  function stopTenantHost(entry: TenantEntry, adapter: HostAdapter): void {
    const stopStartedAtMs = now();
    if (entry.gate.stopStartedAtMs !== null && stopStartedAtMs - entry.gate.stopStartedAtMs < tunables.meterTickMs) return;
    entry.gate.stopStartedAtMs = stopStartedAtMs;
    void adapter.stop(entry.tenant)
      .then(() => {
        noteHostDown(entry);
        entry.gate.state = nextForwardState(entry.gate.state, 'hostStopped');
      }, (stopError: unknown) => log.warn(`[doorman] stopping ${entry.tenant.slug} failed: ${errorMessage(stopError)}`))
      .finally(() => {
        if (entry.gate.stopStartedAtMs === stopStartedAtMs) entry.gate.stopStartedAtMs = null;
      });
  }

  function stopHostsOverCap(): void {
    for (const entry of entriesBySlug.values()) {
      const adapter = adapterFor(entry);
      if (adapter === null || entry.meter === null || !entry.meter.isAwake() || overCapUsage(entry) === null) continue;
      log.log(`[doorman] tenant ${entry.tenant.slug} reached its awake hours for this month, stopping its host`);
      stopTenantHost(entry, adapter);
    }
  }

  async function holdUntilAwake(entry: TenantEntry): Promise<WakeOutcome | 'over-capacity'> {
    if (entry.gate.heldCount >= tunables.maxHeldPerTenant) return 'over-capacity';
    entry.gate.heldCount += 1;
    try {
      return await wakeTenant(entry, 'edge');
    } finally {
      entry.gate.heldCount -= 1;
    }
  }

  function answerNotAwake(entry: TenantEntry, outcome: Exclude<WakeOutcome, 'answering'> | 'over-capacity', request: http.IncomingMessage, response: http.ServerResponse) {
    if (outcome === 'no-adapter') return answerStatus(response, 502);
    const overCap = outcome === 'over-cap' ? overCapUsage(entry) : null;
    if (overCap !== null) return answerOverCap(response, { usage: overCap, awakeHoursPerMonth: entry.tenant.awakeHoursPerMonth, nowMs: now() });
    const isBrowser = wantsWakingPage(request.method, request.headers.accept);
    const limitedRetryAfterMs = outcome === 'wake-limited' ? edgeWakeRetryAfterFor(entry) : null;
    if (limitedRetryAfterMs !== null) return answerWakeLimited(response, { retryAfterMs: limitedRetryAfterMs, isBrowser });
    if (isBrowser) return answerWakingPage(response);
    return answerBusy(response);
  }

  function answerWhileWaking(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse, answerWakeStarted: () => void) {
    const wake = wakeTenant(entry, 'edge');
    if (entry.gate.wakePromise === wake) return answerWakeStarted();
    void wake.then((outcome) => outcome === 'answering' ? answerWakeStarted() : answerNotAwake(entry, outcome, request, response));
  }

  async function forwardAfterHold(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse, bodyless: Readable | undefined): Promise<void> {
    if (wantsWakingPage(request.method, request.headers.accept)) return answerWhileWaking(entry, request, response, () => answerWakingPage(response));
    const outcome = await holdUntilAwake(entry);
    if (outcome !== 'answering') return answerNotAwake(entry, outcome, request, response);
    if (response.destroyed) return;
    forwardedFor(entry, request);
    await proxy.web(request, response, { target: entry.tenant.serverUrl, buffer: bodyless }).catch((forwardError: unknown) => {
      log.warn(`[doorman] forwarding to ${entry.tenant.slug} failed after waking it: ${errorMessage(forwardError)}`);
      answerStatus(response, 502);
    });
  }

  async function forwardWeb(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (entry.gate.state !== 'answering') return forwardAfterHold(entry, request, response, undefined);
    forwardedFor(entry, request);
    try {
      await proxy.web(request, response, { target: entry.tenant.serverUrl });
    } catch (forwardError) {
      if (!isConnectFailure(forwardError) || response.headersSent) {
        log.warn(`[doorman] forwarding to ${entry.tenant.slug} failed: ${errorMessage(forwardError)}`);
        return answerStatus(response, 502);
      }
      if (adapterFor(entry) === null) return answerStatus(response, 502);
      noteHostDown(entry);
      const overCap = overCapUsage(entry);
      if (overCap !== null) return answerOverCap(response, { usage: overCap, awakeHoursPerMonth: entry.tenant.awakeHoursPerMonth, nowMs: now() });
      if (hasRequestBody(request)) return answerWhileWaking(entry, request, response, () => answerBusy(response));
      return forwardAfterHold(entry, request, response, Readable.from([]));
    }
  }

  async function forwardUpgrade(entry: TenantEntry, request: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    if (entry.gate.state !== 'answering') {
      const outcome = await holdUntilAwake(entry);
      if (outcome === 'no-adapter') return refuseUpgrade(socket, 502);
      const limitedRetryAfterMs = outcome === 'wake-limited' ? edgeWakeRetryAfterFor(entry) : null;
      if (limitedRetryAfterMs !== null) return refuseUpgrade(socket, 503, `retry-after: ${Math.ceil(limitedRetryAfterMs / 1000)}\r\n`);
      if (outcome !== 'answering') return refuseUpgrade(socket, 503);
    }
    forwardedFor(entry, request);
    await proxy.ws(request, socket, { target: entry.tenant.serverUrl }, head).catch((forwardError: unknown) => {
      if (isConnectFailure(forwardError) && adapterFor(entry) !== null) {
        noteHostDown(entry);
        void wakeTenant(entry, 'edge');
      }
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
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    if (!(socket instanceof net.Socket)) return refuseUpgrade(socket, 400);
    const route = routeOf(request);
    if (route.kind === 'refuse') return refuseUpgrade(socket, route.status);
    if (route.kind === 'watcher') return refuseUpgrade(socket, 404);
    const entry = entryFor(route.tenant);
    if (entry === null) return refuseUpgrade(socket, 503);
    request.headers = headersAtEdge(request.headers, table.tenantDomain !== null);
    return forwardUpgrade(entry, request, socket, head);
  }

  function scheduleGithubMint(entry: TenantEntry, delayMs: number): void {
    if (entry.github.refreshTimer !== null) clearTimeout(entry.github.refreshTimer);
    entry.github.refreshTimer = setTimeout(() => void mintGithubToken(entry), Math.min(MAX_TIMER_DELAY_MS, delayMs));
    entry.github.refreshTimer.unref();
  }

  async function runGithubMint(entry: TenantEntry, minter: GithubAppMinter, installation: NonNullable<DoormanTenant['githubInstallation']>): Promise<HeldGithubToken | null> {
    const outcome = await minter.mint(installation);
    if (isClosed || entriesBySlug.get(entry.tenant.slug) !== entry) return null;
    if (outcome.kind === 'failed') {
      entry.github.failedAttempts += 1;
      dropExpiredGithubToken(entry);
      const backoffDelayMs = mintRetryDelayMs(entry.github.failedAttempts, outcome.retryAfterMs);
      const retryDelayMs = entry.github.held === null ? backoffDelayMs : Math.min(backoffDelayMs, Math.max(0, entry.github.held.expiresAtMs - now()));
      entry.github.nextMintAllowedAtMs = now() + retryDelayMs;
      log.warn(`[doorman] tenant ${entry.tenant.slug} GitHub token mint failed (${outcome.reason}), retrying in ${Math.round(retryDelayMs / 1000)} s`);
      scheduleGithubMint(entry, retryDelayMs);
      return null;
    }
    entry.github.failedAttempts = 0;
    entry.github.nextMintAllowedAtMs = 0;
    entry.github.held = { token: outcome.token, expiresAtMs: outcome.expiresAtMs };
    scheduleGithubMint(entry, tokenRefreshDelayMs(outcome.expiresAtMs, now()));
    entry.watcher?.githubTokenChanged();
    return entry.github.held;
  }

  function dropExpiredGithubToken(entry: TenantEntry): void {
    if (entry.github.held === null || now() < entry.github.held.expiresAtMs) return;
    entry.github.held = null;
    entry.watcher?.githubTokenChanged();
  }

  function mintGithubToken(entry: TenantEntry): Promise<HeldGithubToken | null> {
    const installation = entry.tenant.githubInstallation;
    if (githubApp === null || installation === null) return Promise.resolve(null);
    dropExpiredGithubToken(entry);
    if (entry.github.mint !== null) return entry.github.mint;
    const mint = runGithubMint(entry, githubApp.minter, installation).finally(() => {
      entry.github.mint = null;
    });
    entry.github.mint = mint;
    return mint;
  }

  async function githubTokenForServer(entry: TenantEntry): Promise<GithubTokenAnswer | null> {
    if (githubApp === null || entry.tenant.githubInstallation === null) return { grant: null };
    const held = entry.github.held;
    if (held !== null && isTokenFreshForServer(held.expiresAtMs, now())) return { grant: held };
    if (now() < entry.github.nextMintAllowedAtMs) return held !== null && now() < held.expiresAtMs ? { grant: held } : null;
    const minted = await mintGithubToken(entry);
    return minted === null ? null : { grant: minted };
  }

  function forgetGithubToken(entry: TenantEntry): void {
    if (entry.github.refreshTimer !== null) clearTimeout(entry.github.refreshTimer);
    entry.github = { held: null, mint: null, refreshTimer: null, failedAttempts: 0, nextMintAllowedAtMs: 0 };
  }

  function stopWatcher(entry: TenantEntry): void {
    forgetGithubToken(entry);
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
      if (entry.gate.state !== 'answering' && adapterFor(entry) !== null) {
        const outcome = await wakeTenant(entry, 'watcher');
        if (outcome !== 'answering') throw new Error(`tenant ${entry.tenant.slug} host did not wake: ${outcome}`);
      }
      try {
        return await fetch(input, init);
      } catch (fetchError) {
        if (!isConnectFailure(causeOf(fetchError)) || await wakeTenant(entry, 'watcher') !== 'answering') throw fetchError;
        return fetch(input, init);
      }
    };
    const stopHost = async (): Promise<HostStopOutcome> => {
      const adapter = adapterFor(entry);
      if (adapter === null) return 'no-adapter';
      log.log(`[doorman] tenant ${entry.tenant.slug} asked to stop`);
      stopTenantHost(entry, adapter);
      return 'stopping';
    };
    const githubTokenFallback = () => {
      const held = entry.github.held;
      return held !== null && now() < held.expiresAtMs ? held.token : null;
    };
    await mintGithubToken(entry);
    const watcher = await createTenantWatcher(entry.tenant, Buffer.from(secretHex, 'hex'), { forwardFetch, probeFetch, stopHost, githubTokenFallback, mintGithubToken: () => githubTokenForServer(entry), awakeUsage: () => entry.meter?.usage(entry.tenant.awakeHoursPerMonth) ?? null, now, log }).catch((startError: unknown) => {
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

  function adoptGithubApp(nextApp: DoormanGithubApp | null): void {
    if (JSON.stringify(nextApp) === JSON.stringify(githubApp?.app ?? null)) return;
    githubApp = nextApp === null ? null : { app: nextApp, minter: createGithubAppMinter({ app: nextApp, fetchFn: githubAppFetch, now }) };
    for (const entry of entriesBySlug.values()) {
      forgetGithubToken(entry);
      entry.watcher?.githubTokenChanged();
      if (entry.watcher !== null) void mintGithubToken(entry);
    }
  }

  function meterFor(tenant: DoormanTenant): Promise<AwakeMeter | null> {
    if (hostAdapter === null || tenant.host === null) return Promise.resolve(null);
    const existing = metersByWatcherHome.get(tenant.watcherHome);
    if (existing !== undefined) return existing;
    const meter = createAwakeMeter({ watcherHome: tenant.watcherHome, now, log });
    metersByWatcherHome.set(tenant.watcherHome, meter);
    return meter;
  }

  async function applyTableNow(nextTable: DoormanTenantTable): Promise<void> {
    table = nextTable;
    adoptGithubApp(nextTable.githubApp);
    const nextTenantsBySlug = new Map(nextTable.tenants.map((tenant) => [tenant.slug, tenant]));
    for (const [slug, entry] of entriesBySlug) {
      const nextTenant = nextTenantsBySlug.get(slug);
      if (nextTenant !== undefined && JSON.stringify(nextTenant) === JSON.stringify(entry.tenant)) continue;
      stopWatcher(entry);
      entriesBySlug.delete(slug);
    }
    for (const tenant of nextTable.tenants) {
      if (entriesBySlug.has(tenant.slug)) continue;
      const meter = await meterFor(tenant);
      const gate: TenantGate = { state: meter !== null && !meter.isAwake() ? 'unreachable' : 'answering', heldCount: 0, wakePromise: null, lastWakeAtMs: null, edgeWakeTimesMs: [], stopStartedAtMs: null };
      entriesBySlug.set(tenant.slug, { tenant, gate, meter, watcher: null, watcherSecretHex: null, watcherStart: null, github: { held: null, mint: null, refreshTimer: null, failedAttempts: 0, nextMintAllowedAtMs: 0 } });
    }
    await Promise.all([...entriesBySlug.values()].map(refreshWatcher));
  }

  let tableUpdates: Promise<void> = Promise.resolve();
  let isClosed = false;
  const upgradedSockets = new Set<Duplex>();

  function applyTable(nextTable: DoormanTenantTableInput): Promise<void> {
    const update = tableUpdates.then(() => applyTableNow(DoormanTenantTable.parse(nextTable)));
    tableUpdates = update.catch(() => {});
    return update;
  }

  const server = http.createServer((request, response) => void handleRequest(request, response));
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void handleUpgrade(request, socket, head));

  async function listen(port: number): Promise<number> {
    await applyTable(table);
    if (hostAdapter !== null && meterTimer === null) meterTimer = setInterval(stopHostsOverCap, tunables.meterTickMs);
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
    if (meterTimer !== null) clearInterval(meterTimer);
    meterTimer = null;
    for (const entry of entriesBySlug.values()) stopWatcher(entry);
    entriesBySlug.clear();
    server.closeAllConnections();
    for (const upgradedSocket of upgradedSockets) upgradedSocket.destroy();
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

function untilStopped(tableGone: Promise<void>): Promise<void> {
  return Promise.race([tableGone, new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  })]);
}

function holdStateLock(stateDir: string): number | 'held-elsewhere' | 'unlockable' {
  const locks = loadFileLocks();
  if (locks === null) return 'unlockable';
  const lockDescriptor = fs.openSync(path.join(stateDir, DOORMAN_LOCK_FILE_NAME), 'a');
  if (locks.tryLock(lockDescriptor)) return lockDescriptor;
  fs.closeSync(lockDescriptor);
  return 'held-elsewhere';
}

async function publishBoundPort(portPath: string, boundPort: number): Promise<void> {
  const stagingPath = `${portPath}.${process.pid}`;
  await fsp.writeFile(stagingPath, `${boundPort}\n`);
  await fsp.rename(stagingPath, portPath);
}

async function withdrawBoundPort(portPath: string, boundPort: number): Promise<void> {
  const publishedText = await fsp.readFile(portPath, 'utf8').catch(() => '');
  if (publishedText.trim() !== String(boundPort)) return;
  await fsp.rm(portPath, { force: true });
}

async function runDoormanCli({ tablePath, rawPort }: { tablePath: string | null; rawPort: string | null }): Promise<number> {
  stampProcessOutputLines();
  if (tablePath === null) return refuse('--tenants must name the tenant table file');
  const port = portFromOption(rawPort);
  if (port === null) return refuse('--port must be a port from 0 to 65535');
  const table = await readTenantTable(tablePath).catch((readError: unknown) => new Error(errorMessage(readError)));
  if (table instanceof Error) return refuse(`${tablePath} is not a tenant table: ${table.message}`);
  const stateDir = path.dirname(path.resolve(tablePath));
  const stateLock = holdStateLock(stateDir);
  if (stateLock === 'held-elsewhere') {
    console.log(`[doorman] another doorman already serves ${tablePath}`);
    return 0;
  }
  if (stateLock === 'unlockable') console.warn('[doorman] file locks are unavailable, so a second doorman for this table is not refused');
  const doorman = createDoorman({ table, hostAdapter: createGcpHostAdapter({ settleTimeoutMs: DEFAULT_TUNABLES.holdTimeoutMs / 2 }) });
  const boundPort = await doorman.listen(port);
  const portPath = path.join(stateDir, DOORMAN_PORT_FILE_NAME);
  await publishBoundPort(portPath, boundPort);
  console.log(`[doorman] listening on ${LOOPBACK_HOST}:${boundPort} for ${table.tenants.length} tenant(s)`);
  let markTableGone: () => void = () => {};
  const tableGone = new Promise<void>((resolve) => {
    markTableGone = resolve;
  });
  const reload = () => {
    readTenantTable(tablePath).then(doorman.applyTable, (reloadError: unknown) => {
      if (isMissingFileError(reloadError)) {
        console.log(`[doorman] ${tablePath} is gone, stopping`);
        markTableGone();
        return;
      }
      console.warn(`[doorman] kept the previous tenant table: ${errorMessage(reloadError)}`);
    });
  };
  const stopWatching = watchTenantTable(tablePath, reload);
  process.on('SIGHUP', reload);
  await untilStopped(tableGone);
  stopWatching();
  process.off('SIGHUP', reload);
  await doorman.close();
  await withdrawBoundPort(portPath, boundPort);
  return 0;
}

export { createDoorman, runDoormanCli };
export type { HostAdapter };
