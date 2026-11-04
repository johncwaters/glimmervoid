import { repoParts } from '../../../shared/contracts/github-ids.ts';

const MY_PR_MERGE_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isInMergeQueue autoMergeRequest { enabledAt } } }
}`;

interface PrReference {
  repo: string;
  number: number;
}

type PrHeadReference = PrReference & { headSha: string };

const CHECK_CONTEXT_FIELDS = '__typename ... on CheckRun { name conclusion status startedAt checkSuite { app { databaseId } workflowRun { workflow { databaseId } } } } ... on StatusContext { context state }';

const MY_PR_CHECK_CONTEXTS_QUERY = `query($id: ID!, $cursor: String!) { node(id: $id) { ... on StatusCheckRollup { contexts(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} } } } } }`;

const MY_PR_FIELDS_FRAGMENT = `fragment myPrFields on PullRequest {
  __typename id number title url isDraft state createdAt mergedAt updatedAt baseRefName baseRefOid headRefName isCrossRepository headRefOid isInMergeQueue mergeable mergeStateStatus reviewDecision
  repository { nameWithOwner viewerDefaultMergeMethod }
  commits(last: 1) { nodes { commit { statusCheckRollup { id state contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${CHECK_CONTEXT_FIELDS} } } } } } }
  reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug avatarUrl organization { login } } } } }
  latestOpinionatedReviews(first: 20) { nodes { state } }
  latestReviews(first: 20) { nodes { state submittedAt author { login } } }
}`;

const WORKFLOW_PR_FIELDS_FRAGMENT = `fragment workflowPrFields on PullRequest {
  author { login } labels(first: 50) { nodes { name } } comments { totalCount }
}`;

const GITHUB_PR_LIGHT_FIELDS = `
  repository { nameWithOwner } number updatedAt headRefOid state
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewDecision mergeable`;

function githubPrsLightSearchQuery(maxMembers = 50): string {
  return `query($searchQuery: String!, $cursor: String) {
  search(type: ISSUE, first: ${maxMembers}, query: $searchQuery, after: $cursor) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${GITHUB_PR_LIGHT_FIELDS} } } }
}`;
}

const GITHUB_PR_REVIEW_FIELDS = `author { __typename login } authorAssociation
  latestReviews(first: 20) { nodes { state submittedAt author { login } commit { oid } } }
  writerOpinionatedReviews: latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state } }`;

function githubPrsLightByKeyQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { ${GITHUB_PR_LIGHT_FIELDS} } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

function githubPrDetailsQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { ...myPrFields ...workflowPrFields ${GITHUB_PR_REVIEW_FIELDS} } }`;
  });
  return `query { ${fields.join(' ')} }\n${MY_PR_FIELDS_FRAGMENT}\n${WORKFLOW_PR_FIELDS_FRAGMENT}`;
}

const REBASE_PR_MUTATION = `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) { pullRequest { headRefOid } }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

const UNRESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

const REPLY_THREAD_MUTATION = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;

const TEAM_THREAD_COMMENT_FIELDS = `pageInfo { hasNextPage endCursor } nodes { body author { login } viewerDidAuthor createdAt url originalCommit { oid } }`;

const TEAM_THREAD_FIELDS = `id path line isResolved viewerCanResolve comments(first: 100) { ${TEAM_THREAD_COMMENT_FIELDS} }`;

function teamThreadsQuery(prs: readonly PrReference[]): string {
  return reviewThreadsBatchQuery(prs).replaceAll(REVIEW_THREAD_FIELDS, TEAM_THREAD_FIELDS).replaceAll('pageInfo { hasNextPage }', 'pageInfo { hasNextPage endCursor }');
}

const REVIEW_THREAD_FIELDS = `id isResolved isOutdated path line
    firstComment: comments(first: 1) { totalCount nodes { author { login } bodyText url createdAt } }
    lastComment: comments(last: 1) { nodes { author { login } createdAt } }`;

const MY_PR_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
    ${REVIEW_THREAD_FIELDS}
  } } } }
}`;

function reviewThreadsBatchQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { ${REVIEW_THREAD_FIELDS} } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

const MERGED_PRS_QUERY = `query($searchQuery: String!, $first: Int!, $cursor: String) {
  search(type: ISSUE, query: $searchQuery, first: $first, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
    ... on PullRequest { number title url mergedAt reviewThreads { totalCount } reviews { totalCount } }
  } }
}`;

function benchmarkReviewDataQuery(prs: readonly PrReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) {
      author { __typename login } baseRefOid
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { path line originalLine
        comments(first: 1) { nodes { databaseId author { __typename login } body createdAt originalCommit { oid } } } } }
      reviews(first: 100) { pageInfo { hasNextPage } nodes { databaseId author { __typename login } body submittedAt commit { oid } } }
      timelineItems(first: 100, itemTypes: [BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT]) { pageInfo { hasNextPage } nodes {
        __typename ... on BaseRefChangedEvent { createdAt } ... on BaseRefForcePushedEvent { createdAt beforeCommit { oid } } } }
    } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

const TEAM_PROFILE_QUERY = 'query($org: String!, $slug: String!) { organization(login: $org) { team(slug: $slug) { name avatarUrl } } }';

function issueLinkedPullRequestsQuery(issues: readonly PrReference[]): string {
  const fields = issues.map((issue, index) => {
    const [owner, name] = repoParts(issue.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { issue(number: ${issue.number}) { closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number url title state isDraft } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

function behindCountsQuery(prs: readonly PrHeadReference[]): string {
  const fields = prs.map((pr, index) => {
    const [owner, name] = repoParts(pr.repo) ?? ['', ''];
    return `pr${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr.number}) { baseRef { compare(headRef: "${pr.headSha}") { behindBy } } } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

export { MERGED_PRS_QUERY, MY_PR_CHECK_CONTEXTS_QUERY, MY_PR_MERGE_STATE_QUERY, MY_PR_THREADS_QUERY, REBASE_PR_MUTATION, REPLY_THREAD_MUTATION, RESOLVE_THREAD_MUTATION, REVIEW_THREAD_FIELDS, TEAM_PROFILE_QUERY, UNRESOLVE_THREAD_MUTATION, TEAM_THREAD_COMMENT_FIELDS, TEAM_THREAD_FIELDS, behindCountsQuery, benchmarkReviewDataQuery, githubPrDetailsQuery, githubPrsLightByKeyQuery, githubPrsLightSearchQuery, issueLinkedPullRequestsQuery, reviewThreadsBatchQuery, teamThreadsQuery };
export type { PrHeadReference, PrReference };
