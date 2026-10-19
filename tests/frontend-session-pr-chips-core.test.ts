import { normalizeGithubPr } from '../server/github/core/github-store-core.ts';
import { applyGithubPrsFrame, githubPrByKey } from '../public/github/github-prs-store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPrSignals } from '../public/github/session-pr-chips-core.ts';
import { rankSignals, SIGNAL_TIER } from '../public/signal-core.ts';
import { joinMyPrs, newlyMergedPrs, stageIcon, stageLabel, stageTone } from '../public/github/my-prs-view-core.ts';
import type { GithubPr } from '../shared/contracts/github-prs.ts';
import type { LinkedPr, MyPrSearchNode } from '../shared/contracts/my-prs.ts';

const node: MyPrSearchNode = {
  __typename: 'PullRequest', id: 'PR_node', number: 1, title: 'Fix', url: 'https://github.com/Acme/app/pull/1', isDraft: false,
  state: 'OPEN', createdAt: '2026-09-25T00:00:00Z', mergedAt: null, updatedAt: '2026-09-28T00:00:00Z', baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: 'a'.repeat(40), isInMergeQueue: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', repository: { nameWithOwner: 'Acme/app', viewerDefaultMergeMethod: 'SQUASH' },
  commits: { nodes: [] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, latestReviews: { nodes: [] },
};
const base = normalizeGithubPr({ ...node, author: { login: 'alice' }, labels: { nodes: [] }, comments: { totalCount: 0 } });
const githubPr = (number: number, fields: Partial<GithubPr> = {}): GithubPr => ({ ...base, number, title: `Title ${number}`, key: `acme/app#${number}`, url: `https://github.com/Acme/app/pull/${number}`, ...fields });
const link = (number: number, linkedAt: number): LinkedPr => ({ repo: 'Acme/app', number, url: `https://github.com/Acme/app/pull/${number}`, source: 'hook', linkedAt });

function applyPrs(prs: GithubPr[], error: string | null = null): void {
  applyGithubPrsFrame({ type: 'github-prs', ts: 1, prs: Object.fromEntries(prs.map((pr) => [pr.key, pr])), freshness: { lastRefreshedAt: 1, error } });
}

test('settled chips put open before merged before closed, newest first within each, keep two and collapse the rest into an overflow', () => {
  applyPrs([githubPr(1, { state: 'CLOSED' }), githubPr(2, { state: 'MERGED' }), githubPr(3), githubPr(4, { isDraft: true })]);
  const ranked = rankSignals(sessionPrSignals([link(1, 40), link(2, 30), link(3, 10), link(4, 20)], githubPrByKey));
  assert.deepEqual(ranked.visible.map((chip) => chip.text), ['#4', '#3']);
  assert.deepEqual(ranked.visible.map((chip) => chip.look?.icon), ['draft', 'ready']);
  assert.equal(ranked.visible[1]?.hoverText, 'Acme/app: Title 3 (Ready to merge)');
  assert.equal(ranked.overflowCount, 2);
  assert.match(ranked.overflowHoverText, /^#2 [^\n]+\n#1 /);
});

test('a broken pull request outranks a newer settled one, and a needs-you signal outranks both', () => {
  applyPrs([githubPr(1, { checks: { state: 'FAILURE', failing: ['build'], pendingCount: 0 } }), githubPr(2, { state: 'MERGED' })]);
  const prSignals = sessionPrSignals([link(1, 10), link(2, 20)], githubPrByKey);
  const decision = { key: 'coherence', text: 'decision', hoverText: '', look: null, tier: SIGNAL_TIER.needsYou };
  const ranked = rankSignals([...prSignals, decision]);
  assert.deepEqual(ranked.visible.map((signal) => signal.text), ['decision', '#1']);
  assert.equal(ranked.overflowCount, 1);
});

test('a link missing from the store shows its number without a stage and a link in other letter case still finds its stage', () => {
  applyPrs([githubPr(3)]);
  assert.equal(sessionPrSignals([{ ...link(3, 1), repo: 'acme/APP' }], githubPrByKey)[0]?.look?.icon, 'ready');
  const missing = sessionPrSignals([link(9, 1)], githubPrByKey);
  assert.deepEqual(missing, [{ key: 'Acme/app#9', text: '#9', url: 'https://github.com/Acme/app/pull/9', hoverText: 'Acme/app', look: null, tier: SIGNAL_TIER.settled }]);
  applyPrs([]);
  assert.equal(sessionPrSignals([link(3, 1)], githubPrByKey)[0]?.look, null);
});

test('a store snapshot with a polling error retains the supplied PR stages', () => {
  applyPrs([githubPr(3)], 'rate limited');
  assert.equal(sessionPrSignals([link(3, 1)], githubPrByKey)[0]?.look?.icon, 'ready');
});

test('canonical PR updates give the My PRs row and linked session chip the same stage', () => {
  const canonicalPr = githubPr(1);
  const laneEntry = { key: 'Acme/app#1', keepMergeable: true, mergeQueuePosition: 2 };
  const entries = [{ key: 'Acme/app#9' }, laneEntry];
  applyPrs([]);
  assert.deepEqual(joinMyPrs(entries, githubPrByKey), []);
  for (const checksState of ['PENDING', 'FAILURE', 'SUCCESS'] as const) {
    const updatedPr = { ...canonicalPr, checks: { state: checksState, failing: [], pendingCount: 0 } };
    applyGithubPrsFrame({ type: 'github-prs', ts: 1, prs: { [updatedPr.key]: updatedPr }, freshness: { lastRefreshedAt: 1, error: null } });
    const rows = joinMyPrs(entries, githubPrByKey);
    assert.equal(rows.length, 1);
    const rowPr = rows[0];
    assert.equal(rowPr.repo, 'Acme/app');
    assert.equal(rowPr.key, laneEntry.key);
    assert.equal(rowPr.stage, { PENDING: 'checks-pending', FAILURE: 'checks-failing', SUCCESS: 'ready' }[checksState]);
    const chip = sessionPrSignals([link(1, 1)], githubPrByKey)[0];
    assert.equal(chip?.look?.icon, stageIcon(rowPr.stage));
    assert.equal(chip?.look?.tone, stageTone(rowPr.stage));
    assert.equal(chip?.hoverText, `Acme/app: ${rowPr.title} (${stageLabel(rowPr.stage)})`);
    assert.equal(rowPr.keepMergeable, true);
    assert.equal(rowPr.mergeQueuePosition, 2);
  }
  const previousRows = joinMyPrs(entries, githubPrByKey);
  applyPrs([githubPr(1, { state: 'MERGED' }), githubPr(2)]);
  const nextRows = joinMyPrs([{ key: 'Acme/app#2' }, ...entries], githubPrByKey);
  assert.deepEqual(nextRows.map((pr) => pr.key), ['Acme/app#2', laneEntry.key]);
  assert.deepEqual(newlyMergedPrs(previousRows, nextRows).map((pr) => pr.key), [laneEntry.key]);
});
