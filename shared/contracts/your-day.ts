import { z } from 'zod';

const nonNegativeInt = z.number().int().nonnegative();

const YourDayInsightKind = z.enum(['waitingThreshold', 'sharpestHours', 'longestStretch', 'afterHours', 'juggling']);

export const YourDayInsight = z.object({
  kind: YourDayInsightKind,
  text: z.string().min(1).max(80),
  deviation: z.number(),
}).strict();
export type YourDayInsight = z.infer<typeof YourDayInsight>;

export const YourDay = z.object({
  yesterday: z.object({ day: z.string(), sessionCount: nonNegativeInt, activeMs: nonNegativeInt }).strict(),
  insights: z.array(YourDayInsight).max(3),
  usual: z.object({ peakWaiting: z.number().nonnegative(), stretchMs: nonNegativeInt }).strict(),
  currentStretchStartedAt: nonNegativeInt.nullable(),
  activeDayCount: nonNegativeInt,
}).strict();
export type YourDay = z.infer<typeof YourDay>;
