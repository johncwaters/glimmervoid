import { clock } from '#shared/clock.ts';
import { numberOr, textOr } from '#shared/coerce.ts';
import type { UsageCoverageRow } from '#shared/contracts/usage-report.ts';
import type { YourDay } from '#shared/contracts/your-day.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { yourDayRecapLabel, yourDaySessionWord } from '#shared/your-day-text.ts';
import {
  NO_VALUE,
  formatCount,
  formatTokens,
  formatUsd,
  planLimitsBucketsOf,
  planLimitsVendorOf,
  planWindowOf,
  usageErrorLine,
} from './usage-store-core.ts';
import type { PlanLimits, PlanLimitsVendor, UsageReport } from './usage-store-core.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PLAN_LIMIT_STALE_MS = HOUR_MS;
const PROJECTION_MIN_ELAPSED_PCT = 10;
const PACE_WARN_PCT = 80;
const PACE_FAIL_PCT = 100;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const VENDOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
  pi: 'pi',
  opencode: 'OpenCode',
  grok: 'Grok',
});

const PACE_WINDOW_SPECS: Readonly<Record<'fiveHour' | 'sevenDay', { lengthMs: number; label: string; shortLabel: string }>> = Object.freeze({
  fiveHour: { lengthMs: 5 * HOUR_MS, label: '5 hour window', shortLabel: '5 hour' },
  sevenDay: { lengthMs: 7 * DAY_MS, label: 'weekly window', shortLabel: 'Weekly' },
});

const LIMIT_SOURCE_LABELS: Readonly<Record<UsageCoverageRow['limitSource'], string>> = Object.freeze({
  statusline: 'Reported by status line',
  transcript: 'Reported in transcripts',
  account: 'Read from Kimi account',
  agentstate: 'Reported by AgentState',
  none: 'Not kept locally',
});

const COST_SOURCE_LABELS: Readonly<Record<UsageCoverageRow['costSource'], string>> = Object.freeze({
  reported: 'Reported by agent',
  'list-price': 'List price',
});

type PaceTone = 'ok' | 'warn' | 'fail';

interface LimitWindowView {
  key: 'fiveHour' | 'sevenDay';
  label: string;
  shortLabel: string;
  usedPct: number;
  elapsedPct: number | null;
  projectedPct: number | null;
  runsOutAtMs: number | null;
  resetsAtMs: number | null;
  tone: PaceTone;
}

export interface LimitCardView {
  key: string;
  vendor: PlanLimitsVendor;
  vendorLabel: string;
  accountId: string | null;
  reportedAtMs: number | null;
  isStale: boolean;
  tone: PaceTone;
  binding: LimitWindowView;
  other: LimitWindowView | null;
}

interface CoverageRowView {
  vendor: string;
  vendorLabel: string;
  filesText: string;
  hasFiles: boolean;
  lastEntryMs: number | null;
  limitSourceText: string;
  hasLimits: boolean;
  costSourceText: string;
}

const LANE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  interactive: 'Interactive',
  'pr-review': 'PR review',
  'team-review': 'PR reviews',
  posthog: 'PostHog',
  'my-prs': 'Keep mergeable',
  workflows: 'Workflows',
  'change-map': 'Change map',
  benchmark: 'Benchmarks',
  'agent-spawn': 'Agent API',
  'task-title': 'Task titles',
  director: 'Studio director',
  other: 'Other',
});

export function vendorLabelOf(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

export function laneLabelOf(lane: string): string {
  return LANE_LABELS[lane] ?? lane;
}

export function spendDeltaText(
  rangeKey: 'today' | 'week' | 'month',
  currentCostUSD: number,
  previousCostUSD: number | null,
): string {
  if (previousCostUSD === null || previousCostUSD <= 0) return 'No prior period to compare';
  const pct = Math.round(((currentCostUSD - previousCostUSD) / previousCostUSD) * 100);
  const priorLabel = rangeKey === 'today' ? 'yesterday' : (rangeKey === 'week' ? 'the 7 days before' : 'the 30 days before');
  if (pct === 0) return `Flat on ${priorLabel}`;
  const direction = pct > 0 ? 'up' : 'down';
  return `${direction} ${Math.abs(pct)}% on ${priorLabel}`;
}

export function shortProjectLabel(project: string): string {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return normalized || '<unknown>';
  return parts.slice(-2).join('/');
}

export function isUsageUnavailable(report: UsageReport | null | undefined): boolean {
  return usageErrorLine(report).length > 0;
}

export function formatPercent(value: unknown): string {
  const numeric = numberOr(value, null);
  if (numeric === null) return NO_VALUE;
  return `${Math.round(numeric)}%`;
}

function formatMinutes(minutes: unknown): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return NO_VALUE;
  return twoUnitDurationText(Math.round(minutes) * 60, { smallestUnit: 'm', dropsZeroRemainder: true });
}

export function yourDayHint(yourDay: YourDay, now: number): string {
  const sessionCount = yourDay.yesterday.sessionCount;
  return `${yourDayRecapLabel(yourDay, now)}: ${sessionCount} ${yourDaySessionWord(sessionCount)}, ${formatMinutes(yourDay.yesterday.activeMs / 60_000)}`;
}

function paceToneOf(usedPct: number, projectedPct: number | null): PaceTone {
  if (usedPct >= PACE_FAIL_PCT) return 'fail';
  if (usedPct >= PACE_WARN_PCT) return 'warn';
  if (projectedPct !== null && projectedPct >= PACE_WARN_PCT) return 'warn';
  return 'ok';
}

function elapsedShareOf(lengthMs: number, resetsAtMs: number | null, now: number): number | null {
  if (resetsAtMs === null || resetsAtMs <= 0) return null;
  const startMs = resetsAtMs - lengthMs;
  return Math.min(Math.max(((now - startMs) / lengthMs) * 100, 0), 100);
}

function buildLimitWindow(
  key: 'fiveHour' | 'sevenDay',
  planLimits: PlanLimits,
  now: number,
): LimitWindowView | null {
  const window = planWindowOf(planLimits, key);
  if (!window || window.pct === null) return null;
  if (window.resetsAtMs !== null && window.resetsAtMs <= now) return null;
  const spec = PACE_WINDOW_SPECS[key];
  const elapsedPct = elapsedShareOf(spec.lengthMs, window.resetsAtMs, now);
  const canProject = elapsedPct !== null && elapsedPct >= PROJECTION_MIN_ELAPSED_PCT && window.pct < PACE_FAIL_PCT;
  const projectedPct = canProject ? window.pct / (elapsedPct / 100) : null;
  const startMs = window.resetsAtMs !== null ? window.resetsAtMs - spec.lengthMs : null;
  const runsOutAtMs = projectedPct !== null && projectedPct >= PACE_FAIL_PCT && startMs !== null
    ? Math.round(startMs + (spec.lengthMs * 100) / projectedPct)
    : null;
  return {
    key,
    label: spec.label,
    shortLabel: spec.shortLabel,
    usedPct: window.pct,
    elapsedPct,
    projectedPct,
    runsOutAtMs,
    resetsAtMs: window.resetsAtMs,
    tone: paceToneOf(window.pct, projectedPct),
  };
}

function windowPressure(window: LimitWindowView): number {
  return Math.max(window.usedPct, window.projectedPct ?? 0);
}

function cardPressure(card: LimitCardView): number {
  return windowPressure(card.binding);
}

function buildLimitCardFromReading(
  reading: PlanLimits,
  now: number,
  bucket?: { id: string; label: string; isSoleDefault: boolean },
): LimitCardView | null {
  const vendor = planLimitsVendorOf(reading);
  const fiveHour = buildLimitWindow('fiveHour', reading, now);
  const sevenDay = buildLimitWindow('sevenDay', reading, now);
  const windows = [fiveHour, sevenDay].filter((window): window is LimitWindowView => window !== null);
  if (windows.length === 0) return null;
  windows.sort((left, right) => windowPressure(right) - windowPressure(left) || right.usedPct - left.usedPct);
  const [binding, other = null] = windows;
  const reportedAtMs = numberOr(reading.ts, null);
  const isStale = reportedAtMs !== null && now - reportedAtMs >= PLAN_LIMIT_STALE_MS;
  const accountId = textOr(reading.accountId, null);
  const baseVendorLabel = vendorLabelOf(vendor);
  const showBucketKey = bucket !== undefined && !bucket.isSoleDefault;
  const key = showBucketKey ? `${vendor}:${accountId ?? 'default'}:${bucket.id}` : `${vendor}:${accountId ?? 'default'}`;
  const showBucketLabel = showBucketKey && bucket.label.toLowerCase() !== baseVendorLabel.toLowerCase();
  const vendorLabel = showBucketLabel ? `${baseVendorLabel} / ${bucket.label}` : baseVendorLabel;
  return {
    key,
    vendor,
    vendorLabel,
    accountId,
    reportedAtMs,
    isStale,
    tone: binding.tone,
    binding,
    other,
  };
}

function buildLimitCardsFromReading(reading: PlanLimits, now: number): LimitCardView[] {
  const buckets = planLimitsBucketsOf(reading);
  if (buckets.length === 0) {
    const singleCard = buildLimitCardFromReading(reading, now);
    return singleCard ? [singleCard] : [];
  }
  const vendor = planLimitsVendorOf(reading);
  const cards: LimitCardView[] = [];
  for (const bucket of buckets) {
    const isSoleDefault = buckets.length === 1 && bucket.id === vendor;
    const card = buildLimitCardFromReading(
      { ...reading, fiveHour: bucket.fiveHour ?? null, sevenDay: bucket.sevenDay ?? null },
      now,
      { id: bucket.id, label: bucket.label, isSoleDefault },
    );
    if (card) cards.push(card);
  }
  return cards;
}

export function limitCards(
  planLimitsByVendor: Readonly<Record<PlanLimitsVendor, PlanLimits | null>>,
  accountPlanLimits: readonly PlanLimits[],
  now: number,
): LimitCardView[] {
  const accountsByVendor = new Map<PlanLimitsVendor, PlanLimits[]>();
  for (const reading of accountPlanLimits) {
    const vendor = planLimitsVendorOf(reading);
    const list = accountsByVendor.get(vendor) ?? [];
    list.push(reading);
    accountsByVendor.set(vendor, list);
  }
  const cards: LimitCardView[] = [];
  for (const vendor of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
    const accountCards = (accountsByVendor.get(vendor) ?? [])
      .flatMap((reading) => buildLimitCardsFromReading(reading, now));
    if (accountCards.length > 0) {
      cards.push(...accountCards);
      continue;
    }
    const globalReading = planLimitsByVendor[vendor];
    if (globalReading) cards.push(...buildLimitCardsFromReading(globalReading, now));
  }
  return cards.sort((left, right) => cardPressure(right) - cardPressure(left) || left.vendorLabel.localeCompare(right.vendorLabel));
}

export function resetClockText(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs) || resetsAtMs <= 0 || Math.abs(resetsAtMs) > 8.64e15) return '';
  const hourMinuteText = clock.format(resetsAtMs, 'hour-minute');
  if (clock.dayKeyOf(resetsAtMs) === clock.dayKeyOf(now)) return hourMinuteText;
  const resetParts = clock.partsOf(resetsAtMs);
  if (resetsAtMs - now < 7 * DAY_MS && resetParts.weekday !== clock.partsOf(now).weekday) {
    return `${WEEKDAY_NAMES[resetParts.weekday]} ${hourMinuteText}`;
  }
  return `${MONTH_NAMES[resetParts.month - 1]} ${resetParts.day} ${hourMinuteText}`;
}

export function projectionLineText(window: LimitWindowView, now: number): string {
  const resetText = resetClockText(window.resetsAtMs, now);
  if (window.usedPct >= PACE_FAIL_PCT) {
    return resetText ? `Limit reached, resets ${resetText}` : 'Limit reached';
  }
  if (window.runsOutAtMs !== null) {
    const runOutClock = resetClockText(window.runsOutAtMs, now);
    if (runOutClock && resetText) return `Runs out about ${runOutClock}, resets ${resetText}`;
    if (runOutClock) return `Runs out about ${runOutClock}`;
  }
  if (window.projectedPct !== null) {
    const projected = `${Math.round(window.projectedPct)}%`;
    return resetText ? `About ${projected} at reset, ${resetText}` : `About ${projected} at reset`;
  }
  return resetText ? `Too early to project, resets ${resetText}` : 'Too early to project';
}

export function noLocalLimitsNote(coverage: readonly UsageCoverageRow[] | null | undefined): string {
  const rows = coverage ?? [];
  const names = rows.filter((row) => row.limitSource === 'none').map((row) => vendorLabelOf(row.vendor));
  if (names.length === 0) return '';
  const joined = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `No plan limits on this machine for ${joined}: they keep no limit data locally, so only spend shows below.`;
}

export function coverageRows(report: UsageReport | null | undefined): CoverageRowView[] {
  const rows = report?.coverage ?? [];
  return rows.map((row) => ({
    vendor: row.vendor,
    vendorLabel: vendorLabelOf(row.vendor),
    filesText: row.files > 0 ? `${formatCount(row.files)} ${row.files === 1 ? 'file' : 'files'}` : 'Not found',
    hasFiles: row.files > 0,
    lastEntryMs: row.lastEntryMs,
    limitSourceText: LIMIT_SOURCE_LABELS[row.limitSource],
    hasLimits: row.limitSource !== 'none',
    costSourceText: row.costSource === 'reported' ? `Reported by ${vendorLabelOf(row.vendor)}` : COST_SOURCE_LABELS[row.costSource],
  }));
}

export { NO_VALUE, formatCount, formatTokens, formatUsd };
