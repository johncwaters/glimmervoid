import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prKey,
  filterActionablePrs,
  phaseForVerdict,
  planReviews,
} from '../server/core/team-review-core.ts';

function makePr(overrides = {}) {
  return {
    number: 12,
    key: 'owner/repo#12',
    headRefOid: 'abc123',
    isDraft: false,
    isCrossRepository: false,
    headOwner: 'owner',
    author: { login: 'someuser', isBot: false },
    ...overrides,
  };
}

test('prKey formats as repoSlug#prNumber', () => {
  assert.equal(prKey('owner/repo', 12), 'owner/repo#12');
});

test('filterActionablePrs drops a draft PR', () => {
  const prs = [makePr({ isDraft: true })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops a fork via isCrossRepository', () => {
  const prs = [makePr({ isCrossRepository: true })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops a fork via headOwner mismatch when repoOwner is set', () => {
  const prs = [makePr({ headOwner: 'someone-else' })];
  assert.deepEqual(filterActionablePrs(prs, { repoOwner: 'owner' }), []);
});

test('filterActionablePrs keeps headOwner mismatch when repoOwner is not set', () => {
  const prs = [makePr({ headOwner: 'someone-else' })];
  assert.deepEqual(filterActionablePrs(prs), prs);
});

test('filterActionablePrs drops dependabot[bot] and renovate[bot] logins', () => {
  const prs = [
    makePr({ key: 'owner/repo#1', author: { login: 'dependabot[bot]', isBot: false } }),
    makePr({ key: 'owner/repo#2', author: { login: 'renovate[bot]', isBot: false } }),
  ];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs drops author.isBot true', () => {
  const prs = [makePr({ author: { login: 'some-bot', isBot: true } })];
  assert.deepEqual(filterActionablePrs(prs), []);
});

test('filterActionablePrs keeps a normal own-branch non-draft PR', () => {
  const prs = [makePr()];
  assert.deepEqual(filterActionablePrs(prs, { repoOwner: 'owner' }), prs);
});

test('filterActionablePrs includeBots re-includes bot authors', () => {
  const prs = [makePr({ author: { login: 'dependabot[bot]', isBot: false } })];
  assert.deepEqual(filterActionablePrs(prs, { includeBots: true }), prs);
});

test('filterActionablePrs allowForks re-includes forks', () => {
  const prs = [makePr({ isCrossRepository: true })];
  assert.deepEqual(filterActionablePrs(prs, { allowForks: true }), prs);
});

test('planReviews selects a PR with no state entry', () => {
  const prs = [makePr()];
  assert.deepEqual(planReviews(prs, {}), prs);
});

test('planReviews selects a PR whose reviewedHead differs from headRefOid', () => {
  const prs = [makePr({ headRefOid: 'new-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'old-sha', phase: 'done', inFlight: false } };
  assert.deepEqual(planReviews(prs, state), prs);
});

test('planReviews skips a PR whose reviewedHead matches headRefOid', () => {
  const prs = [makePr({ headRefOid: 'same-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'same-sha', phase: 'done', inFlight: false } };
  assert.deepEqual(planReviews(prs, state), []);
});

test('planReviews skips a PR marked inFlight even if head differs', () => {
  const prs = [makePr({ headRefOid: 'new-sha' })];
  const state = { 'owner/repo#12': { reviewedHead: 'old-sha', phase: 'new', inFlight: true } };
  assert.deepEqual(planReviews(prs, state), []);
});

test('phaseForVerdict keeps clean verdicts apart from requested changes', () => {
  assert.equal(phaseForVerdict('CLEAN'), 'clean');
  assert.equal(phaseForVerdict('RESOLVED'), 'clean');
  assert.equal(phaseForVerdict('CHANGES'), 'changes-requested');
  assert.equal(phaseForVerdict('ERROR'), 'error');
  assert.equal(phaseForVerdict('SOMETHING-ELSE'), 'error');
});
