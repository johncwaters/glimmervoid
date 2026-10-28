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
  id: z.enum(['claude', 'codex', 'kimi']),
  label: z.string().min(1),
  installed: z.boolean().nullable(),
  models: z.array(ReviewModelOffer),
  efforts: z.array(z.string().min(1)),
  skills: z.array(ReviewSkillOffer),
}).strict();
export type ReviewAgentOffer = z.infer<typeof ReviewAgentOffer>;

export const TeamReviewSandboxFacts = z.object({
  networkOpen: z.boolean(),
  networkDomains: z.array(z.string()),
  agentApiDomains: z.array(z.string()),
  mcpLoaded: z.boolean(),
  unreadableHomeEntries: z.array(z.string()),
  unreadableCheckoutEntries: z.array(z.string()),
  githubTokenStripped: z.boolean(),
  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  threadJudgeTools: z.array(z.string()),
}).strict();
export type TeamReviewSandboxFacts = z.infer<typeof TeamReviewSandboxFacts>;

export const TeamReviewEnvironment = z.object({
  agents: z.array(ReviewAgentOffer),
  sandbox: TeamReviewSandboxFacts,
}).strict();
export type TeamReviewEnvironment = z.infer<typeof TeamReviewEnvironment>;
