import { z } from 'zod';
import { YourDay } from '../your-day.ts';
import { requestId, sessionId, loose, openObject, nullableString, timestamp, optionalTimestamp, optionalError, opaqueObject, opaqueArray, PlanLimitsVendor } from './control-fields.ts';

export const laneClientVariants = [
  loose('request-usage-report', { requestId, days: z.unknown().optional(), force: z.unknown().optional() }),
] as const;

export const laneServerVariants = [
  loose('usage-sessions', {
    ts: timestamp,
    pricingSource: nullableString,
    sessions: z.array(openObject({
      id: sessionId,
      tokens: z.number(),
      costUSD: z.number(),
      officialCostUSD: z.number().nullable().optional(),
    })),
  }),
  loose('usage-report', {
    requestId,
    ts: optionalTimestamp,
    tz: z.string().optional(),
    blockHours: z.number().optional(),
    totals: opaqueObject.optional(),
    daily: opaqueArray.optional(),
    models: opaqueArray.optional(),
    sessions: opaqueArray.optional(),
    blocks: opaqueArray.optional(),
    activeBlock: z.unknown().nullable().optional(),
    anomaly: z.unknown().nullable().optional(),
    byLane: z.unknown().optional(),
    planWindowLanes: z.unknown().nullable().optional(),
    budget: z.unknown().optional(),
    savings: z.unknown().optional(),
    yourDay: YourDay.nullable().optional(),
    pricing: opaqueObject.optional(),
    scan: opaqueObject.optional(),
    warning: optionalError,
    error: optionalError,
  }),
  loose('plan-limits', {
    ts: timestamp,
    fiveHour: z.unknown().nullable(),
    sevenDay: z.unknown().nullable(),
    source: z.string(),
    vendor: PlanLimitsVendor.optional(),
  }),
  loose('usage-budget-alert', {
    scope: z.string(),
    periodKey: z.string(),
    threshold: z.number(),
    text: z.string(),
    ts: timestamp,
  }),
] as const;
