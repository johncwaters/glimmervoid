import { localDayKey, localHourMinuteText, twoUnitDurationText } from '#shared/display-text.ts';
import { numberOr, textOr } from '#shared/coerce.ts';
import { formatCount, formatTokens, formatUsd, limitPct, NO_VALUE, planWindowOf, projectedLimitPct, trimTrailingZeros, usageErrorLine } from './usage-store-core.ts';
import type { CacheSavings, PlanLimits, PlanLimitsVendor, PlanWindow, UsageAnomaly, UsageBlock, UsageBudgetRow, UsageBurn, UsageProjection, UsageReport, UsageSavings, UsageTokenLimit, UsageTotals } from './usage-store-core.ts';

export { blockAttentionTone, budgetRowPct, budgetRows, formatTokens, formatUsd, limitPct, planWindowOf, RANGE_OPTIONS, tokenLimitTone, usageErrorLine } from './usage-store-core.ts';
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

export function formatMinutes(minutes: unknown) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return NO_VALUE;
  return twoUnitDurationText(Math.round(minutes) * 60, { smallestUnit: 'm', dropsZeroRemainder: true });
}

export function blockLabel(startTs: unknown) {
  const ts = Number(startTs);
  if (!Number.isFinite(ts) || ts <= 0) return NO_VALUE;
  const date = new Date(ts);
  const month = MONTH_NAMES[date.getMonth()];
  if (!month) return NO_VALUE;
  return `${month} ${date.getDate()} ${localHourMinuteText(date)}`;
}

export function burnTiles(burn: UsageBurn | null | undefined) {
  if (!burn || typeof burn !== 'object') return [];
  const tiles: { label: string; value: string; sub: string }[] = [];
  if (Number.isFinite(burn.tokensPerMinute)) {
    const sub = Number.isFinite(burn.tokensPerMinuteExCache)
      ? `${formatTokens(burn.tokensPerMinuteExCache)} excluding cache`
      : '';
    tiles.push({ label: 'tokens per min', value: formatTokens(burn.tokensPerMinute), sub });
  }
  if (Number.isFinite(burn.costPerHour)) {
    tiles.push({ label: 'cost per hour', value: formatUsd(burn.costPerHour), sub: '' });
  }
  return tiles;
}

export function projectionLine(projection: UsageProjection | null | undefined) {
  if (!projection || typeof projection !== 'object') return '';
  const totals: string[] = [];
  if (Number.isFinite(projection.projectedTokens)) totals.push(`${formatTokens(projection.projectedTokens)} tokens`);
  if (Number.isFinite(projection.projectedCostUSD)) totals.push(formatUsd(projection.projectedCostUSD));
  const remaining = Number.isFinite(projection.remainingMinutes)
    ? `${formatMinutes(projection.remainingMinutes)} left in this block`
    : '';
  if (totals.length === 0) return remaining;
  const head = `-> ${totals.join(', ')} by block end`;
  if (!remaining) return head;
  return `${head}, ${remaining}`;
}

export function blockProgress(block: UsageBlock | null | undefined, now = Date.now()) {
  const start = Number(block?.startTs);
  const end = Number(block?.endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const totalMinutes = (end - start) / 60000;
  const elapsedMinutes = Math.min(Math.max((now - start) / 60000, 0), totalMinutes);
  const remainingMinutes = Math.max(totalMinutes - elapsedMinutes, 0);
  return {
    totalMinutes,
    elapsedMinutes,
    remainingMinutes,
    pct: Math.round((elapsedMinutes / totalMinutes) * 100),
  };
}

export function tokenLimitLine(tokenLimit: UsageTokenLimit | null | undefined) {
  const pct = limitPct(tokenLimit);
  if (pct === null) return '';
  return `${Math.round(pct)}% of ${formatTokens(tokenLimit?.max)} tokens, the largest completed block seen`;
}

export function projectionLimitLine(projection: UsageProjection | null | undefined, tokenLimit: UsageTokenLimit | null | undefined) {
  const pct = projectedLimitPct(projection, tokenLimit);
  if (pct === null) return '';
  if (pct >= 100) return `On this burn rate the block ends past that reference, at ${Math.round(pct)}% of it.`;
  return `On this burn rate the block ends at ${Math.round(pct)}% of that reference.`;
}

const COMPOSITION_PARTS = Object.freeze([
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheCreate', label: 'cache write' },
  { key: 'cacheRead', label: 'cache read' },
]);

export function compositionParts(totals: UsageTotals | null | undefined) {
  const parts = COMPOSITION_PARTS.map((spec) => {
    const raw = Number(totals?.[spec.key as keyof UsageTotals]);
    return { spec, tokens: Number.isFinite(raw) && raw > 0 ? raw : 0 };
  });
  const sum = parts.reduce((total, part) => total + part.tokens, 0);
  if (sum <= 0) return [];
  return parts.map((part) => {
    const pct = percentOfTotal(part.tokens, sum) ?? 0;
    const value = formatTokens(part.tokens);
    return { key: part.spec.key, label: part.spec.label, value, pct, title: `${part.spec.label} ${value}, ${formatPercent(pct)}` };
  });
}

const LANE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  interactive: 'Interactive',
  'pr-review': 'PR review',
  'team-review': 'PR reviews',
  posthog: 'PostHog',
  'my-prs': 'Keep mergeable',
  workflows: 'Workflows',
  'change-map': 'Change map',
  visions: 'Visions',
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

export function prReviewsSpendTile(report: UsageReport | null | undefined) {
  if (!Array.isArray(report?.byLane)) return null;
  const row = laneRows(report).find((candidate) => candidate.lane === PR_REVIEWS_LANE);
  const costUSD = numberOr(row?.costUSD, 0);
  const tokens = numberOr(row?.tokens, 0);
  const basis = shareBasis(report?.totals);
  const share = percentOfTotal(basis === 'costUSD' ? costUSD : tokens, report?.totals?.[basis]);
  const shareText = share === null ? '' : `${formatPercent(share)} of range ${basis === 'costUSD' ? 'cost' : 'tokens'}`;
  const sub = [formatUsd(costUSD), shareText, laneSessionsText(row?.sessions)].filter(Boolean).join(', ');
  return { label: laneLabel(PR_REVIEWS_LANE), value: formatTokens(tokens), sub };
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

export function hasSavings(savings: UsageSavings | null | undefined) {
  return cacheSavings(savings) !== null;
}

export function cacheSavingsTile(savings: UsageSavings | null | undefined) {
  const cache = cacheSavings(savings);
  if (!cache) return null;
  const tokens = formatTokens(numberOr(cache.cacheReadTokens, 0));
  const unpricedModels: unknown[] = Array.isArray(cache.unpricedModels) ? cache.unpricedModels : [];
  const unpriced = unpricedModels.filter((model) => model);
  const sub = `${tokens} cache read tokens`;
  if (unpriced.length === 0) return { value: formatUsd(numberOr(cache.savedUSD, 0)), sub };

  const noun = unpriced.length === 1 ? 'model' : 'models';
  return {
    value: formatUsd(numberOr(cache.savedUSD, 0)),
    sub: `${sub}, a floor (${unpriced.length} unpriced ${noun})`,
  };
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

export function anomalyLine(anomaly: UsageAnomaly | null | undefined) {
  return [dailyAnomalySentence(anomaly?.daily), burnAnomalySentence(anomaly?.burn)].filter(Boolean).join(' ');
}

export function anomalyTone(anomaly: UsageAnomaly | null | undefined) {
  if (anomaly?.daily || anomaly?.burn) return 'warn';
  return 'ok';
}

export function hasAnomaly(anomaly: UsageAnomaly | null | undefined) {
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

export function vendorTotalsRows(totals: UsageTotals | null | undefined) {
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

export function hasMultiVendorUsage(totals: UsageTotals | null | undefined) {
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

export function planLimitsSectionHint(vendors: readonly PlanLimitsVendor[], totals: UsageTotals | null | undefined) {
  const labels = PLAN_LIMIT_VENDORS.filter(({ vendor }) => vendors.includes(vendor)).map(({ label }) => label);
  const provenance = `official, from ${labels.join(' and ')}`;
  const isClaudeAlone = vendors.length === 1 && vendors[0] === 'claude';
  const claudeOnly = isClaudeAlone ? claudeOnlyHint(totals) : '';
  return claudeOnly ? `${provenance}, ${claudeOnly}` : provenance;
}

export function hasOfficialPlanLimits(planLimits: PlanLimits | null | undefined) {
  return PLAN_WINDOWS.some((window) => planWindowOf(planLimits, window.key) !== null);
}

export function provenanceLabel(source: unknown) {
  if (source === 'estimated') return 'estimated from the largest completed block';
  return '';
}

export function planWindowUsedText(window: PlanWindow | null | undefined) {
  const pct = numberOr(window?.pct, null);
  if (pct === null) return NO_VALUE;
  return `${formatPercent(pct)} used`;
}

export function resetCountdownText(resetsAtMs: unknown, now = Date.now()) {
  const resetsAt = numberOr(resetsAtMs, null);
  if (resetsAt === null || resetsAt <= 0) return '';
  const remainingMinutes = (resetsAt - now) / 60000;
  if (remainingMinutes <= 0) return 'resetting now';
  return `resets in ${formatMinutes(remainingMinutes)}`;
}

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

export function sessionRowLabel(row: UsageWireRow | null | undefined) {
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

export const DEFAULT_SESSION_SORT: Readonly<SortState> = Object.freeze({ key: 'lastTs', dir: 'desc' });
export const DEFAULT_MODEL_SORT: Readonly<SortState> = Object.freeze({ key: 'tokens', dir: 'desc' });
export const DEFAULT_DAY_SORT: Readonly<SortState> = Object.freeze({ key: 'day', dir: 'desc' });

export function sortSessionRows(rows: unknown, sort: Readonly<SortState> = DEFAULT_SESSION_SORT) {
  return sortUsageRows(rows, sort.key, sort.dir, sessionRowLabel);
}

export function visibleSessionRows(sortedRows: unknown, expanded: boolean, limit: number = SESSION_ROW_LIMIT): { rows: UsageWireRow[]; hiddenCount: number } {
  if (!Array.isArray(sortedRows)) return { rows: [], hiddenCount: 0 };
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
