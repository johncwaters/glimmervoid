import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { ClientErrorReport } from '../shared/contracts/control-messages.ts';
import { PendingCrashReport, TELEMETRY_EVENT_SCHEMAS, TelemetryState } from '../shared/contracts/telemetry.ts';
import type { ExceptionProperties, TelemetryEventName, TelemetryEventProperties } from '../shared/contracts/telemetry.ts';
import {
  TELEMETRY_BATCH_URL, TELEMETRY_FLAGS_URL, buildAiGenerationEvents, buildBrowserExceptionProperties, buildExceptionProperties,
  decideRemoteTelemetryState, decideTelemetryConsent, exceptionFingerprint, nodeMajorVersion, resolveProjectToken,
} from './core/telemetry-core.ts';
import type { RemoteTelemetryState, TelemetryConfig, TelemetryEnvironment } from './core/telemetry-core.ts';
import type { UsageGenerationRollupRow } from './core/usage-entry-core.ts';
import { createJsonStateStore, loadJsonStateFile, writeJsonAtomicSync } from './json-file.ts';
import { createLaneLog } from './lane-log.ts';
import type { LaneLogger } from './lane-log.ts';
import { createCoalescedTimer } from '../shared/coalesce-timer.ts';

const MAX_QUEUED_EVENTS = 500;
const FLUSH_AT_EVENT_COUNT = 20;
const FLUSH_INTERVAL_MS = 60_000;
const SEND_TIMEOUT_MS = 5000;
const STOP_SEND_TIMEOUT_MS = 2500;
const ACTIVE_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REMOTE_SWITCH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  isDevInstall: boolean;
  releaseId?: string | null;
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
  captureAiGenerations(rows: readonly UsageGenerationRollupRow[]): Promise<void>;
  checkRemoteSwitch(): Promise<void>;
  startRemoteSwitchChecks(): void;
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
    is_dev_install: options.isDevInstall,
    ...(options.releaseId ? { $release_id: options.releaseId } : {}),
    $lib: 'glimmervoid',
    $process_person_profile: false,
  };
  let queue: QueuedEvent[] = [];
  let state: TelemetryState | null = null;
  const flushTimer = createCoalescedTimer({ mode: 'leading', delayMs: FLUSH_INTERVAL_MS, run: () => { void flush(); } });
  let inFlightFlush: Promise<void> | null = null;
  let isStopped = false;
  let remoteTelemetryState: RemoteTelemetryState = 'enabled';
  let wasLocalConsentGiven = isLocalConsentGiven();
  let remoteSwitchTimer: NodeJS.Timeout | null = null;
  let firstRemoteSwitchCheck: Promise<void> | null = null;
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
      remoteTelemetryState = loaded?.remoteDisabled === true ? 'disabled' : 'enabled';
    },
    warn: (message, fields) => log.warnOnce(message, message, fields),
  });

  const heartbeatTimer = setInterval(() => {
    const activeSessionCount = options.getActiveSessionCount?.() ?? 0;
    capture('app_active', { active_session_count: activeSessionCount });
  }, ACTIVE_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  function isLocalConsentGiven(): boolean {
    return decideTelemetryConsent(options.env, options.config).isEnabled;
  }

  function isCaptureAllowed(): boolean {
    return isLocalConsentGiven() && remoteTelemetryState === 'enabled';
  }

  function isEnabled(): boolean {
    return !isStopped && isCaptureAllowed();
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
    flushTimer.cancel();
  }

  function scheduleFlush(): void {
    flushTimer.schedule();
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
    const outcome = await loadJsonStateFile({
      filePath,
      parse: (raw: unknown) => {
        const report = PendingCrashReport.safeParse(raw);
        return report.success ? report.data : null;
      },
      quarantine: false,
      includeNotDir: false,
    });
    if (outcome.status === 'loaded') return outcome.value;
    if (outcome.status === 'corrupt') log.warnOnce('crash-invalid', 'dropped an unreadable pending crash report');
    if (outcome.status === 'unreadable') log.warnOnce('crash-read-failed', 'could not read the pending crash report', { error: errorKind(outcome.error) });
    return null;
  }

  async function sendPendingCrash(): Promise<void> {
    if (!pendingCrashFilePath) return;
    await stateStore.load();
    await firstRemoteSwitchCheck;
    if (isLocalConsentGiven() && remoteTelemetryState === 'disabled') return;
    const report = isEnabled() ? await readPendingCrash(pendingCrashFilePath) : null;
    if (report && !await send([{ event: '$exception', timestamp: report.timestamp, properties: report.properties }], SEND_TIMEOUT_MS)) return;
    try {
      await fs.promises.rm(pendingCrashFilePath, { force: true });
    } catch (removeError) {
      log.warnOnce('crash-remove-failed', 'could not remove the pending crash report', { error: errorKind(removeError) });
    }
  }

  async function captureAiGenerations(rows: readonly UsageGenerationRollupRow[]): Promise<void> {
    if (rows.length === 0 || !isEnabled()) return;
    const { installId } = await ensureInstallState();
    for (const properties of buildAiGenerationEvents(rows, installId)) capture('$ai_generation', properties);
  }

  async function send(batch: QueuedEvent[], timeoutMs: number): Promise<boolean> {
    try {
      const { installId } = await ensureInstallState();
      if (remoteTelemetryState === 'disabled') return false;
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
    if (!isCaptureAllowed()) {
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

  async function fetchFeatureFlags(): Promise<unknown> {
    try {
      const { installId } = await ensureInstallState();
      const response = await fetchFn(TELEMETRY_FLAGS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: resolveProjectToken(options.env), distinct_id: installId }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warnOnce(`flags-status:${response.status}`, 'flag check rejected', { status: response.status });
        return null;
      }
      return await response.json();
    } catch (error) {
      log.warnOnce('flags-failed', 'flag check failed', { error: errorKind(error) });
      return null;
    }
  }

  async function checkRemoteSwitch(): Promise<void> {
    if (isStopped || !isLocalConsentGiven()) return;
    const featureFlags = await fetchFeatureFlags();
    const nextRemoteTelemetryState = decideRemoteTelemetryState(remoteTelemetryState, featureFlags);
    const hasRemoteStateChanged = nextRemoteTelemetryState !== remoteTelemetryState;
    remoteTelemetryState = nextRemoteTelemetryState;
    if (nextRemoteTelemetryState === 'disabled') {
      queue = [];
      clearFlushTimer();
    }
    if (!hasRemoteStateChanged || !state) return;
    await persistState({ ...state, remoteDisabled: nextRemoteTelemetryState === 'disabled' });
  }

  function startRemoteSwitchChecks(): void {
    if (remoteSwitchTimer || isStopped) return;
    remoteSwitchTimer = setInterval(() => void checkRemoteSwitch(), REMOTE_SWITCH_CHECK_INTERVAL_MS);
    remoteSwitchTimer.unref();
    firstRemoteSwitchCheck = checkRemoteSwitch();
  }

  async function stop(): Promise<void> {
    if (isStopped) return;
    const isConsentGiven = isEnabled();
    isStopped = true;
    stopWatchingForCrashes();
    clearInterval(heartbeatTimer);
    if (remoteSwitchTimer) clearInterval(remoteSwitchTimer);
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
    const isLocalConsentNowGiven = isLocalConsentGiven();
    const isLocalConsentTurnedOn = isLocalConsentNowGiven && !wasLocalConsentGiven;
    wasLocalConsentGiven = isLocalConsentNowGiven;
    if (isLocalConsentTurnedOn) void checkRemoteSwitch();
    if (isCaptureAllowed()) return;
    queue = [];
    clearFlushTimer();
  }

  return {
    capture, captureException, captureClientError, captureAiGenerations, recordFatalCrash, watchForCrashes, sendPendingCrash,
    checkRemoteSwitch, startRemoteSwitchChecks, flush, stop, consumeFirstRunNotice, applyConfig, isEnabled,
  };
}

export { createTelemetry, MAX_QUEUED_EVENTS, MAX_REPORTED_EXCEPTION_FINGERPRINTS };
export type { CrashEventSource, Telemetry, TelemetryOptions };
