import { GithubPrDetailNode, GithubPrLightSearchNode } from '../../../shared/contracts/github-prs.ts';
import { GH_SEGMENT } from '../../../shared/contracts/github-ids.ts';
import { z } from 'zod';
import { CommitSha } from '../../../shared/contracts/team-review.ts';
import { GithubTeam } from '../../../shared/contracts/control-messages.ts';

const GITHUB_PR_LIGHT_REPOSITORY = z.object({ pullRequest: GithubPrLightSearchNode.nullable() }).nullable();

const GITHUB_PRS_LIGHT_RESPONSE = z.object({ data: z.object({ search: z.object({
  issueCount: z.number().int().nonnegative(),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(GithubPrLightSearchNode),
}) }), errors: z.array(z.unknown()).optional() });

const GITHUB_PR_DETAIL_REPOSITORY = z.object({ pullRequest: GithubPrDetailNode.nullable() }).nullable();

const GITHUB_NOTIFICATIONS = z.array(z.object({ subject: z.object({ type: z.string(), url: z.string().nullable() }) }));

const GRAPHQL_THREADS_REPOSITORY = z.object({ pullRequest: z.object({
  reviewThreads: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(z.unknown()) }),
}).nullable() });

const MERGED_PRS_RESPONSE = z.object({ data: z.object({ search: z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
}) }) });

const COMPARE_RESPONSE = z.object({ mergeBaseSha: CommitSha, changedFiles: z.array(z.string().min(1)), fileCount: z.number().int().nonnegative() });

const GH_LOGIN = z.string().regex(GH_SEGMENT);

const GH_MEMBERS = z.array(GH_LOGIN);

const GH_TEAMS = z.array(GithubTeam);

const TEAM_PROFILE = z.object({ data: z.object({ organization: z.object({ team: z.object({ name: z.string(), avatarUrl: z.string().url() }).nullable() }).nullable() }), errors: z.array(z.unknown()).optional() });

const PR_DIFF_MAX_BYTES = 2 * 1024 * 1024;

const CREATED_REVIEW = z.object({ id: z.number().int().positive() }).passthrough();

const GRAPHQL_BEHIND_REPOSITORY = z.object({
  pullRequest: z.object({ baseRef: z.object({ compare: z.object({ behindBy: z.number().int().nonnegative() }).nullable() }).nullable() }).nullable(),
});

const GRAPHQL_RESPONSE = z.object({ data: z.record(z.string(), z.unknown()).nullable(), errors: z.array(z.unknown()).optional() }).passthrough();

const GRAPHQL_ERROR_ALIAS = z.object({ path: z.tuple([z.string()]).rest(z.union([z.string(), z.number()])) });

const GRAPHQL_NOT_FOUND_ERROR = GRAPHQL_ERROR_ALIAS.extend({ type: z.literal('NOT_FOUND') });

const PR_DIFF = z.string().refine((diff) => Buffer.byteLength(diff, 'utf8') <= PR_DIFF_MAX_BYTES);

export { COMPARE_RESPONSE, CREATED_REVIEW, GH_LOGIN, GH_MEMBERS, GH_TEAMS, GITHUB_NOTIFICATIONS, GITHUB_PRS_LIGHT_RESPONSE, GITHUB_PR_DETAIL_REPOSITORY, GITHUB_PR_LIGHT_REPOSITORY, GRAPHQL_BEHIND_REPOSITORY, GRAPHQL_ERROR_ALIAS, GRAPHQL_NOT_FOUND_ERROR, GRAPHQL_RESPONSE, GRAPHQL_THREADS_REPOSITORY, MERGED_PRS_RESPONSE, PR_DIFF, TEAM_PROFILE };
