import { z } from 'zod';
import { REPO_SLUG_RE } from './github-ids.ts';
import { reviewsPollingShape } from './reviews.ts';

export const IssueRepoSlug = z.string().regex(REPO_SLUG_RE);
const issueFields = {
  key: z.string(), repo: IssueRepoSlug, number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  labels: z.array(z.string()), assignees: z.array(z.string()), author: z.string(), comments: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
};
export const IssueSource = z.enum(['project', 'me', 'team']);
export type IssueSource = z.infer<typeof IssueSource>;
export const IssueRow = z.object({
  ...issueFields,
  sources: z.array(IssueSource).nonempty().refine((sources) => new Set(sources).size === sources.length),
  teams: z.array(IssueRepoSlug), projectId: z.string().nullable(),
}).refine((issue) => issue.key === `${issue.repo}#${issue.number}`);
export type IssueRow = z.infer<typeof IssueRow>;
export const IssueUpdate = z.object({ ...issueFields, state: z.enum(['open', 'closed']) });
export type IssueUpdate = z.infer<typeof IssueUpdate>;
export const GithubIssueResponse = z.object({
  number: issueFields.number, title: issueFields.title, html_url: issueFields.url, state: z.enum(['open', 'closed']),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })),
  user: z.object({ login: z.string() }).nullable(), comments: issueFields.comments,
  created_at: issueFields.createdAt, updated_at: issueFields.updatedAt, repository_url: z.string().url().optional(),
  pull_request: z.unknown().optional(),
});
export type GithubIssueResponse = z.infer<typeof GithubIssueResponse>;
export const IssuesSearchResponse = z.object({
  items: z.array(z.unknown()), total_count: z.number().int().nonnegative(), incomplete_results: z.boolean(),
});
export const IssuesFetchResult = z.object({ ok: z.boolean(), items: z.array(IssueUpdate), isComplete: z.boolean(), error: z.string() });
export type IssuesFetchResult = z.infer<typeof IssuesFetchResult>;
export const IssuesState = z.object({
  issues: z.array(IssueRow), lastSyncAt: z.number().finite().nonnegative().nullable(),
  perRepoSync: z.record(IssueRepoSlug, z.object({ lastSyncAt: z.number().finite().nonnegative().nullable(), ticks: z.number().int().nonnegative(), needsFullReconcile: z.boolean() })),
});
export type IssuesState = z.infer<typeof IssuesState>;
export const IssuesStatus = z.object({
  type: z.literal('issues-status'), ts: z.number().finite(), configured: z.boolean(), reason: z.string().nullable(),
  lastSyncAt: z.number().finite().nonnegative().nullable(), issues: z.array(IssueRow), ...reviewsPollingShape,
}).passthrough();
export type IssuesStatus = z.infer<typeof IssuesStatus>;
