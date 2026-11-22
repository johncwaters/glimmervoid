import { z } from 'zod';

export const UsageBreakdownRow = z.object({
  key: z.string(),
  label: z.string(),
  costUSD: z.number(),
  input: z.number(),
  output: z.number(),
  cacheHitPct: z.number().nullable(),
  sessions: z.number(),
});
export type UsageBreakdownRow = z.infer<typeof UsageBreakdownRow>;

export const UsageDailyVendorRow = z.object({
  day: z.string(),
  costByVendor: z.record(z.string(), z.number()),
  source: z.enum(['live', 'history']).optional(),
});
export type UsageDailyVendorRow = z.infer<typeof UsageDailyVendorRow>;

export const UsageRangeRollup = z.object({
  costUSD: z.number(),
  previousCostUSD: z.number().nullable(),
  daily: z.array(UsageDailyVendorRow),
  byAgent: z.array(UsageBreakdownRow),
  byModel: z.array(UsageBreakdownRow),
  byProject: z.array(UsageBreakdownRow),
  byLane: z.array(UsageBreakdownRow).nullable(),
});
export type UsageRangeRollup = z.infer<typeof UsageRangeRollup>;

export const UsageCoverageRow = z.object({
  vendor: z.string(),
  files: z.number(),
  lastEntryMs: z.number().nullable(),
  limitSource: z.enum(['statusline', 'transcript', 'account', 'none']),
  costSource: z.enum(['reported', 'list-price']),
});
export type UsageCoverageRow = z.infer<typeof UsageCoverageRow>;

export const UsageBudgetRow = z.object({
  scope: z.string(),
  budgetUsd: z.number(),
  spentUsd: z.number(),
  pct: z.number(),
  tone: z.string(),
});
export type UsageBudgetRow = z.infer<typeof UsageBudgetRow>;

export const UsageBudget = z.object({
  dailyUsd: z.number().nullable(),
  monthlyUsd: z.number().nullable(),
  rows: z.array(UsageBudgetRow),
});
export type UsageBudget = z.infer<typeof UsageBudget>;

export const UsagePricing = z.object({
  source: z.string(),
  fetchedAt: z.union([z.number(), z.string()]).nullable(),
  missing: z.array(z.string()),
});
export type UsagePricing = z.infer<typeof UsagePricing>;

export const UsageScanSummary = z.object({
  dirs: z.array(z.string()),
  files: z.number(),
  entries: z.number(),
  lastScanMs: z.number().nullable(),
  partial: z.boolean(),
  outcome: z.string().nullable(),
  ioFailures: z.number(),
});
export type UsageScanSummary = z.infer<typeof UsageScanSummary>;

export const UsageReportRanges = z.object({
  today: UsageRangeRollup,
  week: UsageRangeRollup,
  month: UsageRangeRollup,
});
export type UsageReportRanges = z.infer<typeof UsageReportRanges>;
