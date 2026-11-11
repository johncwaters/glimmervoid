import { z } from 'zod';

export const STAR_HINT_PROMPT_THRESHOLD = 5;
const STAR_HINT_OUTCOMES = Object.freeze(['shown', 'starred', 'dismissed'] as const);
export type StarHintOutcome = (typeof STAR_HINT_OUTCOMES)[number];

export const StarHintState = z.looseObject({
  starHintPromptCount: z.number().int().min(0).max(STAR_HINT_PROMPT_THRESHOLD).default(0),
  starHintOutcome: z.enum(STAR_HINT_OUTCOMES).nullable().default(null),
});
export type StarHintState = z.infer<typeof StarHintState>;
