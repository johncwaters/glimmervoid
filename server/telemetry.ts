import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { ClientErrorReport } from '../shared/contracts/control-messages.ts';
import { PendingCrashReport, TELEMETRY_EVENT_SCHEMAS, TelemetryState } from '../shared/contracts/telemetry.ts';
import type { ExceptionProperties, TelemetryEventName, TelemetryEventProperties } from '../shared/contracts/telemetry.ts';
import {
  TELEMETRY_BATCH_URL, buildBrowserExceptionProperties, buildExceptionProperties, decideTelemetryConsent,
  exceptionFingerprint, nodeMajorVersion, resolveProjectToken,
} from './core/telemetry-core.ts';
import type { TelemetryConfig, TelemetryEnvironment } from './core/telemetry-core.ts';
import { createJsonStateStore, writeJsonAtomicSync } from './json-file.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';

const MAX_QUEUED_EVENTS = 500;
const FLUSH_AT_EVENT_COUNT = 20;
const FLUSH_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 5000;
const STOP_SEND_TIMEOUT_MS = 2500;
const ACTIVE_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTED_EXCEPTION_FINGERPRINTS = 256;
const CRASH_MONITOR_EVENT = 'uncaughtExceptionMonitor';

interface QueuedEvent {
  event: TelemetryEventName;
  timestamp: string;
  properties: Record<string, unknown>;
}

interface CrashEventSource {
  on(event: typeof CRASH_MONITOR_EVENT, listener: (error: unknown) => void): unknown;
  off(event: typeof CRASH_MONITOR_EVENT, listener: (error: unknown) => void): unknown;
}

interface TelemetryOptions {
  config: TelemetryConfig;
  env: TelemetryEnvironment;
  fetchFn?: typeof fetch;
  stateFilePath: string | null;
  pendingCrashFilePath?: string | null;
  packageRoot: string;
  version: string;
  installFlavor: string;
  isBundled: boolean;
  platform?: string;
  nodeVersion?: string;
  getActiveSessionCount?: () => number;
  logger?: LaneLogger | null;
  now?: () => Date;
}

interface Telemetry {
  capture<EventName extends TelemetryEventName>(event: EventName, properties: TelemetryEventProperties<EventName>): void;
  captureException(error: unknown, options: { handled: boolean }): void;
  captureClientError(report: ClientErrorReport): void;
  recordFatalCrash(error: unknown): void;
  watchForCrashes(source?: CrashEventSource): void;
  sendPendingCrash(): Promise<void>;
  flush(): Promise<void>;
  stop(): Promise<void>;
  consumeFirstRunNotice(): Promise<boolean>;
  applyConfig(): void;
  isEnabled(): boolean;
}

function createTelemetry(options: TelemetryOptions): Telemetry {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const log = createLaneLog({ prefix: '[telemetry]', logger: options.logger });
  const baseProperties = {
    app_version: options.version,
    os_platform: options.platform ?? process.platform,
    node_major: nodeMajorVersion(options.nodeVersion ?? process.versions.node),
    install_flavor: options.installFlavor,
    is_bundled: options.isBundled,
    $lib: 'glimmervoid',
    $process_person_profile: false,
  };
  let queue: QueuedEvent[] = [];
  let state: TelemetryState | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let inFlightFlush: Promise<void> | null = null;
  let isStopped = false;
  let crashEventSource: CrashEventSource | null = null;
  const reportedExceptionFingerprints = new Set<string>();
  const pendingCrashFilePath = options.pendingCrashFilePath ?? null;

  const stateStore = createJsonStateStore<TelemetryState>({
    name: 'telemetry state',
    filePath: options.stateFilePath,
    parse: (raw) => {
      const parsed = TelemetryState.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    adopt: (loaded) => {
      state = loaded;
    },
    warn: (message, fields) => log.warnOnce(message, message, fields),
  });

  const heartbeatTimer = setInterval(() => {
    const activeSessionCount = options.getActiveSessionCount?.() ?? 0;
    capture('app_active', { active_session_count: activeSessionCount });
  }, ACTIVE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  function isEnabled(): boolean {
    return !isStopped && decideTelemetryConsent(options.env, options.config).isEnabled;
  }

  function persistState(nextState: TelemetryState): Promise<void> {
    state = nextState;
    return stateStore.write(nextState, () => JSON.stringify(nextState, null, 2));
  }

  async function ensureInstallState(): Promise<TelemetryState> {
    await stateStore.load();
    if (state) return state;
    const freshState = { installId: randomUUID(), noticeShownAt: null };
    await persistState(freshState);
    return freshState;
  }

  function clearFlushTimer(): void {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }

  function enqueue(event: TelemetryEventName, properties: Record<string, unknown>): void {
    queue.push({ event, timestamp: now().toISOString(), properties });
    if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(queue.length - MAX_QUEUED_EVENTS);
    if (queue.length >= FLUSH_AT_EVENT_COUNT) {
      void flush();
      return;
    }
    scheduleFlush();
  }

  function capture<EventName extends TelemetryEventName>(event: EventName, properties: TelemetryEventProperties<EventName>): void {
    if (!isEnabled()) return;
    const parsed = TELEMETRY_EVENT_SCHEMAS[event].safeParse(properties);
    if (!parsed.success) {
      log.warnOnce(`invalid:${event}`, 'dropped an event that failed its allowlist', { event });
      return;
    }
    enqueue(event, parsed.data);
  }

  function captureExceptionOnce(properties: ExceptionProperties): void {
    if (!isEnabled()) return;
    const fingerprint = exceptionFingerprint(properties);
    if (reportedExceptionFingerprints.has(fingerprint)) return;
    if (reportedExceptionFingerprints.size >= MAX_REPORTED_EXCEPTION_FINGERPRINTS) return;
    reportedExceptionFingerprints.add(fingerprint);
    capture('$exception', properties);
  }

  function captureException(error: unknown, { handled }: { handled: boolean }): void {
    captureExceptionOnce(buildExceptionProperties(error, { handled, packageRoot: options.packageRoot }));
  }

  function captureClientError(report: ClientErrorReport): void {
    captureExceptionOnce(buildBrowserExceptionProperties(report));
  }

  function recordFatalCrash(error: unknown): void {
    if (!pendingCrashFilePath || !isEnabled()) return;
    const properties = buildExceptionProperties(error, { handled: false, packageRoot: options.packageRoot });
    const report = PendingCrashReport.safeParse({ timestamp: now().toISOString(), properties });
    if (!report.success) return;
    try {
      writeJsonAtomicSync(pendingCrashFilePath, report.data, { mkdir: true });
    } catch (writeError) {
      log.warnOnce('crash-write-failed', 'could not record the crash', { error: errorKind(writeError) });
    }
  }

  function watchForCrashes(source: CrashEventSource = process): void {
    if (crashEventSource) return;
    crashEventSource = source;
    source.on(CRASH_MONITOR_EVENT, recordFatalCrash);
  }

  function stopWatchingForCrashes(): void {
    crashEventSource?.off(CRASH_MONITOR_EVENT, recordFatalCrash);
    crashEventSource = null;
  }

  function errorKind(error: unknown): string {
    return error instanceof Error ? error.name : 'NonError';
  }

  async function readPendingCrash(filePath: string): Promise<PendingCrashReport | null> {
    try {
      const report = PendingCrashReport.safeParse(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
      if (!report.success) log.warnOnce('crash-invalid', 'dropped an unreadable pending crash report');
      return report.success ? report.data : null;
    } catch (readError) {
      const isMissing = readError instanceof Error && Reflect.get(readError, 'code') === 'ENOENT';
      if (!isMissing) log.warnOnce('crash-read-failed', 'could not read the pending crash report', { error: errorKind(readError) });
      return null;
    }
  }

  async function sendPendingCrash(): Promise<void> {
    if (!pendingCrashFilePath) return;
    const report = isEnabled() ? await readPendingCrash(pendingCrashFilePath) : null;
    if (report && !await send([{ event: '$exception', timestamp: report.timestamp, properties: report.properties }], SEND_TIMEOUT_MS)) return;
    try {
      await fs.promises.rm(pendingCrashFilePath, { force: true });
    } catch (removeError) {
      log.warnOnce('crash-remove-failed', 'could not remove the pending crash report', { error: errorKind(removeError) });
    }
  }

  async function send(batch: QueuedEvent[], timeoutMs: number): Promise<boolean> {
    try {
      const { installId } = await ensureInstallState();
      const response = await fetchFn(TELEMETRY_BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: resolveProjectToken(options.env),
          batch: batch.map((queued) => ({
            event: queued.event,
            distinct_id: installId,
            timestamp: queued.timestamp,
            properties: { ...queued.properties, ...baseProperties },
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) log.warnOnce(`status:${response.status}`, 'send rejected', { status: response.status });
      return response.ok;
    } catch (error) {
      log.warnOnce('send-failed', 'send failed', { error: error instanceof Error ? error.name : String(error) });
      return false;
    }
  }

  function flushWithin(timeoutMs: number): Promise<void> {
    if (inFlightFlush) return inFlightFlush;
    clearFlushTimer();
    if (!decideTelemetryConsent(options.env, options.config).isEnabled) {
      queue = [];
      return Promise.resolve();
    }
    if (queue.length === 0) return Promise.resolve();
    const batch = queue;
    queue = [];
    inFlightFlush = send(batch, timeoutMs).then(() => undefined).finally(() => {
      inFlightFlush = null;
      if (queue.length > 0 && !isStopped) scheduleFlush();
    });
    return inFlightFlush;
  }

  function flush(): Promise<void> {
    return flushWithin(SEND_TIMEOUT_MS);
  }

  async function stop(): Promise<void> {
    if (isStopped) return;
    const isConsentGiven = isEnabled();
    isStopped = true;
    stopWatchingForCrashes();
    clearInterval(heartbeatTimer);
    clearFlushTimer();
    const remaining = queue;
    queue = [];
    if (isConsentGiven && remaining.length > 0) await send(remaining, STOP_SEND_TIMEOUT_MS);
    await stateStore.idle();
  }

  async function consumeFirstRunNotice(): Promise<boolean> {
    if (!isEnabled()) return false;
    const installState = await ensureInstallState();
    if (installState.noticeShownAt) return false;
    await persistState({ ...installState, noticeShownAt: now().toISOString() });
    return true;
  }

  function applyConfig(): void {
    if (decideTelemetryConsent(options.env, options.config).isEnabled) return;
    queue = [];
    clearFlushTimer();
  }

  return {
    capture, captureException, captureClientError, recordFatalCrash, watchForCrashes, sendPendingCrash,
    flush, stop, consumeFirstRunNotice, applyConfig, isEnabled,
  };
}

export { createTelemetry, MAX_QUEUED_EVENTS, MAX_REPORTED_EXCEPTION_FINGERPRINTS };
export type { CrashEventSource, Telemetry, TelemetryOptions };
