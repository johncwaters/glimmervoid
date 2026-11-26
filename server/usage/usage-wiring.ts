import nodeFsPromises from 'node:fs/promises';
import type { YourDay } from '../../shared/contracts/your-day.ts';
import path from 'node:path';

import { decideTelegramNotification } from '../../notifications/channels/telegram.ts';
import { USAGE_RETAIN_DAYS_RANGE } from '../../shared/settings-ranges.ts';
import { budgetScopesAtLimit, evaluateBudget, markFired, pausedPeriodsAfter, pausedScopesInPeriod, readPausedPeriods, mergeFiredState, normalizeBudgetConfig } from './core/usage-budget-core.ts';
import type { BudgetAlert, BudgetConfig, BudgetFiredState, BudgetPausedPeriods } from './core/usage-budget-core.ts';
import type { BudgetHoldPhase } from '../session/session-budget-pause.ts';
import { continuationDelayMs, shouldEvaluateDespiteIoFailures } from './core/usage-scan-core.ts';
import type { PassOutcome } from './core/usage-scan-core.ts';
import {
  buildPlanLimitsMessage,
  buildAccountPlanLimitsMessage,
  normalizeAntigravityQuota,
  normalizeStatuslinePayload,
  selectOfficialSessionCost,
  sessionMeterInputsOf,
  shouldBroadcastPlanLimits,
} from './core/usage-statusline-core.ts';
import type { PlanLimitsVendor, RateLimitWindows, StatuslineSnapshot } from './core/usage-statusline-core.ts';
import { CODEX_PLAN_LIMIT_ID, mergeCodexRateLimitBuckets } from './core/usage-codex-core.ts';
import type { CodexRateLimitSnapshot } from './core/usage-codex-core.ts';
import { createKimiPlanLimitsReader } from './usage-kimi-limits.ts';
import type { KimiPlanLimitsSnapshot } from './core/usage-kimi-limits-core.ts';
import { createJsonStateStore } from '../json-file.ts';
import { createLaneLog } from '../lanes/lane-log.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { loadPricing } from './usage-pricing.ts';
import { costForEntry, lookupModelPrice } from './core/usage-pricing-core.ts';
import type { SessionMeterReading } from '../../shared/contracts/control/lane-messages.ts';
import type { ServerMessageOf } from '../../shared/contracts/index.ts';
import type { PricingResult } from './usage-pricing.ts';
import type { Telemetry } from '../telemetry.ts';
import { createUsageScanner } from './usage-scanner.ts';
import type { UsageScannerApi, UsageScannerOptions } from './usage-scanner.ts';
import { errorMessage } from '../../shared/text.ts';
import { isRecord } from '../../shared/coerce.ts';
import { DEFAULT_TIMER_FNS, unrefTimer } from '../../shared/timer-deps.ts';
import type { ClearIntervalFn, ClearTimeoutFn, SetIntervalFn, SetTimeoutFn } from '../../shared/timer-deps.ts';
import { createCoalescedTimer } from '../../shared/coalesce-timer.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import { clock } from '../../shared/clock.ts';

const USAGE_SCAN_INTERVAL_MINUTES = 5;
const USAGE_WAREHOUSE_RETAIN_DAYS = 365;
const USAGE_SESSION_BLOCK_HOURS = 5;
const USAGE_COST_MODE = 'auto';
const USAGE_VENDORS = Object.freeze({ codex: true, grok: true, kimi: true, antigravity: true, pi: true, opencode: true });

const DEFAULT_USAGE_CONFIG = Object.freeze({
  enabled: true,
  retainDays: 90,
  extraProjectsDirs: [],
  budget: { dailyUsd: null, monthlyUsd: null, pauseAtLimit: false },
});

const OFFICIAL_COST_CAP = 200;
const SESSION_METER_CAP = 200;

const NUDGE_DEBOUNCE_MS = 2000;

const PARTIAL_CONTINUE_MS = 15000;
const FORCE_PASS_MIN_INTERVAL_MS = 3000;
const TELEGRAM_TIMEOUT_MS = 10000;
const IO_FAILURE_EVALUATION_LIMIT = 3;

const KIMI_IDLE_POLL_MS = 15 * 60 * 1000;
const KIMI_VIEWED_POLL_MS = 60 * 1000;
const KIMI_AGENT_ID = 'kimi';
const CODEX_AGENT_ID = 'codex';

interface UsageLaneConfig {
  enabled: boolean;
  retainDays: number;
  extraProjectsDirs: string[];
  budget: BudgetConfig;
}

interface WiringConfig {
  usage?: unknown;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface WiringSession {
  name?: string;
  ephemeral?: boolean;
  resumeSessionId?: string | null;
  accountIdInUse?: string | null;
  accountInUseSinceMs?: number | null;
  agentId?: string;
  hasLivePty?: boolean;
}

interface PlanLimitsSnapshot {
  rateLimits: RateLimitWindows | null;
  ts: number;
}

type SessionsMessage = {
  type: string;
  ts: number;
  pricingSource: string | null;
  yourDay: YourDay | null;
  sessions: {
    id: string;
    name?: string;
    vendor?: string;
    model?: string | null;
    tokens: number;
    costUSD: number;
    lastHourCostUSD?: number;
    cacheHitPct?: number | null;
    lastTs: number | null;
    officialCostUSD: number | null | undefined;
  }[];
};

type PassResult = Awaited<ReturnType<UsageScannerApi['runPass']>>;

interface UsageWiringOptions {
  config: WiringConfig;
  sessions?: Map<string, WiringSession>;
  broadcast?: (message: Record<string, unknown>) => void;
  controlClientCount?: () => number;
  warehousePath?: string | null;
  snapshotPath?: string | null;
  appVersion?: string;
  budgetStatePath?: string | null;
  onBudgetHold?: (phase: BudgetHoldPhase) => string[];
  laneMap?: (() => Map<string, string>) | null;
  telemetry?: Pick<Telemetry, 'captureAiGenerations'> | null;
  sendTelegram?: typeof sendTelegramMessage;
  telegramTimeoutMs?: number;
  fsPromises?: typeof nodeFsPromises;
  createScanner?: (deps?: UsageScannerOptions) => UsageScannerApi;
  loadPricingFn?: typeof loadPricing;
  readKimiPlanLimits?: () => Promise<KimiPlanLimitsSnapshot | null>;
  scannerDeps?: Record<string, unknown>;
  nowFn?: () => number;
  partialContinueMs?: number;
  setIntervalFn?: SetIntervalFn;
  clearIntervalFn?: ClearIntervalFn;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  logger?: Pick<Console, 'warn' | 'log'>;
  debug?: boolean | (() => boolean);
}

function integerWithin(value: unknown, { min, max }: { min: number; max: number }, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  const numeric = Number(value);
  if (numeric < min || numeric > max) return fallback;
  return numeric;
}

function absoluteDirList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()) && path.isAbsolute(entry.trim()))
    .map((entry) => entry.trim());
}

function resolveUsageConfig(usage: unknown): UsageLaneConfig {
  const source: Record<string, unknown> = isRecord(usage) ? usage : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_USAGE_CONFIG.enabled,
    retainDays: integerWithin(source.retainDays, USAGE_RETAIN_DAYS_RANGE, DEFAULT_USAGE_CONFIG.retainDays),
    extraProjectsDirs: absoluteDirList(source.extraProjectsDirs),
    budget: normalizeBudgetConfig(source.budget as { dailyUsd?: unknown; monthlyUsd?: unknown; pauseAtLimit?: unknown } | null),
  };
}

function usageShouldStart(cfg: { usage?: unknown } | null | undefined): boolean {
  return resolveUsageConfig(cfg?.usage).enabled;
}

function usageCfgKey(cfg: { usage?: unknown } | null | undefined): string {
  return JSON.stringify({ usage: cfg?.usage || null });
}

function formatBudgetUsd(value: unknown): string {
  const number = Number.isFinite(value) ? Number(value) : 0;
  return `$${number.toFixed(2)}`;
}

function budgetAlertText(
  { scope, threshold, spentUsd, budgetUsd }: { scope?: unknown; threshold?: unknown; spentUsd?: unknown; budgetUsd?: unknown },
): string {
  const period = scope === 'monthly' ? 'monthly' : 'daily';
  return `Usage budget: ${period} spend ${formatBudgetUsd(spentUsd)} reached ${threshold}% of ${formatBudgetUsd(budgetUsd)}`;
}

interface StoredSessionMeter {
  message: ServerMessageOf<'session-meter'>;
  pricingModelId: string | null;
}

function meterReadingOf(message: ServerMessageOf<'session-meter'>): SessionMeterReading {
  const { type: _type, id: _id, ts: _ts, ...reading } = message;
  return reading;
}

function createUsageWiring({
  config,
  sessions = new Map(),
  broadcast = () => {},
  controlClientCount = () => 0,

  warehousePath = null,
  snapshotPath = null,
  appVersion = '',

  budgetStatePath = null,
  onBudgetHold = () => [],

  laneMap = null,
  telemetry = null,
  sendTelegram = sendTelegramMessage,
  telegramTimeoutMs = TELEGRAM_TIMEOUT_MS,
  fsPromises = nodeFsPromises,
  createScanner = createUsageScanner,
  loadPricingFn = loadPricing,
  readKimiPlanLimits,
  scannerDeps = {},
  nowFn = clock.nowMs,
  partialContinueMs = PARTIAL_CONTINUE_MS,
  setIntervalFn = DEFAULT_TIMER_FNS.setIntervalFn,
  clearIntervalFn = DEFAULT_TIMER_FNS.clearIntervalFn,
  setTimeoutFn = DEFAULT_TIMER_FNS.setTimeoutFn,
  clearTimeoutFn = DEFAULT_TIMER_FNS.clearTimeoutFn,
  logger = console,
  debug = false,
}: UsageWiringOptions) {
  const laneLog = createLaneLog({ prefix: '[usage]', logger, debugFlag: debug });
  const readKimiLimits = readKimiPlanLimits ?? createKimiPlanLimitsReader({ logger }).readPlanLimits;
  let cfg = resolveUsageConfig(config.usage);
  let budgetHold: { kind: 'unread' } | { kind: 'read'; holdReason: string | null } = { kind: 'unread' };
  let lastPassOutcome: PassOutcome | null = null;
  let budgetPausedPeriods: BudgetPausedPeriods = { daily: null, monthly: null };
  let lastKey = usageCfgKey(config);
  let scanner: UsageScannerApi | null = null;
  let pricing: PricingResult | null = null;
  let startPromise: Promise<void> | null = null;
  let startRequested = false;
  let stopped = false;
  let passInFlight = false;
  const telemetryCapturedPasses = new WeakSet<PassResult>();
  let intervalTimer: NodeJS.Timeout | null = null;
  let continueTimer: NodeJS.Timeout | null = null;
  const restartQueue = createSerialQueue();
  let lastSessionsSignature: string | null = null;
  let lastReportMessage: Record<string, unknown> | null = null;
  let lastForcedPassMs = 0;
  let ioFailureStreak = 0;
  let ioFailureStreakId = 0;

  const planLimitsByVendor: Record<PlanLimitsVendor, PlanLimitsSnapshot | null> = { claude: null, codex: null, kimi: null, antigravity: null };
  const codexAccountBucketsByKey = new Map<string, Map<string, CodexRateLimitSnapshot>>();
  const accountPlanLimitsByKey = new Map<string, { vendor: PlanLimitsVendor; accountId: string | null; snapshot: PlanLimitsSnapshot }>();
  let lastKimiPollMs: number | null = null;
  let kimiPollInFlight: Promise<void> | null = null;
  const officialCostByClaudeId = new Map<string, number>();
  const sessionMeterById = new Map<string, StoredSessionMeter>();
  let budgetFiredState: BudgetFiredState = { daily: {}, monthly: {} };
  let budgetEvaluation:
    | { kind: 'idle' }
    | { kind: 'running'; settled: Promise<void> }
    | { kind: 'running-queued'; settled: Promise<void>; queued: Promise<void> } = { kind: 'idle' };

  const budgetStateStore = createJsonStateStore<{ fired: BudgetFiredState; paused: BudgetPausedPeriods }>({
    name: 'budget state',
    filePath: budgetStatePath,
    fsPromises,
    nowMs: nowFn,
    warn: laneLog.warn,
    parse: (raw) => {
      const stored = raw && typeof raw === 'object' ? raw as { fired?: unknown; paused?: unknown } : {};
      const fired = stored.fired && typeof stored.fired === 'object' ? stored.fired as BudgetFiredState : { daily: {}, monthly: {} };
      return { fired, paused: readPausedPeriods(stored.paused) };
    },
    adopt: (loaded) => {
      budgetFiredState = mergeFiredState(budgetFiredState, loaded?.fired ?? {});
      const loadedPaused = loaded?.paused ?? { daily: null, monthly: null };
      budgetPausedPeriods = { daily: budgetPausedPeriods.daily ?? loadedPaused.daily, monthly: budgetPausedPeriods.monthly ?? loadedPaused.monthly };
    },
  });

  async function loadPricingSafely(): Promise<PricingResult> {
    try {
      return await loadPricingFn({ fetchEnabled: true, logger });
    } catch (error) {
      laneLog.warn('pricing load failed', { error: errorMessage(error) });
      return { table: new Map(), source: 'unavailable', fetchedAt: null };
    }
  }

  function armInterval(): void {
    if (stopped || intervalTimer) return;
    intervalTimer = setIntervalFn(onIntervalTick, USAGE_SCAN_INTERVAL_MINUTES * 60 * 1000);
    unrefTimer(intervalTimer);
  }

  function onIntervalTick(): void {
    if (stopped || !scanner) return;
    void pollKimiPlanLimits(KIMI_IDLE_POLL_MS);
    if (passInFlight) return;
    void runPassAndPush({ force: false });
  }

  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve();
    startRequested = true;
    cfg = resolveUsageConfig(config.usage);
    lastKey = usageCfgKey(config);
    if (!usageShouldStart(config)) {
      laneLog.note('usage lane not started: disabled by config');
      return Promise.resolve();
    }
    startPromise = (async () => {
      if (budgetStatePath) await loadBudgetState();
      const loadedPricing = await loadPricingSafely();
      pricing = loadedPricing;
      repriceSessionMeters();
      if (stopped) return;
      scanner = createScanner({
        pricingTable: loadedPricing.table,
        costMode: USAGE_COST_MODE,
        blockHours: USAGE_SESSION_BLOCK_HOURS,
        retainDays: cfg.retainDays,
        extraProjectsDirs: cfg.extraProjectsDirs,
        vendors: USAGE_VENDORS,
        warehousePath,
        snapshotPath,
        appVersion,
        warehouseRetainDays: USAGE_WAREHOUSE_RETAIN_DAYS,
        budget: cfg.budget,
        laneMap,
        logger,
        ...scannerDeps,
      });
      await runPassAndPush({ force: false });
      armInterval();
    })().catch((error: unknown) => laneLog.warn('start failed', { error: errorMessage(error) }));
    return startPromise;
  }

  let passSettled: Promise<void> | null = null;

  function runPassAndPush(request: { force: boolean; scopeDirs?: string[] | null }) {
    const pass = runPassAndPushOnce(request);
    const settled = pass.then(() => {}, () => {}).finally(() => {
      if (passSettled === settled) passSettled = null;
    });
    passSettled = settled;
    return pass;
  }

  async function runPassAndPushOnce({ force, scopeDirs = null }: { force: boolean; scopeDirs?: string[] | null }) {
    if (stopped || !scanner) return null;
    passInFlight = true;
    let result: PassResult | null = null;
    try {
      result = await scanner.runPass({ force, scopeDirs });
    } catch (error) {
      laneLog.warn('scan pass failed', { error: errorMessage(error) });
    } finally {
      passInFlight = false;
    }
    if (stopped) return result;

    if (result) {
      ingestCodexRateLimits(scanner.latestCodexRateLimits());
      ingestCodexAccountRateLimits(scanner.drainCodexRateLimits());
      laneLog.debugNote(
        () => 'pass complete',
        () => ({
          files: result.files,
          entries: result.entries,
          newEntries: result.newEntries,
          durationMs: result.durationMs,
          outcome: result.outcome,
        }),
      );
    }

    if (result?.outcome === 'io-failed') {
      ioFailureStreak += 1;
      laneLog.warnOnce(
        `scan-io:${ioFailureStreakId}`,
        'scan pass lost files to io errors',
        { ioFailures: result.ioFailures, files: result.files },
      );
    }
    if (result) lastPassOutcome = result.outcome;
    if (result?.outcome === 'complete') {
      if (ioFailureStreak > 0) ioFailureStreakId += 1;
      ioFailureStreak = 0;
    }

    if (result && telemetry && !telemetryCapturedPasses.has(result)) {
      telemetryCapturedPasses.add(result);
      telemetry.captureAiGenerations(result.generationRollup)
        .catch((error: unknown) => laneLog.warn('ai generation telemetry failed', { error: errorMessage(error) }));
    }

    const lostTheStore = result?.outcome === 'io-failed' && result.storeReset;
    if (result && !lostTheStore) pushSessions();

    const evaluateNow = result?.outcome === 'complete'
      || (result?.outcome === 'io-failed' && shouldEvaluateDespiteIoFailures({ ioFailureStreak, limit: IO_FAILURE_EVALUATION_LIMIT }));
    if (evaluateNow) await evaluateBudgets();
    if (result) scheduleContinuation(result.outcome);
    return result;
  }

  function scheduleContinuation(outcome: PassOutcome): void {
    const delayMs = continuationDelayMs({ outcome, ioFailureStreak, partialMs: partialContinueMs });
    if (delayMs === null) return;
    if (stopped || !scanner || continueTimer) return;
    continueTimer = setTimeoutFn(() => {
      continueTimer = null;
      if (stopped || !scanner) return;
      if (passInFlight) {
        scheduleContinuation(outcome);
        return;
      }
      void runPassAndPush({ force: false });
    }, delayMs);
    unrefTimer(continueTimer);
  }

  let nudgedTranscriptDirs: Set<string> | null = new Set();

  function takeNudgedTranscriptDirs(): string[] | null {
    const scopeDirs = nudgedTranscriptDirs === null ? null : [...nudgedTranscriptDirs];
    nudgedTranscriptDirs = new Set();
    return scopeDirs;
  }

  function noteNudgedTranscript(transcriptPath: string | null): void {
    if (nudgedTranscriptDirs === null) return;
    if (!transcriptPath) {
      nudgedTranscriptDirs = null;
      return;
    }
    nudgedTranscriptDirs.add(path.dirname(transcriptPath));
  }

  const nudge = createCoalescedTimer({
    mode: 'trailing',
    delayMs: NUDGE_DEBOUNCE_MS,
    run: () => {
      if (stopped || !scanner) return;
      if (passInFlight) {
        nudge.schedule();
        return;
      }
      void runPassAndPush({ force: false, scopeDirs: takeNudgedTranscriptDirs() });
    },
    setTimeoutFn,
    clearTimeoutFn,
  });

  function nudgeSession(transcriptPath: string | null = null): void {
    if (stopped || !scanner) return;
    noteNudgedTranscript(transcriptPath);
    nudge.schedule();
  }

  function vendorForAgentId(agentId: string | undefined): string {
    if (!agentId || agentId === 'claude-code') return 'claude';
    if (agentId === 'kimi-code') return 'kimi';
    return agentId;
  }

  function sessionUsageRows(): SessionsMessage['sessions'] | null {
    if (!scanner) return null;
    const liveTargets: { vendor: string; sessionId: string }[] = [];
    for (const [, sess] of sessions) {
      if (sess.ephemeral || !sess.resumeSessionId) continue;
      liveTargets.push({ vendor: vendorForAgentId(sess.agentId), sessionId: sess.resumeSessionId });
    }
    const liveStats = typeof scanner.liveSessionStats === 'function'
      ? scanner.liveSessionStats(liveTargets)
      : null;
    const fallbackTotals = liveStats ? null : scanner.sessionTotals();
    const rows: SessionsMessage['sessions'] = [];
    for (const [id, sess] of sessions) {
      if (sess.ephemeral) continue;
      const resumeId = sess.resumeSessionId;
      if (!resumeId) continue;
      const vendor = vendorForAgentId(sess.agentId);
      const stats = liveStats?.get(`${vendor}:${resumeId}`);
      const fallback = fallbackTotals?.get(resumeId);
      const officialCostUSD = selectOfficialSessionCost(USAGE_COST_MODE, officialCostByClaudeId.get(resumeId));
      if (!stats && !fallback && officialCostUSD === null) continue;
      const tokens = stats?.tokens ?? fallback?.tokens ?? 0;
      const costUSD = stats?.costUSD ?? fallback?.costUSD ?? 0;
      const lastTs = stats?.lastTs ?? fallback?.lastTs ?? null;
      const totalInput = (stats?.input ?? 0) + (stats?.cacheRead ?? 0);
      const cacheHitPct = stats && totalInput > 0 ? Math.round(((stats.cacheRead ?? 0) / totalInput) * 100) : null;
      rows.push({
        id,
        name: sess.name,
        vendor: stats?.vendor ?? vendor,
        model: stats?.model ?? null,
        tokens,
        costUSD,
        lastHourCostUSD: stats?.lastHourCostUSD ?? 0,
        cacheHitPct,
        lastTs,
        officialCostUSD,
      });
    }
    return rows;
  }

  function getSessionsMessage(): SessionsMessage | null {
    const rows = sessionUsageRows();
    if (!rows) return null;
    return { type: 'usage-sessions', ts: nowFn(), pricingSource: pricing?.source || null, yourDay: scanner?.yourDay() ?? null, sessions: rows };
  }

  function sessionUsageLookup(): (sessionId: string) => { tokens: number; costUSD: number } | null {
    const usageById = new Map((sessionUsageRows() ?? []).map((row) => [row.id, { tokens: row.tokens, costUSD: row.officialCostUSD ?? row.costUSD }]));
    return (sessionId) => usageById.get(sessionId) ?? null;
  }

  function pushSessions(): void {
    const message = getSessionsMessage();
    if (!message) return;
    const signature = JSON.stringify([message.sessions, message.yourDay]);
    if (signature === lastSessionsSignature) return;
    lastSessionsSignature = signature;
    broadcast(message);
  }

  function refreshSessions(): void {
    if (stopped || !scanner) return;
    pushSessions();
  }

  function rememberOfficialCost(snapshot: StatuslineSnapshot): void {
    if (!snapshot.claudeSessionId || snapshot.sessionCostUSD === null) return;
    officialCostByClaudeId.delete(snapshot.claudeSessionId);
    officialCostByClaudeId.set(snapshot.claudeSessionId, snapshot.sessionCostUSD);
    if (officialCostByClaudeId.size <= OFFICIAL_COST_CAP) return;
    const oldest = officialCostByClaudeId.keys().next();
    if (!oldest.done) officialCostByClaudeId.delete(oldest.value);
  }

  function callCostOf(modelId: string, contextTokens: number): number | null {
    const resolved = lookupModelPrice(pricing?.table, modelId);
    if (!resolved) return null;
    return costForEntry({ model: modelId, cacheRead: contextTokens }, resolved.price, { costMode: 'calculate' }).costUSD;
  }

  function publishSessionMeter(glimmervoidId: string, reading: SessionMeterReading, pricingModelId: string | null): void {
    const stored = sessionMeterById.get(glimmervoidId);
    if (stored && JSON.stringify(meterReadingOf(stored.message)) === JSON.stringify(reading)) return;
    const message: ServerMessageOf<'session-meter'> = { type: 'session-meter', id: glimmervoidId, ts: nowFn(), ...reading };
    sessionMeterById.delete(glimmervoidId);
    sessionMeterById.set(glimmervoidId, { message, pricingModelId });
    if (sessionMeterById.size > SESSION_METER_CAP) {
      const oldest = sessionMeterById.keys().next();
      if (!oldest.done) sessionMeterById.delete(oldest.value);
    }
    broadcast(message);
  }

  function rememberSessionMeter(payload: unknown, glimmervoidId: string): void {
    const inputs = sessionMeterInputsOf(payload);
    if (!inputs) return;
    const stored = sessionMeterById.get(glimmervoidId);
    if (
      stored
      && stored.pricingModelId === inputs.pricingModelId
      && stored.message.model === inputs.model
      && stored.message.effort === inputs.effort
      && stored.message.contextTokens === inputs.contextTokens
      && stored.message.contextWindow === inputs.contextWindow
      && stored.message.outputStyle === inputs.outputStyle
    ) {
      return;
    }
    const callCostUSD = inputs.pricingModelId !== null && inputs.contextTokens !== null ? callCostOf(inputs.pricingModelId, inputs.contextTokens) : null;
    publishSessionMeter(glimmervoidId, {
      model: inputs.model,
      effort: inputs.effort,
      contextTokens: inputs.contextTokens,
      contextWindow: inputs.contextWindow,
      callCostUSD,
      outputStyle: inputs.outputStyle,
    }, inputs.pricingModelId);
  }

  function repriceSessionMeters(): void {
    for (const [glimmervoidId, { message, pricingModelId }] of [...sessionMeterById]) {
      const reading = meterReadingOf(message);
      const callCostUSD = pricingModelId !== null && reading.contextTokens !== null ? callCostOf(pricingModelId, reading.contextTokens) : null;
      publishSessionMeter(glimmervoidId, { ...reading, callCostUSD }, pricingModelId);
    }
  }

  function getSessionMeterMessages(): ServerMessageOf<'session-meter'>[] {
    return [...sessionMeterById.values()].map((stored) => stored.message);
  }

  function ingestStatusline(payload: unknown, glimmervoidId: string): void {
    if (stopped) return;
    rememberSessionMeter(payload, glimmervoidId);
    if (!cfg.enabled) return;
    const nowMs = nowFn();
    const snapshot = normalizeStatuslinePayload(payload, nowMs);
    if (snapshot) {
      rememberOfficialCost(snapshot);
      if (snapshot.rateLimits) {
        adoptPlanLimits('claude', snapshot);
        adoptAccountPlanLimits('claude', sessions.get(glimmervoidId)?.accountIdInUse ?? null, snapshot);
      }
    }
    const antigravityLimits = normalizeAntigravityQuota(payload, nowMs);
    if (!antigravityLimits) return;
    const antigravitySnapshot: PlanLimitsSnapshot = { rateLimits: antigravityLimits, ts: nowMs };
    adoptPlanLimits('antigravity', antigravitySnapshot);
    adoptAccountPlanLimits('antigravity', sessions.get(glimmervoidId)?.accountIdInUse ?? null, antigravitySnapshot);
  }

  function adoptAccountPlanLimits(vendor: PlanLimitsVendor, accountId: string | null, snapshot: PlanLimitsSnapshot): void {
    const key = `${vendor}:${accountId ?? ''}`;
    const previous = accountPlanLimitsByKey.get(key)?.snapshot ?? null;
    if (previous && snapshot.ts < previous.ts) return;
    accountPlanLimitsByKey.set(key, { vendor, accountId, snapshot });
    if (!shouldBroadcastPlanLimits(previous, snapshot)) return;
    const message = buildAccountPlanLimitsMessage(snapshot, vendor, accountId);
    if (message) broadcast(message);
  }

  function liveCodexSessionOf(agentSessionId: string): WiringSession | null {
    for (const session of sessions.values()) {
      if (session.agentId === CODEX_AGENT_ID && session.hasLivePty === true && session.resumeSessionId === agentSessionId) return session;
    }
    return null;
  }

  function ingestCodexAccountRateLimits(drained: readonly { agentSessionId: string; snapshot: CodexRateLimitSnapshot }[]): void {
    if (stopped || !cfg.enabled) return;
    for (const { agentSessionId, snapshot } of drained) {
      const liveSession = liveCodexSessionOf(agentSessionId);
      if (!liveSession) continue;
      if (snapshot.ts < (liveSession.accountInUseSinceMs ?? Number.POSITIVE_INFINITY)) continue;
      const accountId = liveSession.accountIdInUse ?? null;
      const accountKey = `codex:${accountId ?? ''}`;
      const bucketsById = codexAccountBucketsByKey.get(accountKey) ?? new Map<string, CodexRateLimitSnapshot>();
      const limitId = snapshot.limitId ?? CODEX_PLAN_LIMIT_ID;
      const previousBucket = bucketsById.get(limitId);
      if (previousBucket && snapshot.ts < previousBucket.ts) continue;
      bucketsById.set(limitId, snapshot);
      codexAccountBucketsByKey.set(accountKey, bucketsById);
      const merged = mergeCodexRateLimitBuckets(bucketsById);
      if (merged) adoptAccountPlanLimits('codex', accountId, merged);
    }
  }

  function getAccountPlanLimitsMessages() {
    if (!cfg.enabled) return [];
    return [...accountPlanLimitsByKey.values()]
      .map(({ vendor, accountId, snapshot }) => buildAccountPlanLimitsMessage(snapshot, vendor, accountId))
      .filter((message) => message !== null);
  }

  function adoptPlanLimits(vendor: PlanLimitsVendor, snapshot: PlanLimitsSnapshot, { isFreshPoll = false } = {}): void {
    const previous = planLimitsByVendor[vendor];
    if (previous && snapshot.ts < previous.ts) return;
    const changed = isFreshPoll || shouldBroadcastPlanLimits(previous, snapshot);
    planLimitsByVendor[vendor] = snapshot;
    if (!changed) return;
    const message = buildPlanLimitsMessage(snapshot, vendor);
    if (message) broadcast(message);
  }

  function ingestCodexRateLimits(snapshot: CodexRateLimitSnapshot | null): void {
    if (stopped || !cfg.enabled || !snapshot) return;
    adoptPlanLimits('codex', snapshot);
  }

  function hasLiveKimiSession(): boolean {
    for (const session of sessions.values()) {
      if (session.agentId === KIMI_AGENT_ID && session.hasLivePty !== false) return true;
    }
    return false;
  }

  async function runKimiPoll(): Promise<void> {
    lastKimiPollMs = nowFn();
    const snapshot = await readKimiLimits();
    if (stopped || snapshot === null) return;
    adoptPlanLimits('kimi', snapshot, { isFreshPoll: true });
  }

  function pollKimiPlanLimits(minIntervalMs: number): Promise<void> {
    if (kimiPollInFlight) return kimiPollInFlight;
    if (stopped || !cfg.enabled) return Promise.resolve();
    if (!hasLiveKimiSession()) return Promise.resolve();
    if (lastKimiPollMs !== null && nowFn() - lastKimiPollMs < minIntervalMs) return Promise.resolve();
    kimiPollInFlight = runKimiPoll()
      .catch((error: unknown) => laneLog.warn('kimi plan limits poll failed', { error: errorMessage(error) }))
      .finally(() => { kimiPollInFlight = null; });
    return kimiPollInFlight;
  }

  function getPlanLimitsMessage(vendor: PlanLimitsVendor = 'claude') {
    if (!cfg.enabled) return null;
    return buildPlanLimitsMessage(planLimitsByVendor[vendor], vendor);
  }

  function loadBudgetState(): Promise<void> {
    return budgetStateStore.load();
  }

  async function saveBudgetState(): Promise<void> {
    const stored = { fired: budgetFiredState, paused: budgetPausedPeriods };
    await budgetStateStore.write(stored, () => `${JSON.stringify({ version: 1, ...stored }, null, 2)}\n`);
  }

  async function deliverBudgetTelegram(alert: BudgetAlert): Promise<boolean> {
    const decision = decideTelegramNotification({
      botToken: config.telegram?.botToken || '',
      chatId: config.telegram?.chatId || '',
      connectionCount: controlClientCount(),
    });
    if (!decision.send) return true;
    const telegram = config.telegram;
    if (!telegram?.botToken || !telegram.chatId) return true;
    const message = {
      botToken: telegram.botToken,
      chatId: telegram.chatId,
      text: budgetAlertText(alert),
      timeoutMs: telegramTimeoutMs,
    };
    try {
      const outcome = await sendTelegram(message);
      if (outcome.ok) return true;
      laneLog.warn('budget telegram failed', { scope: alert.scope, period: alert.periodKey, error: outcome.error || 'delivery declined' });
      return false;
    } catch (error) {
      laneLog.warn('budget telegram failed', { scope: alert.scope, period: alert.periodKey, error: errorMessage(error) });
      return false;
    }
  }

  async function evaluateBudgetsOnce(): Promise<void> {
    if (stopped || !scanner || !budgetStatePath) return;

    if (cfg.budget.dailyUsd === null && cfg.budget.monthlyUsd === null) {
      releaseHold();
      return;
    }
    await loadBudgetState();
    const spend = scanner.budgetSpend();
    holdAtLimit(spend, lastPassOutcome === 'complete');
    const { alerts, firedState } = evaluateBudget({
      budget: cfg.budget,
      todayUsd: spend.todayUsd,
      monthUsd: spend.monthUsd,
      todayKey: spend.todayKey,
      monthKey: spend.monthKey,
    }, budgetFiredState);
    for (const alert of alerts) {
      broadcast({
        type: 'usage-budget-alert',
        scope: alert.scope,
        threshold: alert.threshold,
        spentUsd: alert.spentUsd,
        budgetUsd: alert.budgetUsd,
        periodKey: alert.periodKey,
        text: budgetAlertText(alert),
        ts: nowFn(),
      });
      if (!await deliverBudgetTelegram(alert)) continue;
      for (const threshold of alert.thresholds) markFired(firedState, alert.scope, alert.periodKey, threshold);
    }
    budgetFiredState = firedState;
    await saveBudgetState();
  }

  function isHeld(): boolean {
    return budgetHold.kind === 'read' && budgetHold.holdReason !== null;
  }

  function releaseHold(): void {
    const wasHeld = isHeld() || budgetHoldReason() !== null;
    budgetHold = { kind: 'read', holdReason: null };
    if (wasHeld) onBudgetHold('end');
  }

  function holdAtLimit(spend: { todayUsd: unknown; monthUsd: unknown; todayKey: string; monthKey: string }, isSpendComplete: boolean): void {
    const rowsAtLimit = budgetScopesAtLimit({ budget: cfg.budget, todayUsd: spend.todayUsd, monthUsd: spend.monthUsd });
    if (rowsAtLimit.length === 0) {
      if (isSpendComplete) releaseHold();
      return;
    }
    const holdReason = `the ${rowsAtLimit.map((row) => `${row.scope} spend ${formatBudgetUsd(row.spentUsd)} reached its ${formatBudgetUsd(row.budgetUsd)} budget`).join(' and the ')}, so sessions are paused until the period rolls over`;
    budgetHold = { kind: 'read', holdReason };
    const next = pausedPeriodsAfter(rowsAtLimit, budgetPausedPeriods, { daily: spend.todayKey, monthly: spend.monthKey });
    budgetPausedPeriods = next.paused;
    const phase: BudgetHoldPhase = next.isNewPause ? 'start' : 'continue';
    const pausedNames = onBudgetHold(phase);
    if (phase === 'continue' && pausedNames.length === 0) return;
    laneLog.warn('budget reached, paused sessions', { holdReason, pausedSessions: pausedNames.join(', ') });
  }

  function budgetHoldReason(): string | null {
    if (stopped || !cfg.budget.pauseAtLimit) return null;
    const todayKey = clock.dayKeyOf(nowFn());
    const scopes = pausedScopesInPeriod(budgetPausedPeriods, { daily: todayKey, monthly: todayKey.slice(0, 7) });
    if (scopes.length === 0) return null;
    if (budgetHold.kind === 'read') return budgetHold.holdReason;
    return `the ${scopes.join(' and ')} budget was reached earlier this period, so sessions stay paused until it rolls over`;
  }

  async function flushNudgedSpend(): Promise<void> {
    while (passSettled !== null) await passSettled;
    if (!nudge.isArmed || stopped || !scanner) return;
    nudge.cancel();
    await runPassAndPush({ force: false, scopeDirs: takeNudgedTranscriptDirs() });
  }

  async function readBudgetHoldReason(): Promise<string | null> {
    if (cfg.budget.pauseAtLimit) await flushNudgedSpend();
    if (budgetStatePath && cfg.budget.pauseAtLimit) await loadBudgetState();
    return budgetHoldReason();
  }

  function startBudgetEvaluation(): Promise<void> {
    const evaluation = evaluateBudgetsOnce();
    const settled = evaluation.catch(() => {}).then(() => {
      if (budgetEvaluation.kind === 'running') budgetEvaluation = { kind: 'idle' };
    });
    budgetEvaluation = { kind: 'running', settled };
    return evaluation;
  }

  function evaluateBudgets(): Promise<void> {
    if (budgetEvaluation.kind === 'idle') return startBudgetEvaluation();
    if (budgetEvaluation.kind === 'running-queued') return budgetEvaluation.queued;
    const { settled } = budgetEvaluation;
    const queued = settled.then(() => startBudgetEvaluation());
    budgetEvaluation = { kind: 'running-queued', settled, queued };
    return queued;
  }

  function unavailableReport(requestId: string | null, error: string) {
    return { type: 'usage-report', requestId: requestId || null, ts: nowFn(), error };
  }

  async function requestReport(
    { days, force = false, requestId = null }: { days?: number; force?: boolean; requestId?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    await start();
    if (!scanner || !pricing) return unavailableReport(requestId, 'Usage tracking is disabled');

    const allowForce = force && nowFn() - lastForcedPassMs >= FORCE_PASS_MIN_INTERVAL_MS;
    if (allowForce) lastForcedPassMs = nowFn();
    if (force) await runPassAndPush({ force: allowForce });
    void pollKimiPlanLimits(KIMI_VIEWED_POLL_MS);
    let report: ReturnType<ReturnType<typeof createUsageScanner>['buildReport']>;
    try {
      report = scanner.buildReport({ days });
    } catch (error) {
      laneLog.warn('report build failed', { error: errorMessage(error) });
      return unavailableReport(requestId, `Usage report failed: ${errorMessage(error)}`);
    }
    const scanStats = scanner.stats();
    const cached = {
      type: 'usage-report',
      requestId: null,
      ts: report.ts,
      tz: report.tz,
      ranges: report.ranges,
      coverage: report.coverage,
      budget: report.budget,
      yourDay: report.yourDay,
      pricing: { source: pricing.source, fetchedAt: pricing.fetchedAt, missing: report.pricing.missing },
      scan: {
        dirs: report.scan.dirs,
        files: report.scan.files,
        entries: report.scan.entries,
        lastScanMs: report.scan.lastScanMs,
        partial: report.scan.partial,
        outcome: report.scan.outcome,
        ioFailures: report.scan.ioFailures,
      },
      warning: scanStats.resolutionError || null,
      error: null,
    };
    lastReportMessage = cached;
    return { ...cached, requestId: requestId || null };
  }

  function clearTimers(): void {
    if (intervalTimer) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
    nudge.cancel();
    if (continueTimer) {
      clearTimeoutFn(continueTimer);
      continueTimer = null;
    }
  }

  async function teardown(): Promise<void> {
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});

    clearTimers();
    startPromise = null;
    scanner = null;
    pricing = null;
    lastSessionsSignature = null;
    lastReportMessage = null;
  }

  function restartIfConfigChanged(): void {
    if (usageCfgKey(config) === lastKey) return;
    lastKey = usageCfgKey(config);
    void restartQueue.run(async () => {
      if (stopped) return;
      await teardown();
      if (!startRequested) return;
      await start();
    }).catch((error: unknown) => laneLog.warn('restart failed', { error: errorMessage(error) }));
  }

  async function stop(): Promise<void> {
    stopped = true;
    clearTimers();
    if (startPromise) await startPromise.catch(() => {});
    await restartQueue.idle();
    scanner = null;
  }

  return {
    start,
    stop,
    nudgeSession,
    refreshSessions,
    restartIfConfigChanged,
    getSessionsMessage,
    sessionUsageLookup,
    getCachedReport: () => lastReportMessage,
    requestReport,
    ingestStatusline,
    getPlanLimitsMessage,
    getAccountPlanLimitsMessages,
    getSessionMeterMessages,
    budgetHoldReason,
    readBudgetHoldReason,
  };
}

export { createUsageWiring, resolveUsageConfig, USAGE_WAREHOUSE_RETAIN_DAYS };
