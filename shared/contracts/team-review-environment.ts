import { z } from 'zod';

export const ReviewSkillOffer = z.object({
  name: z.string().min(1),
  description: z.string(),
  source: z.enum(['user', 'plugin']),
}).strict();
export type ReviewSkillOffer = z.infer<typeof ReviewSkillOffer>;

export const ReviewModelOffer = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  efforts: z.array(z.string().min(1)).nullable(),
  defaultEffort: z.string().min(1).nullable(),
}).strict();
export type ReviewModelOffer = z.infer<typeof ReviewModelOffer>;

export const ReviewAgentOffer = z.object({
  id: z.literal('claude'),
  label: z.string().min(1),
  installed: z.boolean().nullable(),
  models: z.array(ReviewModelOffer),
  efforts: z.array(z.string().min(1)),
  skills: z.array(ReviewSkillOffer),
}).strict();
export type ReviewAgentOffer = z.infer<typeof ReviewAgentOffer>;

export const TeamReviewEnvironment = z.object({
  agents: z.array(ReviewAgentOffer),
}).strict();
export type TeamReviewEnvironment = z.infer<typeof TeamReviewEnvironment>;
