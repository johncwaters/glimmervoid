import { z } from 'zod';

export const PrFlowPriority = z.enum(['blocker', 'high', 'medium', 'low', 'unknown']);
export type PrFlowPriority = z.infer<typeof PrFlowPriority>;

export const PrFlowSource = z.strictObject({
  kind: z.enum(['own', 'thread', 'configured']), name: z.string().min(1), threadId: z.string().optional(), url: z.url().nullable(), priority: PrFlowPriority.optional(),
  excerpt: z.string(), dismissalKey: z.string().min(1),
});
export type PrFlowSource = z.infer<typeof PrFlowSource>;

export const PrFlowItem = z.strictObject({
  key: z.string().min(1), path: z.string(), lineStart: z.number().int().positive().nullable(), lineEnd: z.number().int().positive().nullable(),
  priority: PrFlowPriority, sources: z.array(PrFlowSource).min(1), excerpt: z.string(), url: z.url().nullable(),
});
export type PrFlowItem = z.infer<typeof PrFlowItem>;

const PR_FLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PR_FLOW_QUALIFIED_ID = /^(?:[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const ONE_PRINTABLE_LINE = /^[^\u0000-\u001f\u007f-\u009f]+$/;
const PrFlowRunActionRef = z.templateLiteral(['run:', z.string().regex(PR_FLOW_QUALIFIED_ID)]);
const PrFlowDisposition = z.union([z.enum(['dismiss', 'fix-local']), PrFlowRunActionRef]);
export type PrFlowDisposition = z.infer<typeof PrFlowDisposition>;

export const PrFlowActionRef = z.union([
  z.enum(['ask', 'fix-local', 'dismiss']),
  PrFlowRunActionRef,
], { error: 'a pr flows rule action must be ask, fix-local, dismiss or run:<action id>' });
export type PrFlowActionRef = z.infer<typeof PrFlowActionRef>;

const RepositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'a repository is owner/name' });
export const RepoScope = z.array(RepositoryName).min(1).optional().describe('The owner/name repositories this applies to; every repository when absent');

export const PrFlowRule = z.strictObject({
  name: z.string({ error: 'a pr flows rule needs a name' }).trim().min(1, { error: 'a pr flows rule needs a name' }).max(80, { error: 'a pr flows rule name must be at most 80 characters' }).regex(/\S/, { error: 'a pr flows rule needs a name' }),
  source: z.string().min(1).optional(),
  priority: z.array(PrFlowPriority).min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  text: z.string().min(1).optional(),
  scope: z.enum(['mine', 'team', 'both']).default('mine'),
  repos: RepoScope,
  action: PrFlowActionRef,
  reason: z.string().trim().min(1).max(2000).optional(),
}).refine((rule) => rule.action !== 'dismiss' || rule.reason !== undefined, { message: 'a dismiss rule needs a reason', path: ['reason'] });
export type PrFlowRule = z.infer<typeof PrFlowRule>;

export function prFlowRulesJsonSchema(rulesSchema: z.ZodType): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(rulesSchema, {
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema !== PrFlowRule) return;
      Object.assign(jsonSchema, Object.fromEntries([['if', { properties: { action: { const: 'dismiss' } }, required: ['action'] }], ['then', { required: ['reason'] }]]));
    },
  });
}

const SOURCE_PLACEHOLDERS = ['prUrl', 'repo', 'number', 'head'];
export const PR_FLOW_PLACEHOLDERS_BY_KIND = { source: SOURCE_PLACEHOLDERS, action: [...SOURCE_PLACEHOLDERS, 'itemPath', 'itemLine'], 'pr-action': [...SOURCE_PLACEHOLDERS, 'headRef', 'baseRef'] } as const;

function commandDescription(kind: keyof typeof PR_FLOW_PLACEHOLDERS_BY_KIND, runsWith: string): string {
  const placeholders = PR_FLOW_PLACEHOLDERS_BY_KIND[kind].map((placeholderName) => `{${placeholderName}}`).join(', ');
  return `The program and its arguments, run without a shell from the Glimmervoid home folder; an argument may hold ${placeholders}, and in a pack also {packDir}, the pack's folder. ${runsWith}`;
}

export const PrFlowCommand = z.strictObject({
  id: z.string().regex(PR_FLOW_ID, { error: 'an id is lowercase letters, digits and dashes' }),
  label: z.string().trim().min(1).max(24),
  command: z.array(z.string().min(1)).min(1, { error: 'a command needs at least the program to run' }),
  timeoutSeconds: z.number().int().positive().max(3600).default(120),
});
export type PrFlowCommand = z.infer<typeof PrFlowCommand>;

const COMMAND_ENV = 'Its environment has GLIMMERVOID_PR_URL, GLIMMERVOID_PR_REPO, GLIMMERVOID_PR_NUMBER and GLIMMERVOID_PR_HEAD';
const ACTION_OUTCOME = 'Exit 0 means done and any other exit failed, unless stdout prints the action outcome JSON (glimmervoid packs guide --schema pr-flows)';

export const PrFlowScopedCommand = PrFlowCommand.extend({
  command: PrFlowCommand.shape.command.describe(commandDescription('source', `${COMMAND_ENV}. It must print the source output JSON (glimmervoid packs guide --schema pr-flows) on stdout; anything else shows as an error on the pull request`)),
  repos: RepoScope,
});
export type PrFlowScopedCommand = z.infer<typeof PrFlowScopedCommand>;

export const PrFlowItemAction = PrFlowCommand.extend({
  command: PrFlowCommand.shape.command.describe(commandDescription('action', `${COMMAND_ENV}, and the review item as GLIMMERVOID_ITEM_JSON. ${ACTION_OUTCOME}`)),
});

export const PrFlowPrAction = PrFlowCommand.extend({
  command: PrFlowCommand.shape.command.describe(commandDescription('pr-action', `${COMMAND_ENV}, GLIMMERVOID_PR_HEAD_REF, GLIMMERVOID_PR_BASE_REF and the pull request as GLIMMERVOID_PR_JSON. ${ACTION_OUTCOME}`)),
  repos: RepoScope,
});
export type PrFlowPrAction = z.infer<typeof PrFlowPrAction>;

export const PrFlowSourceFinding = z.strictObject({
  path: z.string().min(1).max(500).regex(ONE_PRINTABLE_LINE, { error: 'a finding path must be one line with no control characters' }),
  lineStart: z.number().int().positive().nullable(), lineEnd: z.number().int().positive().nullable(),
  priority: PrFlowPriority, body: z.string().min(1).max(4000), url: z.httpUrl().nullable().default(null),
});
export type PrFlowSourceFinding = z.infer<typeof PrFlowSourceFinding>;

const PrFlowStatusLine = z.strictObject({
  label: z.string().min(1).max(24).regex(ONE_PRINTABLE_LINE, { error: 'a status label must be one line with no control characters' }),
  state: z.string().min(1).max(80).regex(ONE_PRINTABLE_LINE, { error: 'a status state must be one line with no control characters' }),
});

export const PrFlowSourceOutput = z.strictObject({
  findings: z.array(PrFlowSourceFinding).max(200),
  status: z.array(PrFlowStatusLine).max(4).default([]),
});
export type PrFlowSourceOutput = z.infer<typeof PrFlowSourceOutput>;

export const PrFlowActionOutput = z.strictObject({
  outcome: z.enum(['done', 'started', 'refused', 'failed']), message: z.string().max(200).default(''),
});
export type PrFlowActionOutput = z.infer<typeof PrFlowActionOutput>;

export function prFlowsOutputJsonSchemaText(): string {
  return `${JSON.stringify({ sourceOutput: z.toJSONSchema(PrFlowSourceOutput, { io: 'input' }), actionOutcome: z.toJSONSchema(PrFlowActionOutput, { io: 'input' }) }, null, 2)}\n`;
}

export const ReportedPrFlowActionOutcome = z.looseObject({
  outcome: PrFlowActionOutput.shape.outcome, message: z.string().optional().catch(undefined),
});

export const PrFlowsSettings = z.looseObject({
  sources: z.array(z.unknown(), { error: 'prFlows.sources must be an array' }).optional(),
  actions: z.array(z.unknown(), { error: 'prFlows.actions must be an array' }).optional(),
  prActions: z.array(z.unknown(), { error: 'prFlows.prActions must be an array' }).optional(),
  rules: z.array(z.unknown(), { error: 'prFlows.rules must be an array' }).optional(),
  repoRules: z.record(z.string(), z.unknown(), { error: 'prFlows.repoRules must be an object of repository names' }).optional(),
});

export const PrFlowHandled = z.strictObject({
  itemKey: z.string().min(1), dismissalKeys: z.array(z.string().min(1)).min(1), action: PrFlowDisposition, location: z.string(), reason: z.string().nullable(), at: z.number().finite(),
  ruleName: z.string().nullable(), threadIds: z.array(z.string().min(1)), actionLabel: z.string().optional(),
});
export type PrFlowHandled = z.infer<typeof PrFlowHandled>;

export const PrActionRunState = z.enum(['running', 'started', 'done', 'failed', 'refused', 'interrupted']);
export type PrActionRunState = z.infer<typeof PrActionRunState>;

export const PrActionRunRecord = z.strictObject({
  runId: z.string().min(1), actionId: z.string().min(1), label: z.string(), head: z.string(), startedAt: z.number().finite(), finishedAt: z.number().finite().nullable(),
  state: PrActionRunState, message: z.string(), reportToken: z.string().min(1).nullable(),
});
export type PrActionRunRecord = z.infer<typeof PrActionRunRecord>;

export const PrFlowsState = z.strictObject({
  handledByPr: z.record(z.string(), z.array(PrFlowHandled)),
  reopenedByPr: z.record(z.string(), z.array(z.string().min(1))),
  approvedFingerprints: z.array(z.string().min(1)).default([]),
  ruleRunsByPr: z.record(z.string(), z.array(z.strictObject({ itemKey: z.string().min(1), actionId: z.string().min(1), head: z.string() }))).default({}),
  prActionRunByPr: z.record(z.string(), z.record(z.string(), PrActionRunRecord)).default({}),
});
export type PrFlowsState = z.infer<typeof PrFlowsState>;

export const PrFlowPackRequires = z.strictObject({
  env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: 'an env var name is letters, digits and underscores' })).default([]),
  programs: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, { error: 'a program is a bare name found on PATH, such as gh' })).default([]),
});

const PrFlowPackApprovalCommand = z.strictObject({
  kind: z.enum(['source', 'action', 'pr-action']), id: z.string(), label: z.string(), command: z.array(z.string()), repos: z.array(z.string()).optional(),
});

export const PrFlowPendingApproval = z.strictObject({
  kind: z.enum(['source', 'action', 'pr-action', 'pack']), id: z.string(), label: z.string(), command: z.array(z.string()), timeoutSeconds: z.number(), fingerprint: z.string().min(1),
  repos: z.array(z.string()).optional(),
  pack: z.strictObject({ version: z.number(), requires: PrFlowPackRequires, missing: z.array(z.string()), commands: z.array(PrFlowPackApprovalCommand), rules: z.array(z.string()) }).optional(),
});
export type PrFlowPendingApproval = z.infer<typeof PrFlowPendingApproval>;

export const PrFlowSourceRunStatus = z.strictObject({ label: z.string(), status: z.array(PrFlowStatusLine), error: z.string().nullable() });
export type PrFlowSourceRunStatus = z.infer<typeof PrFlowSourceRunStatus>;

export const PrFlowActionRunStatus = z.strictObject({
  itemKey: z.string(), actionId: z.string(), label: z.string(), state: z.enum(['running', ...PrFlowActionOutput.shape.outcome.options]), message: z.string(),
});
export type PrFlowActionRunStatus = z.infer<typeof PrFlowActionRunStatus>;

const PrFlowActionChoice = z.strictObject({ id: z.string(), label: z.string() });
export type PrFlowActionChoice = z.infer<typeof PrFlowActionChoice>;

export const PrActionRunView = z.strictObject({ actionId: z.string(), label: z.string(), state: PrActionRunState, message: z.string() });
export type PrActionRunView = z.infer<typeof PrActionRunView>;

export const PrFlowsStatus = z.looseObject({
  type: z.literal('pr-flows-status'), handledByPr: PrFlowsState.shape.handledByPr, warnings: z.array(z.string()),
  pendingApprovals: z.array(PrFlowPendingApproval).default([]),
  sourceRunsByPr: z.record(z.string(), z.array(PrFlowSourceRunStatus)).default({}),
  reviewItemsByPr: z.record(z.string(), z.array(PrFlowItem)).default({}),
  actions: z.array(PrFlowActionChoice).default([]),
  actionRunsByPr: z.record(z.string(), z.array(PrFlowActionRunStatus)).default({}),
  prActionsByPr: z.record(z.string(), z.array(PrFlowActionChoice)).default({}),
  prActionRunsByPr: z.record(z.string(), z.array(PrActionRunView)).default({}),
});
export type PrFlowsStatus = z.infer<typeof PrFlowsStatus>;
export const PrFlowApproveRequest = z.strictObject({ fingerprint: z.string().min(1).max(128) });
export type PrFlowApproveRequest = z.infer<typeof PrFlowApproveRequest>;

export const PrActionRunRequest = z.strictObject({
  repo: RepositoryName, number: z.number().int().positive(), actionId: z.string().regex(PR_FLOW_QUALIFIED_ID), head: z.string().min(1).max(64),
});
export type PrActionRunRequest = z.infer<typeof PrActionRunRequest>;

export const PR_ACTION_REPORT_URL_ENV = 'GLIMMERVOID_PR_ACTION_REPORT_URL';
export const PR_ACTION_TOKEN_ENV = 'GLIMMERVOID_PR_ACTION_TOKEN';
export const PR_ACTION_REPORT_ROUTE = '/pr-action/:runId/report';
export const PR_ACTION_REPORT_BODY_CAP_BYTES = 4096;

export function prActionReportPath(runId: string): string {
  return PR_ACTION_REPORT_ROUTE.replace(':runId', encodeURIComponent(runId));
}

export const PrActionReportBody = z.strictObject({
  outcome: z.enum(['started', 'done', 'failed', 'refused']), message: z.string().max(500).optional(),
});
export type PrActionReportBody = z.infer<typeof PrActionReportBody>;

export const PrFlowItemRequest = z.strictObject({ prKey: z.string().min(1), itemKey: z.string().min(1) });
export type PrFlowItemRequest = z.infer<typeof PrFlowItemRequest>;

export const PrFlowSaveRuleRequest = z.strictObject({ ...PrFlowItemRequest.shape, reason: z.string().trim().min(1).max(2000) });
export type PrFlowSaveRuleRequest = z.infer<typeof PrFlowSaveRuleRequest>;

export const PrFlowDisposeRequest = z.strictObject({
  prKey: z.string().min(1), itemKey: z.string().min(1), action: PrFlowDisposition, reason: z.string().trim().min(1).max(2000).optional(),
}).refine((request) => request.action !== 'dismiss' || request.reason !== undefined, { message: 'a dismissal needs a reason', path: ['reason'] });
export type PrFlowDisposeRequest = z.infer<typeof PrFlowDisposeRequest>;

export const PrFlowDisposeResult = z.object({ ok: z.boolean(), error: z.string().optional(), isPending: z.boolean().optional() });
export type PrFlowDisposeResult = z.infer<typeof PrFlowDisposeResult>;

export const PrThreadUnresolveResponse = z.object({
  data: z.object({ unresolveReviewThread: z.object({ thread: z.object({ id: z.string().min(1), isResolved: z.literal(false) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});

export const PrThreadReplyResponse = z.object({
  data: z.object({ addPullRequestReviewThreadReply: z.object({ comment: z.object({ id: z.string().min(1) }) }) }).nullable(),
  errors: z.array(z.unknown()).optional(),
});
