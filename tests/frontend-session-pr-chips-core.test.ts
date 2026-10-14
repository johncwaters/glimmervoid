import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionPrChips, nextMyPrsByKey } from '../public/github/session-pr-chips-core.ts';
import { parseMyPrsStatus } from '../public/github/my-prs-view-core.ts';
import { toMyPr } from '../server/github/core/my-prs-core.ts';
import type { LinkedPr, MyPr, MyPrSearchNode, MyPrsStatus } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', id: 'PR_node', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
  commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
};
const base = toMyPr(node, 0);
const myPr = (number: number, state: MyPr['state'], stage: MyPr['stage']): MyPr => ({ ...base, number, state, stage, title: `Title ${number}`, key: `Acme/app#${number}`, url: `https://github.com/Acme/app/pull/${number}` });
const link = (number: number, linkedAt: number): LinkedPr => ({ repo: 'Acme/app', number, url: `https://github.com/Acme/app/pull/${number}`, source: 'hook', linkedAt });
const status = (fields: Partial<MyPrsStatus>): MyPrsStatus | null => parseMyPrsStatus({ type: 'my-prs-status', ts: 1, configured: true, viewer: 'alice', prs: [], ...fields });

test('chips put open before merged before closed, newest first within each, keep two and collapse the rest into an overflow', () => {
  const prsByKey = nextMyPrsByKey(new Map(), status({ prs: [myPr(1, 'CLOSED', 'unknown'), myPr(2, 'MERGED', 'merged'), myPr(3, 'OPEN', 'ready'), myPr(4, 'OPEN', 'draft')] }));
  const view = buildSessionPrChips([link(1, 40), link(2, 30), link(3, 10), link(4, 20)], prsByKey);
  assert.deepEqual(view.chips.map((chip) => chip.numberText), ['#4', '#3']);
  assert.deepEqual(view.chips.map((chip) => chip.stage?.icon), ['draft', 'ready']);
  assert.equal(view.chips[1]?.hoverText, 'Acme/app: Title 3 (Ready to merge)');
  assert.equal(view.overflowCount, 2);
  assert.match(view.overflowHoverText, /^#2 [^\n]+\n#1 /);
});

test('a link missing from My PRs shows its number without a stage, a link in other letter case still finds its stage, and unconfigured My PRs drops every stage', () => {
  const configured = nextMyPrsByKey(new Map(), status({ prs: [myPr(3, 'OPEN', 'ready')] }));
  assert.equal(buildSessionPrChips([{ ...link(3, 1), repo: 'acme/APP' }], configured).chips[0]?.stage?.icon, 'ready');
  const missing = buildSessionPrChips([link(9, 1)], configured);
  assert.deepEqual(missing.chips, [{ key: 'Acme/app#9', numberText: '#9', url: 'https://github.com/Acme/app/pull/9', hoverText: 'Acme/app', stage: null }]);
  const unconfigured = nextMyPrsByKey(configured, status({ configured: false, prs: [myPr(3, 'OPEN', 'ready')] }));
  assert.equal(buildSessionPrChips([link(3, 1)], unconfigured).chips[0]?.stage, null);
});

test('a failed poll keeps the stages from the last good status', () => {
  const good = nextMyPrsByKey(new Map(), status({ prs: [myPr(3, 'OPEN', 'ready')] }));
  const afterFailure = nextMyPrsByKey(good, status({ error: 'rate limited', prs: [] }));
  assert.equal(buildSessionPrChips([link(3, 1)], afterFailure).chips[0]?.stage?.icon, 'ready');
});
