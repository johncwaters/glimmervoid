import { z } from 'zod';

export const HINT_FEATURES = Object.freeze(['teamReview', 'issues', 'usage', 'posthog', 'visions', 'benchmarks'] as const);
export const HintFeature = z.enum(HINT_FEATURES);
export type HintFeature = z.infer<typeof HintFeature>;

export const HINT_VIEW_BY_FEATURE = Object.freeze({
  teamReview: 'prs',
  issues: 'issues',
  usage: 'usage',
  posthog: 'radar',
  visions: 'visions',
  benchmarks: 'benchmarks',
} as const satisfies Record<HintFeature, string>);

export const HINT_OUTCOMES = Object.freeze(['opened', 'dismissed'] as const);
export type HintOutcome = (typeof HINT_OUTCOMES)[number];

const timestamp = z.number().int().nonnegative();

export const FeatureHint = z.object({
  feature: HintFeature,
  distinctTargetCount: z.number().int().positive(),
  raisedAt: timestamp,
}).strict();
export type FeatureHint = z.infer<typeof FeatureHint>;

const FeatureSignalRecord = z.object({ target: z.string().min(1).max(200), ts: timestamp }).strict();

export const FeatureHintState = z.object({
  signalsByFeature: z.partialRecord(HintFeature, z.array(FeatureSignalRecord).max(50)),
  settledByFeature: z.partialRecord(HintFeature, z.enum(HINT_OUTCOMES)),
  lastShownAtByView: z.partialRecord(z.string().min(1).max(40), timestamp),
  pendingHint: FeatureHint.nullable(),
}).strict();
export type FeatureHintState = z.infer<typeof FeatureHintState>;
