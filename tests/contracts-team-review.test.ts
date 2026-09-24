import test from 'node:test';
import assert from 'node:assert/strict';

import { PrDetail, ReviewComment, ReviewDraft, ReviewResult, SearchedPr } from '../shared/contracts/team-review.ts';

const HEAD = 'a'.repeat(40);

test('search items require the fields needed to identify a PR while retaining GitHub fields', () => {
  const item = {
    number: 1350,
    title: 'Improve agent detection',
    html_url: 'https://github.com/PostHog/wizard/pull/1350',
    repository_url: 'https://api.github.com/repos/PostHog/wizard',
    user: { login: 'teammate', type: 'User', id: 7 },
    pull_request: { url: 'https://api.github.com/repos/PostHog/wizard/pulls/1350' },
    state: 'open',
  };
  assert.deepEqual(SearchedPr.parse(item), item);
  for (const invalid of [
    { ...item, pull_request: undefined },
    { ...item, user: { login: 'teammate' } },
    { ...item, number: 0 },
    { ...item, draft: 'false' },
  ]) assert.equal(SearchedPr.safeParse(invalid).success, false);
});

test('PR detail requires the selected GitHub CLI fields', () => {
  const detail = {
    number: 1350, title: 'Improve agent detection', body: 'Description',
    url: 'https://github.com/PostHog/wizard/pull/1350',
    author: { login: 'teammate', is_bot: false }, isDraft: false, isCrossRepository: false,
    baseRefName: 'main', baseRefOid: 'b'.repeat(40), headRefOid: HEAD,
    additions: 2, deletions: 1, files: [{ path: 'src/agent/index.ts', additions: 2, deletions: 1 }],
  };
  assert.deepEqual(PrDetail.parse(detail), detail);
  assert.equal(PrDetail.safeParse({ ...detail, files: [{ path: 'src/agent/index.ts', additions: -1, deletions: 1 }] }).success, false);
});

test('review comments default to the new side and require a positive line', () => {
  assert.deepEqual(ReviewComment.parse({ path: 'src/agent/index.ts', line: 4, body: 'Check this' }), {
    path: 'src/agent/index.ts', line: 4, side: 'RIGHT', body: 'Check this',
  });
  for (const line of [0, -1, 1.5]) {
    assert.equal(ReviewComment.safeParse({ path: 'src/agent/index.ts', line, body: 'Check this' }).success, false);
  }
  assert.equal(ReviewComment.safeParse({ path: 'src/agent/index.ts', line: 4, side: 'CENTER', body: 'Check this' }).success, false);
});

test('review result accepts known verdicts and an exact lowercase commit SHA', () => {
  const result = { verdict: 'STAMP', head: HEAD, summary: 'Spot checked', body: 'Looks good', comments: [] };
  assert.deepEqual(ReviewResult.parse(result), result);
  for (const invalid of [
    { ...result, head: 'abc123' },
    { ...result, head: HEAD.toUpperCase() },
    { ...result, verdict: 'APPROVE' },
  ]) assert.equal(ReviewResult.safeParse(invalid).success, false);
});

test('editable review draft requires a repository, tier, status, and reviewed head', () => {
  const draft = {
    key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350,
    title: 'Improve agent detection', url: 'https://github.com/PostHog/wizard/pull/1350',
    author: 'teammate', tier: 'full', reasons: ['252 counted lines over 200'],
    reviewedHead: HEAD, verdict: 'COMMENT', summary: 'Check branch', body: 'A draft review',
    comments: [{ path: 'src/agent/index.ts', line: 4, side: 'RIGHT', body: 'Check this' }],
    status: 'ready',
  };
  assert.deepEqual(ReviewDraft.parse(draft), draft);
  for (const invalid of [
    { ...draft, repo: 'wizard' },
    { ...draft, tier: 'skip' },
    { ...draft, reviewedHead: 'abc123' },
    { ...draft, status: 'pending' },
  ]) assert.equal(ReviewDraft.safeParse(invalid).success, false);
});
