import path from 'node:path';

export const FAKE_PR_REPO = 'acme/app';
export const FAKE_PR_NUMBER = 77;
export const FAKE_PR_TITLE = 'Add refunds beside the card module';
export const FAKE_PR_URL = `https://github.com/${FAKE_PR_REPO}/pull/${FAKE_PR_NUMBER}`;

export const FAKE_PR_STATE_ENV = 'GLIMMERVOID_HARNESS_FAKE_PR_STATE';

export function fakePrStatePathIn(shimDirectory: string): string {
  return path.join(shimDirectory, 'fake-pr.json');
}

export interface FakePrState {
  isDraft: boolean;
  checksState: 'SUCCESS' | 'FAILURE' | 'PENDING';
  reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED';
  updatedAt: string;
}

export const DRAFT_PR_STATE: FakePrState = { isDraft: true, checksState: 'PENDING', reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-11-23T10:00:00Z' };
export const READY_PR_STATE: FakePrState = { isDraft: false, checksState: 'SUCCESS', reviewDecision: 'APPROVED', updatedAt: '2026-11-23T10:05:00Z' };

export function fakePrNodeOf(state: FakePrState): Record<string, unknown> {
  return {
    __typename: 'PullRequest', id: 'PR_kwDOfake77', number: FAKE_PR_NUMBER, title: FAKE_PR_TITLE, url: FAKE_PR_URL,
    isDraft: state.isDraft, state: 'OPEN', createdAt: '2026-11-23T09:55:00Z', mergedAt: null, updatedAt: state.updatedAt,
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'refunds', isCrossRepository: false, headRefOid: 'a'.repeat(40),
    isInMergeQueue: false, mergeable: 'MERGEABLE', mergeStateStatus: state.isDraft ? 'DRAFT' : 'CLEAN', reviewDecision: state.reviewDecision,
    additions: 12, deletions: 0,
    repository: { nameWithOwner: FAKE_PR_REPO, viewerDefaultMergeMethod: 'SQUASH' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: state.checksState, contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    latestReviews: { nodes: [] },
    author: { __typename: 'User', login: 'me' }, authorAssociation: 'MEMBER',
    labels: { nodes: [] }, comments: { totalCount: 0 },
    baseRepository: { defaultBranchRef: { name: 'main' } },
    reviewHistory: { nodes: [] }, writerOpinionatedReviews: { nodes: [] },
    baseRef: { compare: { behindBy: 0 } },
  };
}
