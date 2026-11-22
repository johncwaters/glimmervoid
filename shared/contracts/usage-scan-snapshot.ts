import { z } from 'zod';

const nullableString = z.string().nullable().optional();

export const UsageScanSnapshotEntry = z.object({
  timestamp: z.string().optional(),
  timestampMs: z.number(),
  cwd: nullableString,
  project: nullableString,
  file: nullableString,
  version: nullableString,
  sessionId: nullableString,
  requestId: nullableString,
  messageId: nullableString,
  model: nullableString,
  rawModel: nullableString,
  speed: nullableString,
  isSidechain: z.boolean().optional(),
  isAdvisor: z.boolean().optional(),
  vendor: z.string().optional(),
  cacheCreation5m: z.number().optional(),
  cacheCreation1h: z.number().optional(),
  input: z.number(),
  output: z.number(),
  cacheCreate: z.number(),
  cacheRead: z.number(),
  costUSD: z.number().nullable(),
  inlineSessionId: nullableString,
  syntheticPrimary: z.string().optional(),
});
export type UsageScanSnapshotEntry = z.infer<typeof UsageScanSnapshotEntry>;

const CodexTokenUsageSnapshot = z.object({
  input_tokens: z.unknown().optional(),
  cached_input_tokens: z.unknown().optional(),
  cache_write_input_tokens: z.unknown().optional(),
  output_tokens: z.unknown().optional(),
  reasoning_output_tokens: z.unknown().optional(),
  total_tokens: z.unknown().optional(),
});

const PiUsageStateSnapshot = z.object({
  sessionId: z.string().nullable(),
  cwd: z.string().nullable(),
});

const UsageScanSnapshotCursor = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  offset: z.number().int().nonnegative(),
  carry: z.string(),
  lineOrdinal: z.number().int().nonnegative(),
  vendorState: z.object({
    model: z.string().nullable(),
    totalTokenUsage: CodexTokenUsageSnapshot.nullable(),
  }).nullable(),
  piState: PiUsageStateSnapshot.nullable().optional(),
});

const UsageScanSnapshotActivity = z.object({
  vendor: z.string(),
  sessionId: z.string(),
  ts: z.number(),
  kind: z.enum(['prompt', 'turnEnd']),
});

const RateLimitWindowSnapshot = z.object({
  pct: z.number().nullable(),
  resetsAtMs: z.number().nullable(),
}).nullable();

const OpenCodeDbCursorSnapshot = z.object({
  dbSize: z.number(),
  dbMtimeMs: z.number(),
  walSize: z.number(),
  walMtimeMs: z.number(),
  watermarkUpdatedMs: z.number(),
  watermarkId: z.string(),
  hasMore: z.boolean(),
});

export const UsageScanSnapshot = z.object({
  version: z.number().int(),
  configKey: z.string(),
  savedAt: z.string(),
  files: z.record(z.string(), UsageScanSnapshotCursor),
  openCodeCursors: z.record(z.string(), OpenCodeDbCursorSnapshot).optional(),
  entries: z.array(UsageScanSnapshotEntry),
  activity: z.array(UsageScanSnapshotActivity),
  codexRateLimits: z.object({
    ts: z.number(),
    rateLimits: z.object({ fiveHour: RateLimitWindowSnapshot, sevenDay: RateLimitWindowSnapshot }),
  }).nullable(),
});
export type UsageScanSnapshot = z.infer<typeof UsageScanSnapshot>;
