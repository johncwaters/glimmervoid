import type { UsageEntryLike, UsageTotals } from './usage-entry-core.ts';
import { addEntryToTotals, dedupKeys, emptyTotals, totalTokensOf } from './usage-entry-core.ts';
import type { UsageBreakdownRow, UsageDailyVendorRow, UsageRangeRollup, UsageReportRanges } from '../../../shared/contracts/usage-report.ts';
import { numberOr } from '../../../shared/coerce.ts';
import { clock } from '../../../shared/clock.ts';

interface VendorTotals {
  tokens: number;
  costUSD: number;
}

interface ModelBucket extends UsageTotals {
  key: string;
  model: string;
  vendor: string;
  entries: number;
}

interface DailyBucket extends UsageTotals {
  day: string;
  entries: number;
  modelByName: Map<string, ModelBucket>;
  vendorSet: Set<string>;
}

interface SessionBucket extends UsageTotals {
  id: string;
  name: string;
  project: string | null;
  vendor: string;
  entries: number;
  lastTs: number | null;
}

interface KnownSession {
  name?: string;
}

interface SerializedDailyBucket extends UsageTotals {
  day: string;
  entries: number;
  models: ModelBucket[];
  vendors: string[];
  source?: string;
}

function buildUsageReport(
  entries: UsageEntryLike[] | null | undefined,
  {
    now = clock.nowMs(),
    blockHours = 5,
    retainDays = 90,
    sessionsById = new Map<string, KnownSession>(),
    tz = null,
  }: {
    now?: number;
    blockHours?: number;
    retainDays?: number;
    sessionsById?: Map<string, KnownSession>;
    tz?: string | null;
  } = {},
) {
  const windowStartMs = clock.startOfDay(now, retainDays - 1);
  const keptEntries = (entries || []).filter((entry) => entry.timestampMs >= windowStartMs);
  const totals = emptyTotals();
  const dailyByDay = new Map<string, DailyBucket>();
  const modelByName = new Map<string, ModelBucket>();
  const sessionById = new Map<string, SessionBucket>();

  const byVendor = new Map<string, VendorTotals>();

  for (const entry of keptEntries) {
    addEntryToTotals(totals, entry);
    addEntryToVendorTotals(byVendor, entry);
    const day = clock.dayKeyOf(entry.timestampMs);
    addEntryToDailyBucket(dailyByDay, day, entry);
    addEntryToModelBucket(modelByName, entry.model || '<unknown>', entry);
    addEntryToSessionBucket(sessionById, entry, sessionsById);
  }

  return {
    ts: now,
    tz,
    blockHours,
    totals: { ...totals, byVendor: serializeVendorTotals(byVendor) },
    daily: Array.from(dailyByDay.values()).map(serializeDailyBucket).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens),
    sessions: Array.from(sessionById.values()).sort((a, b) => b.tokens - a.tokens),
  };
}

function vendorOf(entry: { vendor?: unknown } | null | undefined): string {
  const vendor = typeof entry?.vendor === 'string' ? entry.vendor.trim() : '';
  return vendor || 'claude';
}

function addEntryToVendorTotals(map: Map<string, VendorTotals>, entry: UsageEntryLike): void {
  const vendor = vendorOf(entry);
  const bucket = map.get(vendor) || { tokens: 0, costUSD: 0 };
  bucket.tokens += totalTokensOf(entry);
  bucket.costUSD += numberOr(entry.costUSD, 0);
  map.set(vendor, bucket);
}

function serializeVendorTotals(map: Map<string, VendorTotals>): Record<string, VendorTotals> {
  const wire: Record<string, VendorTotals> = {};
  for (const vendor of Array.from(map.keys()).sort()) {
    const totals = map.get(vendor);
    if (totals) wire[vendor] = { ...totals };
  }
  return wire;
}

function pruneEntries(
  entries: UsageEntryLike[] | null | undefined,
  { now = clock.nowMs(), retainDays = 90 }: { now?: number; retainDays?: number } = {},
): { kept: UsageEntryLike[]; removedKeys: string[] } {
  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  const kept: UsageEntryLike[] = [];
  const removedKeys: string[] = [];
  for (const entry of entries || []) {
    if (entry.timestampMs >= cutoff) {
      kept.push(entry);
      continue;
    }
    const keys = dedupKeys(entry);
    if (keys.primary) removedKeys.push(keys.primary);
  }
  return { kept, removedKeys };
}

function addEntryToDailyBucket(map: Map<string, DailyBucket>, day: string, entry: UsageEntryLike): void {
  const bucket: DailyBucket = map.get(day) || {
    day,
    ...emptyTotals(),
    entries: 0,
    modelByName: new Map<string, ModelBucket>(),
    vendorSet: new Set<string>(),
  };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  bucket.vendorSet.add(vendorOf(entry));
  addEntryToModelBucket(bucket.modelByName, entry.model || '<unknown>', entry);
  map.set(day, bucket);
}

function addEntryToModelBucket(map: Map<string, ModelBucket>, model: string, entry: UsageEntryLike): void {
  const bucket: ModelBucket = map.get(model) || { key: model, model, vendor: vendorOf(entry), ...emptyTotals(), entries: 0 };
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  map.set(model, bucket);
}

function addEntryToSessionBucket(
  map: Map<string, SessionBucket>,
  entry: UsageEntryLike,
  sessionsById: Map<string, KnownSession>,
): void {
  const key = entry.sessionId || '<unknown>';
  const knownSession = typeof sessionsById.get === 'function' ? sessionsById.get(key) : null;
  const entryProject = entry.cwd || entry.project || null;
  const bucket: SessionBucket = map.get(key) || {
    id: key,
    name: knownSession?.name || key,
    project: null,
    vendor: vendorOf(entry),
    ...emptyTotals(),
    entries: 0,
    lastTs: null,
  };
  if (bucket.project === null && entryProject) bucket.project = entryProject;
  addEntryToTotals(bucket, entry);
  bucket.entries += 1;
  bucket.lastTs = Math.max(bucket.lastTs || 0, entry.timestampMs);
  map.set(key, bucket);
}

function serializeDailyBucket(bucket: DailyBucket): SerializedDailyBucket {
  const { modelByName, vendorSet, ...wireBucket } = bucket;
  return {
    ...wireBucket,
    models: Array.from(modelByName.values()).sort((a, b) => b.tokens - a.tokens),
    vendors: Array.from(vendorSet || []).sort(),
  };
}

interface BreakdownAccumulator {
  key: string;
  label: string;
  costUSD: number;
  input: number;
  output: number;
  cacheRead: number;
  sessions: Set<string>;
}

interface RangeAccumulator {
  costUSD: number;
  previousCostUSD: number | null;
  dailyByDay: Map<string, Map<string, number>>;
  byAgent: Map<string, BreakdownAccumulator>;
  byModel: Map<string, BreakdownAccumulator>;
  byProject: Map<string, BreakdownAccumulator>;
  byLane: Map<string, BreakdownAccumulator>;
}

interface HistoryDailyLike {
  day: string;
  costUSD: number;
}

const LANE_OTHER = 'other';

function createRangeAccumulator(): RangeAccumulator {
  return {
    costUSD: 0,
    previousCostUSD: null,
    dailyByDay: new Map(),
    byAgent: new Map(),
    byModel: new Map(),
    byProject: new Map(),
    byLane: new Map(),
  };
}

function addPreviousCost(accumulator: RangeAccumulator, cost: number): void {
  accumulator.previousCostUSD = (accumulator.previousCostUSD ?? 0) + cost;
}

function addBreakdownEntry(
  buckets: Map<string, BreakdownAccumulator>,
  key: string,
  label: string,
  entry: UsageEntryLike,
  sessionKey: string,
): void {
  const bucket = buckets.get(key) ?? {
    key,
    label,
    costUSD: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    sessions: new Set<string>(),
  };
  bucket.costUSD += numberOr(entry.costUSD, 0);
  bucket.input += numberOr(entry.input, 0);
  bucket.output += numberOr(entry.output, 0);
  bucket.cacheRead += numberOr(entry.cacheRead, 0);
  if (sessionKey) bucket.sessions.add(sessionKey);
  buckets.set(key, bucket);
}

function addEntryToRange(
  accumulator: RangeAccumulator,
  entry: UsageEntryLike,
  dayKey: string,
  vendor: string,
  laneByKey: ReadonlyMap<string, string> | null,
): void {
  const cost = numberOr(entry.costUSD, 0);
  accumulator.costUSD += cost;
  const vendorCosts = accumulator.dailyByDay.get(dayKey) ?? new Map<string, number>();
  vendorCosts.set(vendor, (vendorCosts.get(vendor) ?? 0) + cost);
  accumulator.dailyByDay.set(dayKey, vendorCosts);

  const rawSessionId = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : '';
  const sessionKey = rawSessionId ? `${vendor}:${rawSessionId}` : '';
  addBreakdownEntry(accumulator.byAgent, vendor, vendor, entry, sessionKey);
  const modelKey = entry.model || '<unknown>';
  addBreakdownEntry(accumulator.byModel, modelKey, modelKey, entry, sessionKey);
  const projectKey = entry.cwd || entry.project || '<unknown>';
  addBreakdownEntry(accumulator.byProject, projectKey, projectKey, entry, sessionKey);
  if (laneByKey) {
    const lane = sessionKey ? (laneByKey.get(sessionKey) ?? LANE_OTHER) : LANE_OTHER;
    addBreakdownEntry(accumulator.byLane, lane, lane, entry, sessionKey);
  }
}

function serializeBreakdowns(buckets: Map<string, BreakdownAccumulator>): UsageBreakdownRow[] {
  return Array.from(buckets.values())
    .map((bucket) => {
      const totalInput = bucket.input + bucket.cacheRead;
      const cacheHitPct = totalInput > 0 ? Math.round((bucket.cacheRead / totalInput) * 100) : null;
      return {
        key: bucket.key,
        label: bucket.label,
        costUSD: bucket.costUSD,
        input: bucket.input,
        output: bucket.output,
        cacheHitPct,
        sessions: bucket.sessions.size,
      };
    })
    .sort((left, right) => right.costUSD - left.costUSD || (right.input + right.output) - (left.input + left.output) || left.label.localeCompare(right.label));
}

function serializeRangeRollup(
  accumulator: RangeAccumulator,
  dayKeys: readonly string[],
  historyDaySet: ReadonlySet<string>,
  includeLanes: boolean,
): UsageRangeRollup {
  const daily: UsageDailyVendorRow[] = dayKeys.map((day) => {
    const vendorMap = accumulator.dailyByDay.get(day);
    const costByVendor: Record<string, number> = {};
    if (vendorMap) {
      for (const vendor of Array.from(vendorMap.keys()).sort()) {
        const amount = vendorMap.get(vendor);
        if (amount !== undefined && amount > 0) costByVendor[vendor] = amount;
      }
    }
    const row: UsageDailyVendorRow = { day, costByVendor };
    if (historyDaySet.has(day)) row.source = 'history';
    return row;
  });
  return {
    costUSD: accumulator.costUSD,
    previousCostUSD: accumulator.previousCostUSD,
    daily,
    byAgent: serializeBreakdowns(accumulator.byAgent),
    byModel: serializeBreakdowns(accumulator.byModel),
    byProject: serializeBreakdowns(accumulator.byProject),
    byLane: includeLanes ? serializeBreakdowns(accumulator.byLane) : null,
  };
}

function calendarDayKeys(now: number, count: number): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(clock.dayKeyOf(clock.startOfDay(now, offset)));
  }
  return keys;
}

function buildRangeRollups(
  entries: UsageEntryLike[] | null | undefined,
  {
    now = clock.nowMs(),
    laneByKey = null,
    historyDaily = [],
  }: {
    now?: number;
    laneByKey?: ReadonlyMap<string, string> | null;
    historyDaily?: readonly HistoryDailyLike[];
  } = {},
): UsageReportRanges {
  const todayStartMs = clock.startOfDay(now, 0);
  const prevTodayStartMs = clock.startOfDay(now, 1);
  const weekStartMs = clock.startOfDay(now, 6);
  const prevWeekStartMs = clock.startOfDay(now, 13);
  const monthStartMs = clock.startOfDay(now, 29);
  const prevMonthStartMs = clock.startOfDay(now, 59);

  const today = createRangeAccumulator();
  const week = createRangeAccumulator();
  const month = createRangeAccumulator();
  const liveDays = new Set<string>();

  for (const entry of entries || []) {
    const ts = entry.timestampMs;
    if (ts < prevMonthStartMs) continue;
    const cost = numberOr(entry.costUSD, 0);
    const vendor = vendorOf(entry);
    const dayKey = clock.dayKeyOf(ts);
    liveDays.add(dayKey);

    if (ts >= todayStartMs) {
      addEntryToRange(today, entry, dayKey, vendor, laneByKey);
    }
    if (ts >= prevTodayStartMs && ts < todayStartMs) addPreviousCost(today, cost);

    if (ts >= weekStartMs) {
      addEntryToRange(week, entry, dayKey, vendor, laneByKey);
    }
    if (ts >= prevWeekStartMs && ts < weekStartMs) addPreviousCost(week, cost);

    if (ts >= monthStartMs) {
      addEntryToRange(month, entry, dayKey, vendor, laneByKey);
    }
    if (ts >= prevMonthStartMs && ts < monthStartMs) addPreviousCost(month, cost);
  }

  const todayDayKey = clock.dayKeyOf(todayStartMs);
  const prevTodayDayKey = clock.dayKeyOf(prevTodayStartMs);
  const weekDayKeys = calendarDayKeys(now, 7);
  const prevWeekStartKey = clock.dayKeyOf(prevWeekStartMs);
  const monthDayKeys = calendarDayKeys(now, 30);
  const prevMonthStartKey = clock.dayKeyOf(prevMonthStartMs);
  const weekStartKey = weekDayKeys[0];
  const monthStartKey = monthDayKeys[0];
  const historyDaySet = new Set<string>();

  for (const row of historyDaily) {
    if (liveDays.has(row.day)) continue;
    const cost = numberOr(row.costUSD, 0);
    if (cost <= 0) continue;
    if (row.day === todayDayKey) {
      today.dailyByDay.set(row.day, new Map([['claude', cost]]));
      today.costUSD += cost;
      historyDaySet.add(row.day);
    }
    if (row.day === prevTodayDayKey) addPreviousCost(today, cost);
    if (row.day >= weekStartKey && row.day <= todayDayKey) {
      week.dailyByDay.set(row.day, new Map([['claude', cost]]));
      week.costUSD += cost;
      historyDaySet.add(row.day);
    }
    if (row.day >= prevWeekStartKey && row.day < weekStartKey) addPreviousCost(week, cost);
    if (row.day >= monthStartKey && row.day <= todayDayKey) {
      month.dailyByDay.set(row.day, new Map([['claude', cost]]));
      month.costUSD += cost;
      historyDaySet.add(row.day);
    }
    if (row.day >= prevMonthStartKey && row.day < monthStartKey) addPreviousCost(month, cost);
  }

  const includeLanes = laneByKey !== null && laneByKey.size > 0;
  return {
    today: serializeRangeRollup(today, [todayDayKey], historyDaySet, includeLanes),
    week: serializeRangeRollup(week, weekDayKeys, historyDaySet, includeLanes),
    month: serializeRangeRollup(month, monthDayKeys, historyDaySet, includeLanes),
  };
}

export { buildRangeRollups, buildUsageReport, pruneEntries, vendorOf };
