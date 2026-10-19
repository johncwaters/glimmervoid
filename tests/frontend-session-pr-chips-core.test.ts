import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { applyGithubPrsFrame, githubPrByKey } from '../public/github/github-prs-store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMyPrsByKey, sessionPrSignals } from '../public/github/session-pr-chips-core.ts';
import { rankSignals, SIGNAL_TIER } from '../public/signal-core.ts';
import { myPrWithGithubPr, parseMyPrsStatus, stageIcon, stageLabel, stageTone } from '../public/github/my-prs-view-core.ts';
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

test('settled chips put open before merged before closed, newest first within each, keep two and collapse the rest into an overflow', () => {
  const prsByKey = nextMyPrsByKey(new Map(), status({ prs: [myPr(1, 'CLOSED', 'unknown'), myPr(2, 'MERGED', 'merged'), myPr(3, 'OPEN', 'ready'), myPr(4, 'OPEN', 'draft')] }));
  const ranked = rankSignals(sessionPrSignals([link(1, 40), link(2, 30), link(3, 10), link(4, 20)], prsByKey));
  assert.deepEqual(ranked.visible.map((chip) => chip.text), ['#4', '#3']);
  assert.deepEqual(ranked.visible.map((chip) => chip.look?.icon), ['draft', 'ready']);
  assert.equal(ranked.visible[1]?.hoverText, 'Acme/app: Title 3 (Ready to merge)');
  assert.equal(ranked.overflowCount, 2);
  assert.match(ranked.overflowHoverText, /^#2 [^\n]+\n#1 /);
});

test('a broken pull request outranks a newer settled one, and a needs-you signal outranks both', () => {
  const prsByKey = nextMyPrsByKey(new Map(), status({ prs: [myPr(1, 'OPEN', 'checks-failing'), myPr(2, 'MERGED', 'merged')] }));
  const prSignals = sessionPrSignals([link(1, 10), link(2, 20)], prsByKey);
  const decision = { key: 'coherence', text: 'decision', hoverText: '', look: null, tier: SIGNAL_TIER.needsYou };
  const ranked = rankSignals([...prSignals, decision]);
  assert.deepEqual(ranked.visible.map((signal) => signal.text), ['decision', '#1']);
  assert.equal(ranked.overflowCount, 1);
});

test('a link missing from My PRs shows its number without a stage, a link in other letter case still finds its stage, and unconfigured My PRs drops every stage', () => {
  const configured = nextMyPrsByKey(new Map(), status({ prs: [myPr(3, 'OPEN', 'ready')] }));
  assert.equal(sessionPrSignals([{ ...link(3, 1), repo: 'acme/APP' }], configured)[0]?.look?.icon, 'ready');
  const missing = sessionPrSignals([link(9, 1)], configured);
  assert.deepEqual(missing, [{ key: 'Acme/app#9', text: '#9', url: 'https://github.com/Acme/app/pull/9', hoverText: 'Acme/app', look: null, tier: SIGNAL_TIER.settled }]);
  const unconfigured = nextMyPrsByKey(configured, status({ configured: false, prs: [myPr(3, 'OPEN', 'ready')] }));
  assert.equal(sessionPrSignals([link(3, 1)], unconfigured)[0]?.look, null);
});

test('a failed poll keeps the stages from the last good status', () => {
  const good = nextMyPrsByKey(new Map(), status({ prs: [myPr(3, 'OPEN', 'ready')] }));
  const afterFailure = nextMyPrsByKey(good, status({ error: 'rate limited', prs: [] }));
  assert.equal(sessionPrSignals([link(3, 1)], afterFailure)[0]?.look?.icon, 'ready');
});

test('canonical PR updates give the My PRs row and linked session chip the same stage', () => {
  const canonicalPr = normalizeGithubPr({ ...node, author: { login: 'alice' }, labels: { nodes: [] }, comments: { totalCount: 0 } });
  const lanePr = { ...myPr(1, 'OPEN', 'draft'), keepMergeable: true, mergeQueuePosition: 2 };
  const fallbackPrs = nextMyPrsByKey(new Map(), status({ prs: [lanePr] }));
  for (const checksState of ['PENDING', 'FAILURE', 'SUCCESS'] as const) {
    const updatedPr = { ...canonicalPr, checks: { state: checksState, failing: [], pendingCount: 0 } };
    applyGithubPrsFrame({ type: 'github-prs', ts: 1, prs: { [updatedPr.key]: updatedPr }, freshness: { lastRefreshedAt: 1, error: null } });
    const rowPr = myPrWithGithubPr(lanePr, githubPrByKey('ACME/APP#1'));
    assert.equal(rowPr.stage, { PENDING: 'checks-pending', FAILURE: 'checks-failing', SUCCESS: 'ready' }[checksState]);
    const chip = sessionPrSignals([link(1, 1)], fallbackPrs, githubPrByKey)[0];
    assert.equal(chip?.look?.icon, stageIcon(rowPr.stage));
    assert.equal(chip?.look?.tone, stageTone(rowPr.stage));
    assert.equal(chip?.hoverText, `Acme/app: ${rowPr.title} (${stageLabel(rowPr.stage)})`);
    assert.equal(rowPr.keepMergeable, true);
    assert.equal(rowPr.mergeQueuePosition, 2);
  }
});
