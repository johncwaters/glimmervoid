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
import type { WatcherFiles } from '../watcher/watcher-home.ts';
import { createWatcherListener } from '../watcher/watcher-listener.ts';
import type { GithubConnectionControl } from '../watcher/watcher-listener.ts';
import { DOORMAN_LOCK_FILE_NAME, DOORMAN_PORT_FILE_NAME, DoormanTenantTable } from '../../shared/contracts/doorman.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { loadFileLocks } from '../../server/session-temp/session-temp-locks.ts';
import { stampProcessOutputLines } from '../../server/log-stamp.ts';
import type { DoormanGithubApp, DoormanTenant, DoormanTenantTableInput, WakeStartedBy } from '../../shared/contracts/doorman.ts';
import type { AwakeUsage, GithubTokenAnswer, GithubTokenGrant, GithubUserGrant, HostStopOutcome } from '../../shared/contracts/watcher-link.ts';
import { createAwakeMeter } from './awake-meter.ts';
import type { AwakeMeter } from './awake-meter.ts';
import { edgeWakeRetryAfterMs, headersAtEdge, isConnectFailure, isOverCap, isTokenFreshForServer, isWakeAllowed, mintRetryDelayMs, nextForwardState, routeRequest, tokenRefreshDelayMs, wakePageState, wantsWakingPage } from './doorman-core.ts';
import { createGcpHostAdapter } from './gcp-host.ts';
import type { HostAdapter } from './gcp-host.ts';
import { createGithubAppMinter } from './github-app.ts';
import type { GithubAppMinter } from './github-app.ts';
import { createGithubUserLink } from './github-user.ts';
import type { GithubUserLink } from './github-user.ts';
import { createFileTenantRecordStore } from './tenant-record-store.ts';
import type { TenantRecordStore } from './tenant-record-store.ts';
import type { GithubInstallationBinding } from '../../shared/contracts/github-connection.ts';
import type { DoormanRoute, ForwardState, WakePageState } from './doorman-core.ts';
import { HOST_PAGE_CONTENT_SECURITY_POLICY, WAKE_POLL_HEADER, wakeLimitedPage, wakingPage } from './host-page.ts';
import { createFileDoormanState, createFileTenantState, createGcsDoormanState, stateBucketOf } from './doorman-state.ts';
import type { DoormanState, DoormanTenantState } from './doorman-state.ts';
import { clock } from '../../shared/clock.ts';

type DoormanTunables = { holdTimeoutMs: number; wakeCooldownMs: number; maxHeldPerTenant: number; readinessPollMs: number; meterTickMs: number; maxEdgeWakesPerHour: number };
type WakeOutcome = 'answering' | 'no-adapter' | 'unmetered' | 'cooling-down' | 'unreachable' | 'over-cap' | 'wake-limited';
type TenantGate = { state: ForwardState; heldCount: number; wakePromise: Promise<WakeOutcome> | null; lastWakeAtMs: number | null; didLastWakeFail: boolean; stopStartedAtMs: number | null };
type TenantWatcher = { handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void>; githubTokenChanged(): void; stop(): void };
type HeldGithubToken = { installationId: number; accountLogin: string; token: string; expiresAtMs: number };
type TenantGithubToken = { held: readonly HeldGithubToken[]; mint: Promise<readonly HeldGithubToken[] | null> | null; refreshTimer: NodeJS.Timeout | null; failedAttempts: number; nextMintAllowedAtMs: number };
type TenantEntry = { tenant: DoormanTenant; gate: TenantGate; meter: AwakeMeter | null; watcher: TenantWatcher | null; watcherSecretHex: string | null; watcherStart: Promise<TenantWatcher | null> | null; watcherRetryTimer: NodeJS.Timeout | null; failedWatcherStarts: number; github: TenantGithubToken; githubUser: GithubUserLink | null };
type DoormanLog = Pick<Console, 'log' | 'warn'>;

const DEFAULT_TUNABLES: DoormanTunables = Object.freeze({ holdTimeoutMs: 60_000, wakeCooldownMs: 30_000, maxHeldPerTenant: 64, readinessPollMs: 500, meterTickMs: 60_000, maxEdgeWakesPerHour: 4 });
const READINESS_ATTEMPT_TIMEOUT_MS = 2000;
const RETRY_AFTER_SECONDS = '5';
const LOOPBACK_HOST = '127.0.0.1';
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

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

function answerHostPage(response: http.ServerResponse, page: string, retryAfterSeconds: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(retryAfterSeconds), 'content-security-policy': HOST_PAGE_CONTENT_SECURITY_POLICY });
  response.end(page);
}

function answerWakingPage(response: http.ServerResponse, state: WakePageState): void {
  answerHostPage(response, wakingPage(state, Number(RETRY_AFTER_SECONDS)), Number(RETRY_AFTER_SECONDS));
}

function answerAwakeToWakePoll(response: http.ServerResponse): void {
  response.writeHead(204, { 'cache-control': 'no-store' });
  response.end();
}

function answerWakeLimited(response: http.ServerResponse, { retryAfterMs, isBrowser }: { retryAfterMs: number; isBrowser: boolean }) {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
  if (!isBrowser) return answerStatus(response, 503, { 'retry-after': String(retryAfterSeconds) });
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  answerHostPage(response, wakeLimitedPage(minutes), retryAfterSeconds);
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

async function createTenantWatcher(tenant: DoormanTenant, watcherFiles: WatcherFiles, linkSecret: Buffer, { forwardFetch, probeFetch, stopHost, githubTokenFallback, mintGithubToken, githubConnection, awakeUsage, now, log }: { forwardFetch: typeof fetch; probeFetch: typeof fetch; stopHost: () => Promise<HostStopOutcome>; githubTokenFallback: () => readonly { accountLogin: string; token: string }[]; mintGithubToken: () => Promise<GithubTokenAnswer | null>; githubConnection: () => GithubConnectionControl; awakeUsage: () => AwakeUsage | null; now: () => number; log: DoormanLog }): Promise<TenantWatcher> {
  const home = createWatcherHome({ files: watcherFiles, credentialKey: credentialStoreKey(linkSecret), log });
  const nudges = createNudgeSender({ serverUrl: tenant.serverUrl, signingKey: directionKey(linkSecret, 'watcher-to-server'), fetchFn: forwardFetch, now, log });
  const runner = createProbeRunner({ home, nudges, fetchFn: probeFetch, now, log, githubTokenFallback });
  const listener = createWatcherListener({ runner, signingKey: directionKey(linkSecret, 'server-to-watcher'), stopHost, mintGithubToken, githubConnection, awakeUsage, now, log });
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

function createDoorman({ table: initialTable, tenantState = createFileTenantState(), hostAdapter = null, tunables = DEFAULT_TUNABLES, probeFetch = fetch, githubAppFetch = fetch, recordStore = null, now = clock.nowMs, log = console }: {
  table: DoormanTenantTableInput;
  tenantState?: DoormanTenantState;
  recordStore?: TenantRecordStore | null;
  hostAdapter?: HostAdapter | null;
  tunables?: DoormanTunables;
  probeFetch?: typeof fetch;
  githubAppFetch?: typeof fetch;
  now?: () => number;
  log?: DoormanLog;
}) {
  const proxy = createProxyServer({ xfwd: false, changeOrigin: false });
  const entriesBySlug = new Map<string, TenantEntry>();
  const metersByLedger = new Map<string, Promise<AwakeMeter | null>>();
  const entryByForwardedRequest = new WeakMap<http.IncomingMessage, TenantEntry>();
  proxy.on('proxyRes', (_upstreamResponse, request) => noteAnsweredFor(request));
  proxy.on('proxyReqWs', (upstreamRequest, request) => upstreamRequest.once('upgrade', () => noteAnsweredFor(request)));
  let meterTimer: NodeJS.Timeout | null = null;
  let table = DoormanTenantTable.parse(initialTable);
  let githubApp: { app: DoormanGithubApp; minter: GithubAppMinter | null } | null = null;
  const watcherHomesBySlug = new Map<string, string | null>();
  const records = recordStore ?? createFileTenantRecordStore({ watcherHomeFor: (slug) => watcherHomesBySlug.get(slug) ?? null });

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
    entry.meter?.note('woke', startedBy);
  }

  async function runWake(entry: TenantEntry, adapter: HostAdapter, startedBy: WakeStartedBy): Promise<WakeOutcome> {
    await adapter.wake(entry.tenant).then(() => noteHostWoke(entry, startedBy), (wakeError: unknown) => {
      log.warn(`[doorman] waking ${entry.tenant.slug} failed: ${errorMessage(wakeError)}`);
    });
    const isAnswering = await waitUntilAnswering(entry.tenant.serverUrl, now() + tunables.holdTimeoutMs);
    if (!isAnswering) noteHostDown(entry);
    entry.gate.didLastWakeFail = !isAnswering;
    entry.gate.state = nextForwardState(entry.gate.state, isAnswering ? 'connected' : 'holdTimedOut');
    return isAnswering ? 'answering' : 'unreachable';
  }

  function wakePageStateOf(entry: TenantEntry): WakePageState {
    return wakePageState({ isWakeInFlight: entry.gate.wakePromise !== null, didLastWakeFail: entry.gate.didLastWakeFail, lastWakeAtMs: entry.gate.lastWakeAtMs, nowMs: now(), wakeCooldownMs: tunables.wakeCooldownMs });
  }

  function overCapUsage(entry: TenantEntry): AwakeUsage | null {
    const usage = entry.meter?.usage(entry.tenant.awakeHoursPerMonth) ?? null;
    return usage !== null && isOverCap(usage) ? usage : null;
  }

  function edgeWakeRetryAfterFor(entry: TenantEntry): number | null {
    return edgeWakeRetryAfterMs(entry.meter?.recentEdgeWakeTimesMs() ?? [], now(), tunables.maxEdgeWakesPerHour);
  }

  function wakeTenant(entry: TenantEntry, startedBy: WakeStartedBy): Promise<WakeOutcome> {
    if (entry.gate.wakePromise !== null) return entry.gate.wakePromise;
    const adapter = adapterFor(entry);
    if (adapter === null) return Promise.resolve('no-adapter');
    if (entry.meter === null) return Promise.resolve('unmetered');
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

  function attachUnreadMeters(): void {
    for (const entry of entriesBySlug.values()) {
      if (adapterFor(entry) === null || entry.meter !== null) continue;
      void meterFor(entry.tenant).then((meter) => {
        if (meter === null || entriesBySlug.get(entry.tenant.slug) !== entry) return;
        entry.meter = meter;
        entry.gate.lastWakeAtMs = entry.gate.lastWakeAtMs ?? meter.lastWokeAtMs();
      });
    }
  }

  function runMeterTick(): void {
    attachUnreadMeters();
    stopHostsOverCap();
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
    if (isBrowser) return answerWakingPage(response, wakePageStateOf(entry));
    return answerBusy(response);
  }

  function answerWhileWaking(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse, answerWakeStarted: () => void) {
    const wake = wakeTenant(entry, 'edge');
    if (entry.gate.wakePromise === wake) return answerWakeStarted();
    void wake.then((outcome) => outcome === 'answering' ? answerWakeStarted() : answerNotAwake(entry, outcome, request, response));
  }

  async function forwardAfterHold(entry: TenantEntry, request: http.IncomingMessage, response: http.ServerResponse, bodyless: Readable | undefined): Promise<void> {
    if (wantsWakingPage(request.method, request.headers.accept)) return answerWhileWaking(entry, request, response, () => answerWakingPage(response, wakePageStateOf(entry)));
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
    if (request.headers[WAKE_POLL_HEADER] !== undefined) return answerAwakeToWakePoll(response);
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
    entry.github.refreshTimer = setTimeout(() => void mintGithubTokens(entry), Math.min(MAX_TIMER_DELAY_MS, delayMs));
    entry.github.refreshTimer.unref();
  }

  function unexpiredGithubTokens(entry: TenantEntry): readonly HeldGithubToken[] {
    return entry.github.held.filter((held) => now() < held.expiresAtMs);
  }

  function serverGrantsOf(heldTokens: readonly HeldGithubToken[]): readonly GithubTokenGrant[] {
    return heldTokens.map(({ accountLogin, token, expiresAtMs }): GithubTokenGrant => ({ accountLogin, token, expiresAtMs }));
  }

  async function runGithubMints(entry: TenantEntry, minter: GithubAppMinter, installations: readonly GithubInstallationBinding[]): Promise<readonly HeldGithubToken[] | null> {
    const outcomes = await Promise.all(installations.map(async (installation) => ({ installation, outcome: await minter.mint(installation) })));
    if (isClosed || entriesBySlug.get(entry.tenant.slug) !== entry) return null;
    const minted = outcomes.flatMap(({ installation, outcome }) => outcome.kind === 'minted' ? [{ installationId: installation.installationId, accountLogin: installation.accountLogin, token: outcome.token, expiresAtMs: outcome.expiresAtMs }] : []);
    const failures = outcomes.flatMap(({ installation, outcome }) => outcome.kind === 'failed' ? [{ installationId: installation.installationId, reason: outcome.reason, retryAfterMs: outcome.retryAfterMs }] : []);
    const failedInstallationIds = new Set(failures.map((failure) => failure.installationId));
    const carried = unexpiredGithubTokens(entry).filter((held) => failedInstallationIds.has(held.installationId));
    entry.github.held = [...minted, ...carried];
    entry.watcher?.githubTokenChanged();
    if (failures.length === 0) {
      entry.github.failedAttempts = 0;
      entry.github.nextMintAllowedAtMs = 0;
      if (minted.length > 0) scheduleGithubMint(entry, tokenRefreshDelayMs(Math.min(...minted.map((held) => held.expiresAtMs)), now()));
      return entry.github.held;
    }
    entry.github.failedAttempts += 1;
    const retryAfterMs = Math.max(0, ...failures.map((failure) => failure.retryAfterMs ?? 0));
    const backoffDelayMs = mintRetryDelayMs(entry.github.failedAttempts, retryAfterMs === 0 ? null : retryAfterMs);
    const retryDelayMs = Math.min(backoffDelayMs, ...entry.github.held.map((held) => Math.max(0, held.expiresAtMs - now())));
    entry.github.nextMintAllowedAtMs = now() + retryDelayMs;
    const reasons = [...new Set(failures.map((failure) => failure.reason))].join('; ');
    log.warn(`[doorman] tenant ${entry.tenant.slug} GitHub token mint failed for ${failures.length} of ${installations.length} installations (${reasons}), retrying in ${Math.round(retryDelayMs / 1000)} s`);
    scheduleGithubMint(entry, retryDelayMs);
    return entry.github.held;
  }

  function dropExpiredGithubTokens(entry: TenantEntry): void {
    const unexpired = unexpiredGithubTokens(entry);
    if (unexpired.length === entry.github.held.length) return;
    entry.github.held = unexpired;
    entry.watcher?.githubTokenChanged();
  }

  async function boundInstallationsFor(entry: TenantEntry): Promise<readonly GithubInstallationBinding[] | 'unreadable'> {
    if (entry.githubUser === null) return [];
    return entry.githubUser.bindings().catch((bindingError: unknown) => {
      log.warn(`[doorman] tenant ${entry.tenant.slug} could not read its GitHub installations: ${errorMessage(bindingError)}`);
      return 'unreadable' as const;
    });
  }

  function backOffUnreadableBindings(entry: TenantEntry): null {
    if (isClosed || entriesBySlug.get(entry.tenant.slug) !== entry) return null;
    entry.github.failedAttempts += 1;
    dropExpiredGithubTokens(entry);
    const retryDelayMs = mintRetryDelayMs(entry.github.failedAttempts, null);
    entry.github.nextMintAllowedAtMs = now() + retryDelayMs;
    scheduleGithubMint(entry, retryDelayMs);
    return null;
  }

  async function mintForBindings(entry: TenantEntry): Promise<readonly HeldGithubToken[] | null> {
    const minter = githubApp?.minter ?? null;
    const installations = await boundInstallationsFor(entry);
    if (installations === 'unreadable') return backOffUnreadableBindings(entry);
    if (minter === null || installations.length === 0) return [];
    return runGithubMints(entry, minter, installations);
  }

  function mintGithubTokens(entry: TenantEntry): Promise<readonly HeldGithubToken[] | null> {
    if (githubApp?.minter == null || entry.githubUser === null) return Promise.resolve([]);
    dropExpiredGithubTokens(entry);
    if (entry.github.mint !== null) return entry.github.mint;
    const mint = mintForBindings(entry).finally(() => {
      entry.github.mint = null;
    });
    entry.github.mint = mint;
    return mint;
  }

  function isEveryBindingFreshlyHeld(entry: TenantEntry, installations: readonly GithubInstallationBinding[]): boolean {
    const freshInstallationIds = new Set(entry.github.held.filter((held) => isTokenFreshForServer(held.expiresAtMs, now())).map((held) => held.installationId));
    return installations.every((installation) => freshInstallationIds.has(installation.installationId));
  }

  async function githubTokensForServer(entry: TenantEntry): Promise<GithubTokenAnswer | null> {
    const grants = await githubAppGrantsForServer(entry);
    if (grants === null) return null;
    return { grants: [...grants], user: await githubUserGrantOf(entry) };
  }

  async function githubUserGrantOf(entry: TenantEntry): Promise<GithubUserGrant | null> {
    if (entry.githubUser === null) return null;
    return entry.githubUser.userAccessGrant().catch((refreshError: unknown) => {
      log.warn(`[doorman] tenant ${entry.tenant.slug} could not refresh its GitHub user token: ${errorMessage(refreshError)}`);
      return null;
    });
  }

  async function githubAppGrantsForServer(entry: TenantEntry): Promise<readonly GithubTokenGrant[] | null> {
    if (githubApp?.minter == null || entry.githubUser === null) return [];
    const installations = await boundInstallationsFor(entry);
    if (installations === 'unreadable') return null;
    if (installations.length === 0) return [];
    if (isEveryBindingFreshlyHeld(entry, installations)) return serverGrantsOf(entry.github.held);
    if (now() < entry.github.nextMintAllowedAtMs) {
      const unexpired = unexpiredGithubTokens(entry);
      return unexpired.length > 0 ? serverGrantsOf(unexpired) : null;
    }
    const minted = await mintGithubTokens(entry);
    return minted === null || minted.length === 0 ? null : serverGrantsOf(minted);
  }

  function forgetGithubToken(entry: TenantEntry): void {
    if (entry.github.refreshTimer !== null) clearTimeout(entry.github.refreshTimer);
    entry.github = { held: [], mint: null, refreshTimer: null, failedAttempts: 0, nextMintAllowedAtMs: 0 };
  }

  function rebindGithub(entry: TenantEntry): void {
    forgetGithubToken(entry);
    entry.watcher?.githubTokenChanged();
    if (entry.watcher !== null) void mintGithubTokens(entry);
  }

  function stopWatcher(entry: TenantEntry): void {
    if (entry.watcherRetryTimer !== null) clearTimeout(entry.watcherRetryTimer);
    entry.watcherRetryTimer = null;
    forgetGithubToken(entry);
    entry.githubUser?.stop();
    entry.githubUser = null;
    entry.watcher?.stop();
    entry.watcher = null;
    entry.watcherSecretHex = null;
  }

  function retryWatcherLater(entry: TenantEntry): void {
    if (isClosed || entry.watcherRetryTimer !== null || entriesBySlug.get(entry.tenant.slug) !== entry) return;
    const delayMs = mintRetryDelayMs(entry.failedWatcherStarts, null);
    entry.failedWatcherStarts += 1;
    entry.watcherRetryTimer = setTimeout(() => {
      entry.watcherRetryTimer = null;
      void ensureWatcher(entry);
    }, delayMs);
  }

  async function startWatcher(entry: TenantEntry): Promise<TenantWatcher | null> {
    const secretHex = await tenantState.linkSecretHex(entry.tenant).catch((readError: unknown) => {
      log.warn(`[doorman] reading the link secret of ${entry.tenant.slug} failed, retrying: ${errorMessage(readError)}`);
      return undefined;
    });
    if (secretHex === undefined) {
      retryWatcherLater(entry);
      return null;
    }
    if (secretHex === null) {
      log.warn(`[doorman] tenant ${entry.tenant.slug} has no link secret yet`);
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
    const githubTokenFallback = () => unexpiredGithubTokens(entry).map(({ accountLogin, token }) => ({ accountLogin, token }));
    const linkSecret = Buffer.from(secretHex, 'hex');
    entry.githubUser?.stop();
    entry.githubUser = createGithubUserLink({ slug: entry.tenant.slug, app: () => githubApp?.app ?? null, store: records, sealKey: credentialStoreKey(linkSecret), fetchFn: githubAppFetch, now, log, onChange: () => rebindGithub(entry) });
    const githubUser = entry.githubUser;
    await mintGithubTokens(entry);
    const watcher = await createTenantWatcher(entry.tenant, tenantState.watcherFilesOf(entry.tenant), linkSecret, { forwardFetch, probeFetch, stopHost, githubTokenFallback, mintGithubToken: () => githubTokensForServer(entry), githubConnection: () => githubUser, awakeUsage: () => entry.meter?.usage(entry.tenant.awakeHoursPerMonth) ?? null, now, log }).catch((startError: unknown) => {
      log.warn(`[doorman] tenant ${entry.tenant.slug} watcher did not start: ${errorMessage(startError)}`);
      return null;
    });
    if (watcher === null) {
      retryWatcherLater(entry);
      return null;
    }
    if (isClosed || entriesBySlug.get(entry.tenant.slug) !== entry) {
      watcher.stop();
      return null;
    }
    entry.watcher = watcher;
    entry.watcherSecretHex = secretHex;
    entry.failedWatcherStarts = 0;
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
    if (entry.watcher !== null && await tenantState.linkSecretHex(entry.tenant).catch(() => entry.watcherSecretHex) === entry.watcherSecretHex) return;
    stopWatcher(entry);
    await ensureWatcher(entry);
  }

  function adoptGithubApp(nextApp: DoormanGithubApp | null): void {
    if (JSON.stringify(nextApp) === JSON.stringify(githubApp?.app ?? null)) return;
    githubApp = nextApp === null ? null : { app: nextApp, minter: nextApp.privateKeySecret === null ? null : createGithubAppMinter({ app: nextApp, privateKeySecret: nextApp.privateKeySecret, fetchFn: githubAppFetch, now }) };
    for (const entry of entriesBySlug.values()) rebindGithub(entry);
  }

  function meterFor(tenant: DoormanTenant): Promise<AwakeMeter | null> {
    if (hostAdapter === null || tenant.host === null) return Promise.resolve(null);
    const ledger = tenantState.ledgerOf(tenant);
    const existing = metersByLedger.get(ledger.identity);
    if (existing !== undefined) return existing;
    const meter = createAwakeMeter({ ledger, now, log }).catch((readError: unknown) => {
      metersByLedger.delete(ledger.identity);
      log.warn(`[doorman] the awake ledger of ${tenant.slug} could not be read yet, so its host is not woken until it can be: ${errorMessage(readError)}`);
      return null;
    });
    metersByLedger.set(ledger.identity, meter);
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
      const gate: TenantGate = { state: meter !== null && !meter.isAwake() ? 'unreachable' : 'answering', heldCount: 0, wakePromise: null, lastWakeAtMs: meter?.lastWokeAtMs() ?? null, didLastWakeFail: false, stopStartedAtMs: null };
      watcherHomesBySlug.set(tenant.slug, tenant.watcherHome);
      entriesBySlug.set(tenant.slug, { tenant, gate, meter, watcher: null, watcherSecretHex: null, watcherStart: null, watcherRetryTimer: null, failedWatcherStarts: 0, github: { held: [], mint: null, refreshTimer: null, failedAttempts: 0, nextMintAllowedAtMs: 0 }, githubUser: null });
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
    if (hostAdapter !== null && meterTimer === null) meterTimer = setInterval(runMeterTick, tunables.meterTickMs);
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

function doormanStateFrom({ tablePath, stateUrl }: { tablePath: string | null; stateUrl: string | null }): DoormanState | string {
  if (tablePath !== null && stateUrl !== null) return '--tenants and --state each name a tenant table; give only one';
  if (tablePath !== null) return createFileDoormanState({ tablePath });
  if (stateUrl === null) return '--tenants must name the tenant table file, or --state the gs:// state bucket';
  const bucket = stateBucketOf(stateUrl);
  if (bucket === null) return '--state must name a bucket as gs://<bucket>';
  return createGcsDoormanState({ bucket });
}

function holdLockIn(lockFolder: string | null, where: string): 'held' | 'held-elsewhere' {
  if (lockFolder === null) return 'held';
  const stateLock = holdStateLock(lockFolder);
  if (stateLock === 'held-elsewhere') return 'held-elsewhere';
  if (stateLock === 'unlockable') console.warn(`[doorman] file locks are unavailable, so a second doorman for ${where} is not refused`);
  return 'held';
}

async function runDoormanCli({ tablePath, stateUrl, rawPort }: { tablePath: string | null; stateUrl: string | null; rawPort: string | null }): Promise<number> {
  stampProcessOutputLines();
  const state = doormanStateFrom({ tablePath, stateUrl });
  if (typeof state === 'string') return refuse(state);
  const port = portFromOption(rawPort);
  if (port === null) return refuse('--port must be a port from 0 to 65535');
  const table = await state.readTable().catch((readError: unknown) => new Error(errorMessage(readError)));
  if (table instanceof Error) return refuse(`${state.where} is not a tenant table: ${table.message}`);
  if (holdLockIn(state.lockFolder, state.where) === 'held-elsewhere') {
    console.log(`[doorman] another doorman already serves ${state.where}`);
    return 0;
  }
  const doorman = createDoorman({ table, tenantState: state.tenantState, recordStore: state.tenantRecords, hostAdapter: createGcpHostAdapter({ settleTimeoutMs: DEFAULT_TUNABLES.holdTimeoutMs / 2 }) });
  const boundPort = await doorman.listen(port);
  const portPath = state.lockFolder === null ? null : path.join(state.lockFolder, DOORMAN_PORT_FILE_NAME);
  if (portPath !== null) await publishBoundPort(portPath, boundPort);
  console.log(`[doorman] listening on ${LOOPBACK_HOST}:${boundPort} for ${table.tenants.length} tenant(s) from ${state.where}`);
  let markTableGone: () => void = () => {};
  const tableGone = new Promise<void>((resolve) => {
    markTableGone = resolve;
  });
  const reload = () => {
    state.readTable().then(doorman.applyTable, (reloadError: unknown) => {
      if (isMissingFileError(reloadError)) {
        console.log(`[doorman] ${state.where} is gone, stopping`);
        markTableGone();
        return;
      }
      console.warn(`[doorman] kept the previous tenant table: ${errorMessage(reloadError)}`);
    });
  };
  const stopWatching = state.watchTable(reload);
  process.on('SIGHUP', reload);
  await untilStopped(tableGone);
  stopWatching();
  process.off('SIGHUP', reload);
  await doorman.close();
  if (portPath !== null) await withdrawBoundPort(portPath, boundPort);
  return 0;
}

export { createDoorman, runDoormanCli };
export type { HostAdapter };
