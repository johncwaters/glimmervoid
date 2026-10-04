import { z } from 'zod';
import { CommitSha } from './team-review.ts';
import { MyPrSearchNode, repositoryName } from './my-prs.ts';

export const WORKFLOW_TRIGGERS = Object.freeze(['opened', 'checks-failed', 'review-requested', 'approved', 'commented', 'merged'] as const);
export const WORKFLOW_ACTION_TYPES = Object.freeze(['notify', 'spawn', 'label', 'comment'] as const);
export const WORKFLOW_PROMPT_TEMPLATE_MAX_CHARACTERS = 20000;
export const WORKFLOW_COMMENT_BODY_MAX_CHARACTERS = 65536;
export const WORKFLOW_LABEL_NAME_MAX_CHARACTERS = 50;

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSAFE_LABEL_NAME = /[\x00-\x1f\x7f,]|^-/;

const nonEmptyList = <Item extends z.ZodType>(field: string, item: Item) => z.array(item, { error: `${field} must be an array` })
  .min(1, { error: `${field} must list at least one entry when present` });

export const WorkflowLabelName = z.string({ error: 'a workflow label name must be a string' })
  .trim()
  .min(1, { error: 'a workflow label name must not be empty' })
  .max(WORKFLOW_LABEL_NAME_MAX_CHARACTERS, { error: `a workflow label name must be at most ${WORKFLOW_LABEL_NAME_MAX_CHARACTERS} characters` })
  .refine((name) => !UNSAFE_LABEL_NAME.test(name), { error: 'a workflow label name must not start with a dash or hold a comma or control character' });

export const WorkflowCommentBody = z.string({ error: 'a workflow comment body must be a string' })
  .min(1, { error: 'a workflow comment body must not be empty' })
  .max(WORKFLOW_COMMENT_BODY_MAX_CHARACTERS, { error: `a workflow comment body must be at most ${WORKFLOW_COMMENT_BODY_MAX_CHARACTERS} characters` })
  .refine((body) => body.trim().length > 0, { error: 'a workflow comment body must not be blank' });

export const WorkflowTrigger = z.enum(WORKFLOW_TRIGGERS, { error: `workflows.rules[].trigger must be one of ${WORKFLOW_TRIGGERS.join(', ')}` });
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const WorkflowAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notify') }),
  z.strictObject({
    type: z.literal('spawn'),
    promptTemplate: z.string({ error: 'a spawn action needs a promptTemplate string' })
      .min(1, { error: 'a spawn action promptTemplate must not be empty' })
      .max(WORKFLOW_PROMPT_TEMPLATE_MAX_CHARACTERS, { error: `a spawn action promptTemplate must be at most ${WORKFLOW_PROMPT_TEMPLATE_MAX_CHARACTERS} characters` })
      .refine((template) => template.trim().length > 0, { error: 'a spawn action promptTemplate must not be blank' }),
  }),
  z.strictObject({ type: z.literal('label'), name: WorkflowLabelName }),
  z.strictObject({ type: z.literal('comment'), body: WorkflowCommentBody }),
], { error: `workflows.rules[].actions[].type must be one of ${WORKFLOW_ACTION_TYPES.join(', ')}` });
export type WorkflowAction = z.infer<typeof WorkflowAction>;

export const WorkflowFilters = z.strictObject({
  mine: z.boolean({ error: 'workflows.rules[].filters.mine must be a boolean' }).optional(),
  teamReviewRequested: z.boolean({ error: 'workflows.rules[].filters.teamReviewRequested must be a boolean' }).optional(),
  authors: nonEmptyList('workflows.rules[].filters.authors', z.string({ error: 'workflows.rules[].filters.authors must hold GitHub logins' })
    .regex(GITHUB_LOGIN, { error: 'workflows.rules[].filters.authors must hold GitHub logins' })).optional(),
  labels: nonEmptyList('workflows.rules[].filters.labels', WorkflowLabelName).optional(),
  baseBranches: nonEmptyList('workflows.rules[].filters.baseBranches', z.string({ error: 'workflows.rules[].filters.baseBranches must hold branch names' })
    .min(1, { error: 'workflows.rules[].filters.baseBranches must hold branch names' })).optional(),
}, { error: 'workflows.rules[].filters must be an object' });
export type WorkflowFilters = z.infer<typeof WorkflowFilters>;

export const WorkflowRule = z.strictObject({
  id: z.string({ error: 'workflows.rules[].id must be a string' })
    .regex(RULE_ID, { error: 'workflows.rules[].id must be 1 to 64 lowercase letters, digits and dashes, starting with a letter or digit' }),
  name: z.string({ error: 'workflows.rules[].name must be a string' })
    .trim()
    .min(1, { error: 'workflows.rules[].name must not be empty' })
    .max(80, { error: 'workflows.rules[].name must be at most 80 characters' }),
  enabled: z.boolean({ error: 'workflows.rules[].enabled must be a boolean' }).default(false),
  repos: nonEmptyList('workflows.rules[].repos', repositoryName),
  filters: WorkflowFilters.default({}),
  trigger: WorkflowTrigger,
  actions: nonEmptyList('workflows.rules[].actions', WorkflowAction),
}, { error: 'workflows.rules[] must be an object' });
export type WorkflowRule = z.infer<typeof WorkflowRule>;

export const WorkflowsSettings = z.strictObject({
  rules: z.array(WorkflowRule, { error: 'workflows.rules must be an array' }).default([]),
}, { error: 'workflows must be an object' }).superRefine((settings, ctx) => {
  const claimedIds = new Set<string>();
  for (const [index, rule] of settings.rules.entries()) {
    if (!claimedIds.has(rule.id)) {
      claimedIds.add(rule.id);
      continue;
    }
    ctx.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: `workflows.rules[${index}].id "${rule.id}" is declared more than once` });
  }
});
export type WorkflowsSettings = z.infer<typeof WorkflowsSettings>;

const nonnegativeInteger = z.number().int().nonnegative();
const checksState = z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']).nullable();

export const WorkflowSearchNode = MyPrSearchNode.extend({
  author: z.object({ login: z.string() }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ totalCount: nonnegativeInteger }),
});
export type WorkflowSearchNode = z.infer<typeof WorkflowSearchNode>;

export const WorkflowPr = z.strictObject({
  repo: repositoryName,
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  author: z.string().nullable(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  isDraft: z.boolean(),
  isCrossRepository: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string().min(1),
  headRefOid: CommitSha,
  labels: z.array(z.string()),
  commentCount: nonnegativeInteger,
  reviewRequests: z.array(z.string()),
  checksState,
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
});
export type WorkflowPr = z.infer<typeof WorkflowPr>;

export const WorkflowRepoSnapshot = z.strictObject({
  polledAtMs: nonnegativeInteger,
  prs: z.array(WorkflowPr),
});
export type WorkflowRepoSnapshot = z.infer<typeof WorkflowRepoSnapshot>;

export const WorkflowsState = z.strictObject({
  repos: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/), WorkflowRepoSnapshot),
});
export type WorkflowsState = z.infer<typeof WorkflowsState>;
