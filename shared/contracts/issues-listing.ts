import { z } from 'zod';
import { IssueRepoSlug, ListedIssue } from './issues.ts';

const listingFields = {
  observedAt: z.iso.datetime(),
  viewer: z.string().min(1),
  isComplete: z.boolean(),
  error: z.string().nullable(),
  issues: z.array(ListedIssue),
};

export const IssuesListingPayload = z.discriminatedUnion('source', [
  z.object({ source: z.literal('project'), repo: IssueRepoSlug, ...listingFields }).strict(),
  z.object({ source: z.literal('me'), ...listingFields }).strict(),
  z.object({ source: z.literal('team'), team: IssueRepoSlug, ...listingFields }).strict(),
]);

export type IssuesListingPayload = z.infer<typeof IssuesListingPayload>;
