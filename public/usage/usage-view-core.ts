import { localDayKey, localHourMinuteText, twoUnitDurationText } from '#shared/display-text.ts';
import { numberOr, textOr } from '#shared/coerce.ts';
import { formatCount, formatTokens, formatUsd, NO_VALUE, planWindowOf, RANGE_OPTIONS, trimTrailingZeros, usageErrorLine } from './usage-store-core.ts';
import type { YourDay } from '#shared/contracts/your-day.ts';
import type { CacheSavings, PlanLimits, PlanLimitsVendor, UsageAnomaly, UsageBlock, UsageBudgetRow, UsageReport, UsageSavings, UsageTotals } from './usage-store-core.ts';

export { budgetRowPct, budgetRows, formatTokens, formatUsd, RANGE_OPTIONS, usageErrorLine } from './usage-store-core.ts';
export type { PlanLimits, UsageTotals } from './usage-store-core.ts';

interface UsageModelRow {
  key?: string;
  model?: string | null;
  vendor?: string;
  tokens?: number;
  costUSD?: number;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}

export type UsageWireRow = Record<string, unknown>;

interface UsageLaneRow {
  lane?: unknown;
  sessions?: unknown;
  tokens?: unknown;
  costUSD?: unknown;
}

interface HeatmapCell {
  day: string;
  week: number;
  weekday: number;
  tokens: number;
  costUSD: number;
  source: string | null;
  noData: boolean;
  tone: number;
}

export const USAGE_CAVEAT_SHORT = 'Estimated list prices, not a bill.';

export const USAGE_DISABLED_HINT = 'Enable in Settings.';

export const SESSION_ROW_LIMIT = 10;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT_SORT_KEYS = new Set(['day', 'model', 'label']);

const ASC_BY_DEFAULT_KEYS = new Set(['model', 'label']);

export function formatPercent(pct: unknown) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return NO_VALUE;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${trimTrailingZeros(pct.toFixed(1))}%`;
}

export function shareBasis(totals: UsageTotals | null | undefined) {
  const cost = Number(totals?.costUSD);
  if (Number.isFinite(cost) && cost > 0) return 'costUSD';
  return 'tokens';
}

export function shareLabel(basis: string) {
  if (basis === 'costUSD') return 'share of cost';
  return 'share of tokens';
}

export function percentOfTotal(value: unknown, total: unknown) {
  const part = Number(value);
  const whole = Number(total);
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

function dayLabel(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return String(day ?? '') || NO_VALUE;
  const month = MONTH_NAMES[Number(parts[2]) - 1];
  if (!month) return String(day);
  return `${month} ${Number(parts[3])}`;
}

export function dayRangeLabel(days: unknown) {
  const keys = dayKeysOf(days);
  if (keys.length === 0) return '';
  if (keys.length === 1) return dayLabel(keys[0]);
  return `${dayLabel(keys[0])} to ${dayLabel(keys[keys.length - 1])}`;
}

function dayKeysOf(days: unknown) {
  const entries: unknown[] = Array.isArray(days) ? days : [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { day?: unknown } | null | undefined)?.day))
    .map((key) => String(key ?? ''))
    .filter((key) => DAY_KEY_RE.test(key))
    .sort();
}

export function reportDayKey(report: UsageReport | null | undefined) {
  const ts = Number(report?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  return dayKeyInZone(ts, typeof report?.tz === 'string' && report.tz ? report.tz : null);
}

function dayKeyInZone(ts: number, tz: string | null) {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (tz) options.timeZone = tz;
  const formatted = safeZoneFormat(ts, options);
  if (DAY_KEY_RE.test(formatted)) return formatted;
  return safeZoneFormat(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function safeZoneFormat(ts: number, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-CA', options).format(new Date(ts));
  } catch {
    return '';
  }
}

function formatMinutes(minutes: unknown) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return NO_VALUE;
  return twoUnitDurationText(Math.round(minutes) * 60, { smallestUnit: 'm', dropsZeroRemainder: true });
}

export function yourDayHint(yourDay: YourDay, now: number) {
  const yesterdayKey = localDayKey(now - 86_400_000);
  const [, month, day] = yourDay.yesterday.day.split('-').map(Number);
  const dayLabel = yourDay.yesterday.day === yesterdayKey ? 'yesterday' : `${MONTH_NAMES[month - 1]} ${day}`;
  const sessionWord = yourDay.yesterday.sessionCount === 1 ? 'session' : 'sessions';
  return `${dayLabel}: ${yourDay.yesterday.sessionCount} ${sessionWord}, ${formatMinutes(yourDay.yesterday.activeMs / 60_000)}`;
}

export function blockLabel(startTs: unknown) {
  const ts = Number(startTs);
  if (!Number.isFinite(ts) || ts <= 0) return NO_VALUE;
  const date = new Date(ts);
  const month = MONTH_NAMES[date.getMonth()];
  if (!month) return NO_VALUE;
  return `${month} ${date.getDate()} ${localHourMinuteText(date)}`;
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
  other: 'Other',
});

export const LANE_SCOPE_HINT = 'Sessions spawned by Glimmervoid; terminal sessions count as other';
export const OVERHEAD_SCOPE_HINT = 'Claude sessions Glimmervoid spawned for its own work; plan share is estimated pro rata by cost';

export function laneLabel(lane: unknown) {
  const key = textOr(lane, '');
  if (!key) return LANE_LABELS.other;
  return LANE_LABELS[key] || key;
}

export function laneRows(report: UsageReport | null | undefined): UsageLaneRow[] {
  const rows = report?.byLane;
  if (!Array.isArray(rows)) return [];
  return (rows as UsageLaneRow[]).filter((row) => row && typeof row.lane === 'string');
}

function isGlimmervoidLane(lane: unknown) {
  if (typeof lane !== 'string') return false;
  const key = lane.trim();
  return key !== '' && key !== 'interactive' && key !== 'other';
}

export function hasLaneAttribution(report: UsageReport | null | undefined) {
  return laneRows(report).some((row) => isGlimmervoidLane(row.lane));
}

interface OverheadLane {
  lane: string;
  label: string;
  tokens: number;
  costUSD: number;
}

interface OverheadWindow {
  key: 'fiveHour' | 'sevenDay';
  label: string;
  tokens: number;
  costUSD: number;
  sharePct: number | null;
  planPct: number | null;
  lanes: OverheadLane[];
}

const OVERHEAD_WINDOW_LABELS: Readonly<Record<'fiveHour' | 'sevenDay', string>> = Object.freeze({
  fiveHour: 'This 5 hour block',
  sevenDay: '7 day window',
});

function livePlanUsedPct(planLimits: PlanLimits | null | undefined, key: 'fiveHour' | 'sevenDay', now: number) {
  const planWindow = planWindowOf(planLimits, key);
  if (!planWindow) return null;
  const hasWindowReset = planWindow.resetsAtMs !== null && planWindow.resetsAtMs <= now;
  if (hasWindowReset) return null;
  return planWindow.pct;
}

function overheadWindowOf(
  key: 'fiveHour' | 'sevenDay',
  rawRows: unknown,
  planLimits: PlanLimits | null | undefined,
  now: number,
): OverheadWindow | null {
  if (!Array.isArray(rawRows)) return null;
  const rows = (rawRows as UsageLaneRow[]).filter((row) => row && typeof row.lane === 'string');
  const totalCostUSD = rows.reduce((sum, row) => sum + numberOr(row.costUSD, 0), 0);
  const totalTokens = rows.reduce((sum, row) => sum + numberOr(row.tokens, 0), 0);
  const lanes = rows
    .filter((row) => isGlimmervoidLane(row.lane))
    .map((row) => ({ lane: String(row.lane), label: laneLabel(row.lane), tokens: numberOr(row.tokens, 0), costUSD: numberOr(row.costUSD, 0) }));
  const costUSD = lanes.reduce((sum, lane) => sum + lane.costUSD, 0);
  const tokens = lanes.reduce((sum, lane) => sum + lane.tokens, 0);
  const sharePct = totalCostUSD > 0 ? percentOfTotal(costUSD, totalCostUSD) : percentOfTotal(tokens, totalTokens);
  const planUsedPct = livePlanUsedPct(planLimits, key, now);
  const planPct = sharePct === null || planUsedPct === null ? null : (sharePct / 100) * planUsedPct;
  return { key, label: OVERHEAD_WINDOW_LABELS[key], tokens, costUSD, sharePct, planPct, lanes };
}

export function glimmervoidOverhead(
  report: UsageReport | null | undefined,
  planLimits: PlanLimits | null | undefined,
  now = Date.now(),
): OverheadWindow[] {
  const windows = report?.planWindowLanes;
  if (!windows || typeof windows !== 'object') return [];
  return PLAN_WINDOWS
    .map((spec) => overheadWindowOf(spec.key, windows[spec.key], planLimits, now))
    .filter((window): window is OverheadWindow => window !== null);
}

export function overheadPlanText(window: OverheadWindow) {
  if (window.planPct === null) return '';
  return `about ${formatPercent(window.planPct)} of plan`;
}

export function overheadLanesText(window: OverheadWindow) {
  return window.lanes
    .filter((lane) => lane.costUSD > 0 || lane.tokens > 0)
    .map((lane) => `${lane.label} ${lane.costUSD > 0 ? formatUsd(lane.costUSD) : formatTokens(lane.tokens)}`)
    .join(', ');
}

const PR_REVIEWS_LANE = 'team-review';

function prReviewsSentence(report: UsageReport | null | undefined) {
  if (!Array.isArray(report?.byLane)) return '';
  const row = laneRows(report).find((candidate) => candidate.lane === PR_REVIEWS_LANE);
  const costUSD = numberOr(row?.costUSD, 0);
  if (costUSD <= 0) return '';
  const share = percentOfTotal(costUSD, report?.totals?.costUSD);
  const shareText = share === null ? '' : `, ${formatPercent(share)} of this period`;
  return `PR reviews cost ${formatUsd(costUSD)}${shareText}.`;
}

export function laneSessionsText(sessions: unknown) {
  const count = numberOr(sessions, null);
  if (count === null || count <= 0) return '';
  return `${formatCount(count)} ${count === 1 ? 'session' : 'sessions'}`;
}

function cacheSavings(savings: UsageSavings | null | undefined): CacheSavings | null {
  const cache = savings?.cache;
  if (!cache || typeof cache !== 'object') return null;
  return cache;
}

function cacheSavingsSentence(savings: UsageSavings | null | undefined) {
  const cache = cacheSavings(savings);
  if (!cache) return '';
  const savedUSD = numberOr(cache.savedUSD, 0);
  if (savedUSD <= 0) return '';
  const unpricedModels: unknown[] = Array.isArray(cache.unpricedModels) ? cache.unpricedModels : [];
  const unpricedCount = unpricedModels.filter((model) => model).length;
  const floorText = unpricedCount === 0 ? '' : `, at least, since ${unpricedCount} ${unpricedCount === 1 ? 'model has' : 'models have'} no price`;
  return `Prompt caching saved ${formatUsd(savedUSD)}${floorText}, across ${formatTokens(numberOr(cache.cacheReadTokens, 0))} cache read tokens.`;
}

export function budgetScopeLabel(scope: unknown) {
  if (scope === 'monthly') return 'this month';
  return 'today';
}

export function budgetRowText(row: UsageBudgetRow | null | undefined) {
  return `${formatUsd(numberOr(row?.spentUsd, 0))} of ${formatUsd(numberOr(row?.budgetUsd, 0))}`;
}

export function budgetRowMeterLabel(row: UsageBudgetRow | null | undefined) {
  return `${budgetScopeLabel(row?.scope)} spend against budget`;
}

export const PERIOD_VIEWS = Object.freeze([
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
]);
export const DEFAULT_PERIOD_VIEW = 'day';

function parseDayKey(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return null;

  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12);
}

function weekStartKey(day: unknown) {
  const date = parseDayKey(day);
  if (!date) return '';
  const dayOfWeek = date.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return localDayKey(date);
}

export function monthKey(day: unknown) {
  const parts = DAY_KEY_RE.exec(String(day ?? ''));
  if (!parts) return '';
  return `${parts[1]}-${parts[2]}`;
}

interface PeriodModelRow {
  key: string;
  model: string;
  vendor?: string;
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface PeriodBucket {
  key: string;
  tokens: number;
  costUSD: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  days: number;
  sources: Set<string>;
  vendorSet: Set<string>;
  modelByName: Map<string, PeriodModelRow>;
}

function emptyPeriodBucket(key: string): PeriodBucket {
  return {
    key,
    tokens: 0,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    days: 0,
    sources: new Set<string>(),
    vendorSet: new Set<string>(),
    modelByName: new Map<string, PeriodModelRow>(),
  };
}

function addDayToPeriod(bucket: PeriodBucket, row: UsageWireRow | null | undefined) {
  bucket.tokens += numberOr(row?.tokens, 0);
  bucket.costUSD += numberOr(row?.costUSD, 0);
  bucket.input += numberOr(row?.input, 0);
  bucket.output += numberOr(row?.output, 0);
  bucket.cacheCreate += numberOr(row?.cacheCreate, 0);
  bucket.cacheRead += numberOr(row?.cacheRead, 0);
  bucket.days += 1;
  bucket.sources.add(row?.source === 'history' ? 'history' : 'live');

  const vendors: string[] = Array.isArray(row?.vendors) ? row.vendors : [];
  for (const vendor of vendors) bucket.vendorSet.add(vendor);
  const modelRows = (row?.models || []) as UsageModelRow[];
  for (const model of modelRows) {
    if (model?.vendor) bucket.vendorSet.add(model.vendor);
    const name = modelLabel(model);
    const existing: PeriodModelRow = bucket.modelByName.get(name) || { key: name, model: model?.model ?? name, vendor: model?.vendor, tokens: 0, costUSD: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    existing.tokens += numberOr(model?.tokens, 0);
    existing.costUSD += numberOr(model?.costUSD, 0);
    existing.input += numberOr(model?.input, 0);
    existing.output += numberOr(model?.output, 0);
    existing.cacheCreate += numberOr(model?.cacheCreate, 0);
    existing.cacheRead += numberOr(model?.cacheRead, 0);
    bucket.modelByName.set(name, existing);
  }
}

function serializePeriodBucket(bucket: PeriodBucket): UsageWireRow {
  const { modelByName, sources, vendorSet, ...rest } = bucket;
  const row: UsageWireRow = { ...rest };
  row.day = bucket.key;
  row.models = Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens);
  row.source = sources.has('live') ? 'live' : 'history';
  row.vendors = Array.from(vendorSet).sort();
  return row;
}

function rollupByPeriod(daily: unknown, keyOf: (day: unknown) => string): UsageWireRow[] {
  const buckets = new Map<string, PeriodBucket>();
  const dailyRows: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  for (const row of dailyRows) {
    const key = keyOf(row?.day);
    if (!key) continue;
    const bucket = buckets.get(key) || emptyPeriodBucket(key);
    addDayToPeriod(bucket, row);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).map(serializePeriodBucket);
}

function weeklyRows(daily: unknown) {
  return rollupByPeriod(daily, weekStartKey);
}

function monthlyRows(daily: unknown) {
  return rollupByPeriod(daily, monthKey);
}

export function periodRows(daily: unknown, view: string): UsageWireRow[] {
  if (view === 'week') return weeklyRows(daily);
  if (view === 'month') return monthlyRows(daily);
  return Array.isArray(daily) ? [...daily] : [];
}

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

export function periodLabel(key: unknown, view: string) {
  if (view === 'month') {
    const parts = MONTH_KEY_RE.exec(String(key ?? ''));
    if (!parts) return String(key ?? '') || NO_VALUE;
    const month = MONTH_NAMES[Number(parts[2]) - 1];
    if (!month) return String(key);
    return `${month} ${parts[1]}`;
  }
  if (view === 'week') {
    const label = dayLabel(key);
    return label === NO_VALUE ? label : `week of ${label}`;
  }
  return dayLabel(key);
}

export function historyNote(rows: unknown) {
  const list: UsageWireRow[] = Array.isArray(rows) ? rows : [];
  const hasHistory = list.some((row) => row?.source === 'history');
  if (!hasHistory) return '';
  return 'older days from local history';
}

const HEATMAP_WEEKS = 16;
const HEATMAP_TONE_FRACTIONS = Object.freeze([0.05, 0.25, 0.5, 0.75]);
export const HEATMAP_DAY_LABELS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

function heatmapTone(tokens: unknown, max: unknown) {
  const value = numberOr(tokens, 0);
  const peak = numberOr(max, 0);
  if (value <= 0 || peak <= 0) return 0;
  const share = value / peak;
  let tone = 1;
  for (let index = 0; index < HEATMAP_TONE_FRACTIONS.length; index += 1) {
    if (share >= HEATMAP_TONE_FRACTIONS[index]) tone = index + 1;
  }
  return tone;
}

export function heatmapCells(
  daily: unknown,
  { weeks = HEATMAP_WEEKS, today = new Date() }: { weeks?: number; today?: Date | number | string } = {}
): { cells: HeatmapCell[]; max: number; weeks: number } {
  const dailyRows: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  const rows = dailyRows.filter((row) => DAY_KEY_RE.test(String(row?.day ?? '')));
  const byDay = new Map(rows.map((row): [string, UsageWireRow] => [String(row.day), row]));
  const suppliedToday = today instanceof Date ? today : new Date(today);
  const fallbackToday = Number.isFinite(suppliedToday.getTime()) ? suppliedToday : new Date();
  const todayKey = typeof today === 'string' && DAY_KEY_RE.test(today)
    ? today
    : localDayKey(fallbackToday);
  const anchor = parseDayKey(weekStartKey(todayKey));
  if (!anchor) return { cells: [], max: 0, weeks: 0 };
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (weeks - 1) * 7, 12);
  const startKey = localDayKey(start);
  const cells: HeatmapCell[] = [];

  let max = 0;
  let firstDay: string | null = null;
  for (const row of rows) {
    const rowDay = String(row.day);
    if (firstDay === null || rowDay < firstDay) firstDay = rowDay;
    if (rowDay < startKey || rowDay > todayKey) continue;
    max = Math.max(max, numberOr(row.tokens, 0));
  }
  for (let week = 0; week < weeks; week += 1) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + week * 7 + weekday, 12);
      const key = localDayKey(date);
      const row = byDay.get(key) || null;
      const beyondToday = key > todayKey;
      const beforeSeries = firstDay !== null && key < firstDay;
      cells.push({
        day: key,
        week,
        weekday,
        tokens: numberOr(row?.tokens, 0),
        costUSD: numberOr(row?.costUSD, 0),
        source: row?.source === 'history' ? 'history' : row ? 'live' : null,

        noData: beyondToday || beforeSeries || (!row && firstDay === null),
        tone: heatmapTone(row?.tokens, max),
      });
    }
  }
  return { cells, max, weeks };
}

export function heatmapCellTitle(cell: Partial<HeatmapCell> | null | undefined) {
  const label = dayLabel(cell?.day);
  if (cell?.noData) return `${label}: no data`;
  const tokens = numberOr(cell?.tokens, 0);
  if (tokens <= 0) return `${label}: no usage`;
  return `${label}: ${formatTokens(tokens)} tokens, ${formatUsd(numberOr(cell?.costUSD, 0))}`;
}

function dailyAnomalySentence(daily: UsageAnomaly['daily']) {
  if (!daily) return '';
  const days = numberOr(daily.baselineDays, null);
  const window = days === null ? 'recent' : `${Math.round(days)} day`;
  return `Today is ${formatRatio(daily.ratio)} the ${window} average: ${formatUsd(daily.todayUsd)} against ${formatUsd(daily.baselineUsd)}.`;
}

function burnAnomalySentence(burn: UsageAnomaly['burn']) {
  if (!burn) return '';
  return `This block is burning ${formatRatio(burn.ratio)} the usual rate: ${formatTokens(burn.current)} tokens per minute against ${formatTokens(burn.baseline)}.`;
}

function anomalyLine(anomaly: UsageAnomaly | null | undefined) {
  return [dailyAnomalySentence(anomaly?.daily), burnAnomalySentence(anomaly?.burn)].filter(Boolean).join(' ');
}

function hasAnomaly(anomaly: UsageAnomaly | null | undefined) {
  return Boolean(anomaly?.daily || anomaly?.burn);
}

function formatRatio(ratio: unknown) {
  const value = numberOr(ratio, null);
  if (value === null) return NO_VALUE;
  return `${trimTrailingZeros(value.toFixed(1))}x`;
}

const VENDOR_LABELS: Readonly<Record<string, string>> = Object.freeze({ claude: 'Claude', codex: 'Codex', grok: 'Grok', kimi: 'Kimi' });

export function vendorLabel(vendor: unknown) {
  const key = textOr(vendor, '');
  if (!key) return VENDOR_LABELS.claude;
  return VENDOR_LABELS[key] || key;
}

export function modelRowPrefix(row: { vendor?: unknown } | null | undefined, totals: UsageTotals | null | undefined) {
  if (!hasMultiVendorUsage(totals)) return '';
  return vendorLabel(row?.vendor);
}

function vendorTotalsRows(totals: UsageTotals | null | undefined) {
  const byVendor = totals?.byVendor;
  if (!byVendor || typeof byVendor !== 'object') return [];
  return Object.keys(byVendor)
    .filter((vendor) => byVendor[vendor] && typeof byVendor[vendor] === 'object')
    .sort((left, right) => numberOr(byVendor[right]?.tokens, 0) - numberOr(byVendor[left]?.tokens, 0))
    .map((vendor) => ({
      vendor,
      label: vendorLabel(vendor),
      tokens: numberOr(byVendor[vendor]?.tokens, 0),
      costUSD: numberOr(byVendor[vendor]?.costUSD, 0),
    }));
}

function hasMultiVendorUsage(totals: UsageTotals | null | undefined) {
  const byVendor = totals?.byVendor;
  if (!byVendor || typeof byVendor !== 'object') return false;
  const vendors = Object.keys(byVendor).filter((vendor) => byVendor[vendor] && typeof byVendor[vendor] === 'object');
  if (vendors.length > 1) return true;
  return vendors.length === 1 && vendors[0] !== 'claude';
}

const CLAUDE_ONLY_HINT = 'Claude only';

export function claudeOnlyHint(totals: UsageTotals | null | undefined) {
  if (!hasMultiVendorUsage(totals)) return '';
  return CLAUDE_ONLY_HINT;
}

const PLAN_LIMIT_STALE_MS = 60 * 60 * 1000;

export const PLAN_WINDOWS: readonly { key: 'fiveHour' | 'sevenDay'; label: string }[] = Object.freeze([
  { key: 'fiveHour', label: '5 hour' },
  { key: 'sevenDay', label: '7 day' },
]);

export const PLAN_LIMIT_VENDORS: readonly { vendor: PlanLimitsVendor; label: string }[] = Object.freeze([
  { vendor: 'claude', label: 'Claude Code' },
  { vendor: 'codex', label: 'Codex' },
  { vendor: 'kimi', label: 'Kimi Code' },
]);

export function planLimitAgeText(ts: unknown, now = Date.now()) {
  const stamped = numberOr(ts, null);
  if (stamped === null || stamped <= 0) return '';
  const minutes = Math.max(0, Math.round((now - stamped) / 60000));
  return `${minutes}m old`;
}

function isPlanLimitStale(ts: unknown, now = Date.now()) {
  const stamped = numberOr(ts, null);
  if (stamped === null || stamped <= 0) return true;
  return now - stamped > PLAN_LIMIT_STALE_MS;
}

export function planLimitStaleNote(ts: unknown, now = Date.now()) {
  if (!isPlanLimitStale(ts, now)) return '';
  const age = planLimitAgeText(ts, now);
  if (!age) return 'showing last-known usage';
  return `showing last-known usage (${age})`;
}

export function missingPricingLine(missing: unknown) {
  const entries: unknown[] = Array.isArray(missing) ? missing : [];
  const models = entries.map((m) => String(m)).filter((m) => m);
  if (models.length === 0) return '';
  const noun = models.length === 1 ? 'model' : 'models';
  return `No price for ${models.length} ${noun}: ${models.join(', ')}. Their cost counts as zero here.`;
}

export function usageWarningLine(report: UsageReport | null | undefined) {
  const warning = textOr(report?.warning, '');
  if (!warning) return '';
  return `Glimmervoid could not read every transcript location: ${warning}`;
}

export function isUsageUnavailable(report: UsageReport | null | undefined) {
  return usageErrorLine(report) !== '';
}

function projectBasename(path: unknown) {
  const text = String(path ?? '').trim();
  if (!text) return '';
  const segments = text.split(/[\\/]+/).filter((part) => part);
  if (segments.length === 0) return text;
  return segments[segments.length - 1];
}

export function isGlimmervoidSessionRow(row: UsageWireRow | null | undefined) {
  return typeof row?.id === 'string' && row.id !== '';
}

function sessionRowLabel(row: UsageWireRow | null | undefined) {
  const label = textOr(row?.label, '');
  if (isGlimmervoidSessionRow(row) && label) return label;
  const project = projectBasename(row?.project);
  if (project) return project;
  if (label) return label;
  return 'unknown project';
}

export function modelLabel(row: unknown) {
  const model = typeof row === 'string' ? row : (row as { model?: unknown } | null | undefined)?.model;
  return textOr(model, 'unknown model');
}

function dayKeyOf(row: UsageWireRow | null | undefined) {
  return String(row?.day ?? '');
}

function sortValueOf(row: UsageWireRow, key: string, labelOf: (row: UsageWireRow) => string): string | number {
  if (!TEXT_SORT_KEYS.has(key)) {
    const numeric = Number(row?.[key]);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  if (key === 'day') return dayKeyOf(row);
  return labelOf(row);
}

function sortUsageRows(
  rows: unknown,
  key: string,
  dir: string,
  labelOf: (row: UsageWireRow) => string = sessionRowLabel
): UsageWireRow[] {
  const list: UsageWireRow[] = Array.isArray(rows) ? [...rows] : [];
  const sign = dir === 'asc' ? 1 : -1;
  return list.sort((a, b) => {
    const left = sortValueOf(a, key, labelOf);
    const right = sortValueOf(b, key, labelOf);
    if (typeof left === 'string' || typeof right === 'string') {
      return sign * String(left).localeCompare(String(right));
    }
    if (left !== right) return sign * (left - right);
    const leftTokens = Number(a?.tokens);
    const rightTokens = Number(b?.tokens);
    const leftSafe = Number.isFinite(leftTokens) ? leftTokens : 0;
    const rightSafe = Number.isFinite(rightTokens) ? rightTokens : 0;
    if (leftSafe !== rightSafe) return rightSafe - leftSafe;
    return labelOf(a).localeCompare(labelOf(b));
  });
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

function defaultSortDir(key: string): 'asc' | 'desc' {
  return ASC_BY_DEFAULT_KEYS.has(key) ? 'asc' : 'desc';
}

export function nextSortState(current: SortState | null | undefined, key: string): SortState {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: defaultSortDir(key) };
}

export function ariaSortValue(current: SortState | null | undefined, key: string) {
  if (current?.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

const DEFAULT_SESSION_SORT: Readonly<SortState> = Object.freeze({ key: 'lastTs', dir: 'desc' });
const DEFAULT_MODEL_SORT: Readonly<SortState> = Object.freeze({ key: 'tokens', dir: 'desc' });
const COST_SORT: Readonly<SortState> = Object.freeze({ key: 'costUSD', dir: 'desc' });
export const DEFAULT_DAY_SORT: Readonly<SortState> = Object.freeze({ key: 'day', dir: 'desc' });

function sortSessionRows(rows: unknown, sort: Readonly<SortState> = DEFAULT_SESSION_SORT) {
  return sortUsageRows(rows, sort.key, sort.dir, sessionRowLabel);
}

export function visibleSessionRows<Row>(sortedRows: readonly Row[], expanded: boolean, limit: number = SESSION_ROW_LIMIT): { rows: readonly Row[]; hiddenCount: number } {
  const maxRows = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : SESSION_ROW_LIMIT;
  if (expanded || sortedRows.length <= maxRows) return { rows: sortedRows, hiddenCount: 0 };
  return {
    rows: sortedRows.slice(0, maxRows),
    hiddenCount: sortedRows.length - maxRows,
  };
}

export function sessionOverflowText(hiddenCount: unknown) {
  const hidden = Number(hiddenCount);
  if (!Number.isFinite(hidden) || hidden <= 0) return '';
  return `${formatCount(hidden)} hidden`;
}

export function sortModelRows(models: unknown, sort: Readonly<SortState> = DEFAULT_MODEL_SORT) {
  return sortUsageRows(models, sort.key, sort.dir, modelLabel);
}

export function sortDailyRows(daily: unknown, sort: Readonly<SortState> = DEFAULT_DAY_SORT) {
  return sortUsageRows(daily, sort.key, sort.dir, dayKeyOf);
}

export function dailyRowForDay(daily: unknown, day: unknown): UsageWireRow | null {
  const list: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  return list.find((row) => String(row?.day ?? '') === String(day ?? '')) || null;
}

export function blockHistoryRows(blocks: unknown, limit = 8) {
  const rows: UsageBlock[] = Array.isArray(blocks) ? blocks : [];
  const list = rows.filter((block) => block && block.isGap !== true);
  const sorted = list.sort((a, b) => (Number(b?.startTs) || 0) - (Number(a?.startTs) || 0));
  return sorted.slice(0, Math.max(0, limit)).map((block) => ({
    startTs: Number(block.startTs),
    tokens: typeof block.tokens === 'number' && Number.isFinite(block.tokens) ? block.tokens : 0,
    costUSD: typeof block.costUSD === 'number' && Number.isFinite(block.costUSD) ? block.costUSD : 0,
    isActive: block.isActive === true,
  }));
}

type PaceTone = 'ok' | 'warn' | 'fail';

export interface PaceWindow {
  vendor: PlanLimitsVendor;
  vendorLabel: string;
  key: 'fiveHour' | 'sevenDay';
  windowLabel: string;
  usedPct: number;
  elapsedPct: number | null;
  projectedPct: number | null;
  resetsAtMs: number | null;
  tone: PaceTone;
}

interface PaceVerdict {
  tone: PaceTone;
  headline: string;
  detail: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PACE_WINDOW_SPECS: Readonly<Record<'fiveHour' | 'sevenDay', { lengthMs: number; label: string }>> = Object.freeze({
  fiveHour: { lengthMs: 5 * HOUR_MS, label: '5-hour' },
  sevenDay: { lengthMs: 7 * DAY_MS, label: 'weekly' },
});
const PROJECTION_MIN_ELAPSED_PCT = 10;
const PACE_WARN_PCT = 80;
const PACE_FAIL_PCT = 100;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function paceToneOf(usedPct: number, projectedPct: number | null): PaceTone {
  if (usedPct >= PACE_FAIL_PCT) return 'fail';
  if (usedPct >= PACE_WARN_PCT) return 'warn';
  if (projectedPct !== null && projectedPct >= PACE_WARN_PCT) return 'warn';
  return 'ok';
}

function elapsedShareOf(lengthMs: number, resetsAtMs: number | null, now: number) {
  if (resetsAtMs === null || resetsAtMs <= 0) return null;
  const startMs = resetsAtMs - lengthMs;
  return Math.min(Math.max(((now - startMs) / lengthMs) * 100, 0), 100);
}

function paceWindow(vendor: PlanLimitsVendor, key: 'fiveHour' | 'sevenDay', planLimits: PlanLimits | null | undefined, now: number): PaceWindow | null {
  const window = planWindowOf(planLimits, key);
  if (!window || window.pct === null) return null;
  if (window.resetsAtMs !== null && window.resetsAtMs <= now) return null;
  const spec = PACE_WINDOW_SPECS[key];
  const elapsedPct = elapsedShareOf(spec.lengthMs, window.resetsAtMs, now);
  const canProject = elapsedPct !== null && elapsedPct >= PROJECTION_MIN_ELAPSED_PCT && window.pct < PACE_FAIL_PCT;
  const projectedPct = canProject ? window.pct / (elapsedPct / 100) : null;
  return {
    vendor,
    vendorLabel: PLAN_LIMIT_VENDORS.find((entry) => entry.vendor === vendor)?.label || vendor,
    key,
    windowLabel: spec.label,
    usedPct: window.pct,
    elapsedPct,
    projectedPct,
    resetsAtMs: window.resetsAtMs,
    tone: paceToneOf(window.pct, projectedPct),
  };
}

export function paceWindows(planLimitsByVendor: Readonly<Record<PlanLimitsVendor, PlanLimits | null>>, now: number): PaceWindow[] {
  return PLAN_LIMIT_VENDORS.flatMap(({ vendor }) =>
    PLAN_WINDOWS.map(({ key }) => paceWindow(vendor, key, planLimitsByVendor[vendor], now)).filter((window) => window !== null),
  );
}

export function resetClockText(resetsAtMs: unknown, now: number) {
  const resetsAt = numberOr(resetsAtMs, null);
  if (resetsAt === null || resetsAt <= 0) return '';
  const date = new Date(resetsAt);
  const clock = localHourMinuteText(date);
  if (localDayKey(resetsAt) === localDayKey(now)) return clock;
  if (resetsAt - now < 7 * DAY_MS && date.getDay() !== new Date(now).getDay()) return `${WEEKDAY_NAMES[date.getDay()]} ${clock}`;
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()} ${clock}`;
}

function roundedPercentText(pct: number) {
  return `${Math.round(pct)}%`;
}

function pacePressure(window: PaceWindow) {
  return Math.max(window.usedPct, window.projectedPct ?? 0);
}

function tightestWindowByVendor(windows: readonly PaceWindow[]) {
  const tightestByVendor = new Map<PlanLimitsVendor, PaceWindow>();
  for (const window of windows) {
    const tightest = tightestByVendor.get(window.vendor);
    if (!tightest || window.usedPct > tightest.usedPct) tightestByVendor.set(window.vendor, window);
  }
  return [...tightestByVendor.values()];
}

function roomSentence(windows: readonly PaceWindow[], excludedVendor: PlanLimitsVendor) {
  const others = tightestWindowByVendor(windows).filter((window) => window.vendor !== excludedVendor && window.tone !== 'fail');
  if (others.length === 0) return '';
  const roomiest = [...others].sort((left, right) => left.usedPct - right.usedPct)[0];
  return `${roomiest.vendorLabel} has ${roundedPercentText(100 - roomiest.usedPct)} of its ${roomiest.windowLabel} window left.`;
}

function untilResetText(resetsAtMs: number | null, now: number) {
  const clock = resetClockText(resetsAtMs, now);
  if (!clock || resetsAtMs === null) return 'until the window resets';
  return `until ${clock}, in ${formatMinutes((resetsAtMs - now) / 60000)}`;
}

function reachedVerdict(window: PaceWindow, windows: readonly PaceWindow[], now: number): PaceVerdict {
  const detail = [`${window.vendorLabel} sessions stop answering ${untilResetText(window.resetsAtMs, now)}. Their worktrees and conversations stay intact.`, roomSentence(windows, window.vendor)];
  return { tone: 'fail', headline: `${window.vendorLabel} ${window.windowLabel} limit reached.`, detail: detail.filter(Boolean).join(' ') };
}

function tightVerdict(window: PaceWindow, now: number): PaceVerdict {
  const clock = resetClockText(window.resetsAtMs, now);
  const resetText = clock ? `, resets ${clock}` : '';
  if (window.usedPct >= PACE_WARN_PCT) {
    return { tone: 'warn', headline: `${window.vendorLabel} ${window.windowLabel} limit is at ${roundedPercentText(window.usedPct)}.`, detail: `Little room left before it resets${resetText}.` };
  }
  const by = clock ? ` by ${clock}` : '';
  return {
    tone: 'warn',
    headline: `${window.vendorLabel} will be tight${by}.`,
    detail: `At this pace its ${window.windowLabel} window ends at ${roundedPercentText(window.projectedPct ?? window.usedPct)}.`,
  };
}

function overBudgetVerdict(row: UsageBudgetRow): PaceVerdict {
  return { tone: 'warn', headline: `Over your ${budgetScopeLabel(row.scope) === 'today' ? 'daily' : 'monthly'} budget.`, detail: `${budgetRowText(row)} spent ${budgetScopeLabel(row.scope)}.` };
}

export function paceVerdict(windows: readonly PaceWindow[], budgets: readonly UsageBudgetRow[], todayCostUSD: number | null, now: number): PaceVerdict {
  const reached = windows.find((window) => window.tone === 'fail');
  if (reached) return reachedVerdict(reached, windows, now);
  const tight = windows.filter((window) => window.tone === 'warn').sort((left, right) => pacePressure(right) - pacePressure(left))[0];
  if (tight) return tightVerdict(tight, now);
  const overBudget = budgets.find((row) => numberOr(row.pct, 0) >= 100);
  if (overBudget) return overBudgetVerdict(overBudget);
  if (windows.length === 0) {
    const spent = todayCostUSD === null ? 'Nothing spent yet today.' : `${formatUsd(todayCostUSD)} spent today.`;
    return { tone: 'ok', headline: spent, detail: 'No agent has reported a current plan limit, so this tab tracks estimated spend only.' };
  }
  const closest = [...windows].sort((left, right) => pacePressure(right) - pacePressure(left))[0];
  const clock = resetClockText(closest.resetsAtMs, now);
  return {
    tone: 'ok',
    headline: 'Every limit has room.',
    detail: `Closest is ${closest.vendorLabel} ${closest.windowLabel} at ${roundedPercentText(closest.usedPct)}${clock ? `, resets ${clock}` : ''}.`,
  };
}

export function paceSubText(window: PaceWindow) {
  if (window.tone === 'fail') return 'limit reached';
  if (window.projectedPct === null) return window.elapsedPct === null ? '' : 'too early to project';
  return `about ${roundedPercentText(window.projectedPct)} at reset`;
}

export type UsageDetailScreen = 'report' | 'history' | 'overhead' | 'budgets';
export type UsageScreen = 'overview' | UsageDetailScreen;
export const DEFAULT_DETAIL_SCREEN: UsageDetailScreen = 'report';

export function rangeLabel(rangeValue: string) {
  return RANGE_OPTIONS.find((option) => option.value === rangeValue)?.label || '';
}

export function topModelSummary(report: UsageReport | null | undefined) {
  const rows = sortModelRows(report?.models, COST_SORT);
  const top = rows[0];
  if (!top) return null;
  const basis = shareBasis(report?.totals);
  return { label: modelLabel(top), sharePct: percentOfTotal(top[basis], report?.totals?.[basis]) };
}

export function sessionsSummary(report: UsageReport | null | undefined) {
  const rows = sortSessionRows(report?.sessions, COST_SORT);
  const top = rows[0];
  return { count: rows.length, topLabel: top ? sessionRowLabel(top) : '' };
}

export function glimmervoidLaneCostUSD(report: UsageReport | null | undefined) {
  const lanes = laneRows(report).filter((row) => isGlimmervoidLane(row.lane));
  if (lanes.length === 0) return null;
  return lanes.reduce((sum, row) => sum + numberOr(row.costUSD, 0), 0);
}

export function budgetSummary(rows: readonly UsageBudgetRow[]) {
  const overCount = rows.filter((row) => numberOr(row.pct, 0) >= 100).length;
  const underCount = rows.length - overCount;
  if (overCount === 0) return { value: `${underCount} of ${rows.length}`, detail: rows.length === 1 ? 'under its ceiling' : 'all under their ceilings' };
  return { value: `${underCount} of ${rows.length}`, detail: overCount === 1 ? '1 over its ceiling' : `${overCount} over their ceilings` };
}

export function historyDayCount(daily: unknown) {
  return dayKeysOf(daily).length;
}

export function periodDayKeys(todayKey: string, days: number) {
  const today = parseDayKey(todayKey);
  if (!today || days <= 0) return [];
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));
    return localDayKey(date);
  });
}

export function rangeDays(rangeValue: string) {
  return RANGE_OPTIONS.find((option) => option.value === rangeValue)?.days ?? 7;
}

export function nextPaceResetMs(windows: readonly PaceWindow[]) {
  return windows.reduce<number | null>((earliest, window) => {
    if (window.resetsAtMs === null) return earliest;
    return earliest === null ? window.resetsAtMs : Math.min(earliest, window.resetsAtMs);
  }, null);
}

interface PeriodBar {
  day: string;
  label: string;
  costUSD: number;
  isToday: boolean;
}

export interface PeriodSummary {
  costUSD: number;
  deltaPct: number | null;
  averageUSD: number;
  peakUSD: number;
  bars: PeriodBar[];
}

interface ReportInsight {
  text: string;
  tone: 'ok' | 'warn';
}

interface RankedRow {
  row: UsageWireRow;
  label: string;
  costUSD: number;
  sharePct: number | null;
  barPct: number;
}

function shiftedDayKey(dayKey: string, offsetDays: number) {
  const date = parseDayKey(dayKey);
  if (!date) return '';
  date.setDate(date.getDate() + offsetDays);
  return localDayKey(date);
}

function costByDayOf(daily: unknown) {
  const rows: UsageWireRow[] = Array.isArray(daily) ? daily : [];
  const costByDay = new Map<string, number>();
  for (const row of rows) {
    const day = String(row?.day ?? '');
    if (!DAY_KEY_RE.test(day)) continue;
    costByDay.set(day, (costByDay.get(day) ?? 0) + numberOr(row?.costUSD, 0));
  }
  return costByDay;
}

function periodBarLabel(day: string, days: number) {
  const date = parseDayKey(day);
  if (!date) return day;
  if (days <= 7) return WEEKDAY_NAMES[date.getDay()];
  return String(date.getDate());
}

export function periodSummary(daily: unknown, days: number, todayKey: string): PeriodSummary {
  const costByDay = costByDayOf(daily);
  const bars = periodDayKeys(todayKey, days).map((day) => ({ day, label: periodBarLabel(day, days), costUSD: costByDay.get(day) ?? 0, isToday: day === todayKey }));
  const costUSD = bars.reduce((sum, bar) => sum + bar.costUSD, 0);
  const previousDayKeys = periodDayKeys(shiftedDayKey(todayKey, -days), days);
  const previousCostUSD = previousDayKeys.reduce((sum, day) => sum + (costByDay.get(day) ?? 0), 0);
  const hasPreviousPeriod = previousDayKeys.some((day) => costByDay.has(day)) && previousCostUSD > 0;
  return {
    costUSD,
    deltaPct: hasPreviousPeriod ? ((costUSD - previousCostUSD) / previousCostUSD) * 100 : null,
    averageUSD: bars.length > 0 ? costUSD / bars.length : 0,
    peakUSD: bars.reduce((peak, bar) => Math.max(peak, bar.costUSD), 0),
    bars,
  };
}

export function periodDeltaText(summary: PeriodSummary, days: number) {
  if (summary.deltaPct === null) return '';
  const previousPeriod = days === 1 ? 'yesterday' : `the ${days} days before`;
  const roundedPct = Math.round(Math.abs(summary.deltaPct));
  if (roundedPct === 0) return `About the same as ${previousPeriod}`;
  return `${roundedPct}% ${summary.deltaPct < 0 ? 'less' : 'more'} than ${previousPeriod}`;
}

export function periodAverageText(summary: PeriodSummary) {
  return `${formatUsd(summary.averageUSD)} a day on average`;
}

export function vendorSplitText(totals: UsageTotals | null | undefined) {
  if (!hasMultiVendorUsage(totals)) return '';
  return vendorTotalsRows(totals).map((row) => `${row.label} ${formatUsd(row.costUSD)}`).join(', ');
}

export function reportInsights(report: UsageReport | null | undefined): ReportInsight[] {
  const yourDayInsights = report?.yourDay?.insights ?? [];
  const insights: ReportInsight[] = yourDayInsights.map((insight) => ({ text: insight.text, tone: 'ok' }));
  const anomaly = report?.anomaly;
  if (hasAnomaly(anomaly)) insights.push({ text: anomalyLine(anomaly), tone: 'warn' });
  for (const text of [cacheSavingsSentence(report?.savings), prReviewsSentence(report)]) {
    if (text) insights.push({ text, tone: 'ok' });
  }
  return insights;
}

function rankedRows(rows: UsageWireRow[], totals: UsageTotals | null | undefined, labelOf: (row: UsageWireRow) => string): RankedRow[] {
  const basis = shareBasis(totals);
  const peak = rows.reduce((best, row) => Math.max(best, numberOr(row[basis], 0)), 0);
  return rows.map((row) => ({
    row,
    label: labelOf(row),
    costUSD: numberOr(row.costUSD, 0),
    sharePct: percentOfTotal(row[basis], totals?.[basis]),
    barPct: percentOfTotal(row[basis], peak) ?? 0,
  }));
}

export function rankedModels(report: UsageReport | null | undefined) {
  return rankedRows(sortModelRows(report?.models, COST_SORT), report?.totals, modelLabel);
}

export function rankedSessions(report: UsageReport | null | undefined) {
  return rankedRows(sortSessionRows(report?.sessions, COST_SORT), report?.totals, sessionRowLabel);
}

export function modelTokenMix(row: UsageWireRow) {
  return [
    { label: 'Input', tokens: numberOr(row.input, 0) },
    { label: 'Output', tokens: numberOr(row.output, 0) },
    { label: 'Cache write', tokens: numberOr(row.cacheCreate, 0) },
    { label: 'Cache read', tokens: numberOr(row.cacheRead, 0) },
  ];
}
