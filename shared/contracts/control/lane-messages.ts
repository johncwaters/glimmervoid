import { z } from 'zod';
import { YourDay } from '../your-day.ts';
import { UsageBudget, UsageCoverageRow, UsagePricing, UsageReportRanges, UsageScanSummary } from '../usage-report.ts';
import { AgentAccountId } from '../agent-accounts.ts';
import { requestId, sessionId, loose, looseCollection, openObject, nullableString, timestamp, optionalTimestamp, optionalError, PlanLimitsVendor } from './control-fields.ts';

export const SessionMeterReading = z.object({
  model: z.string().nullable(),
  effort: z.string().nullable(),
  contextTokens: z.number().nonnegative().nullable(),
  contextWindow: z.number().positive().nullable(),
  callCostUSD: z.number().nonnegative().nullable(),
  outputStyle: z.string().nullable(),
});
export type SessionMeterReading = z.infer<typeof SessionMeterReading>;

export const laneClientVariants = [
  loose('request-usage-report', { requestId, days: z.unknown().optional(), force: z.unknown().optional() }),
] as const;

const PlanLimitBucket = z.object({
  id: z.string(),
  label: z.string(),
  fiveHour: z.unknown().nullable(),
  sevenDay: z.unknown().nullable(),
});

export const laneServerVariants = [
  looseCollection('usage-sessions', {
    ts: timestamp,
    pricingSource: nullableString,
    yourDay: YourDay.nullable().default(null),
    sessions: z.array(openObject({
      id: sessionId,
      name: z.string().optional(),
      vendor: z.string().optional(),
      model: z.string().nullable().optional(),
      tokens: z.number(),
      costUSD: z.number(),
      lastHourCostUSD: z.number().optional(),
      cacheHitPct: z.number().nullable().optional(),
      officialCostUSD: z.number().nullable().optional(),
    })),
  }),
  looseCollection('usage-report', {
    requestId,
    ts: optionalTimestamp,
    tz: z.string().optional(),
    ranges: UsageReportRanges.optional(),
    coverage: z.array(UsageCoverageRow).optional(),
    budget: UsageBudget.nullable().optional(),
    yourDay: YourDay.nullable().optional(),
    pricing: UsagePricing.optional(),
    scan: UsageScanSummary.optional(),
    warning: optionalError,
    error: optionalError,
  }),
  looseCollection('plan-limits', {
    ts: timestamp,
    fiveHour: z.unknown().nullable(),
    sevenDay: z.unknown().nullable(),
    buckets: z.array(PlanLimitBucket).optional(),
    source: z.string(),
    vendor: PlanLimitsVendor.optional(),
  }),
  looseCollection('account-plan-limits', {
    ts: timestamp,
    fiveHour: z.unknown().nullable(),
    sevenDay: z.unknown().nullable(),
    buckets: z.array(PlanLimitBucket).optional(),
    source: z.string(),
    vendor: PlanLimitsVendor,
    accountId: AgentAccountId.nullable(),
  }),
  looseCollection('session-meter', { id: sessionId, ts: timestamp, ...SessionMeterReading.shape }),
  loose('usage-budget-alert', {
    scope: z.string(),
    periodKey: z.string(),
    threshold: z.number(),
    text: z.string(),
    ts: timestamp,
  }),
] as const;
