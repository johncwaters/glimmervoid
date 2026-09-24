import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canPost,
  eventForAction,
  prKey,
  filterActionablePrs,
  phaseForVerdict,
  planReviews,
  repoFromSearchItem,
  selectCandidates,
  triagePr,
} from '../server/core/team-review-core.ts';
import { PrDetail, ReviewDraft, SearchedPr } from '../shared/contracts/team-review.ts';

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

const HEAD = 'a'.repeat(40);

function searchItem(repo: string, number: number, author: string, overrides: Record<string, unknown> = {}) {
  return SearchedPr.parse({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    user: { login: author, type: 'User' },
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
    ...overrides,
  });
}

function prDetail(repo: string, number: number, files: { path: string; additions: number; deletions: number }[], isCrossRepository = false) {
  return PrDetail.parse({
    number,
    title: `PR ${number}`,
    body: 'Change summary',
    url: `https://github.com/${repo}/pull/${number}`,
    author: { login: 'teammate', is_bot: false },
    isDraft: false,
    isCrossRepository,
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRefOid: HEAD,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  });
}

test('search candidates union requested and authored PRs once, excluding self, drafts, and bots', () => {
  const requested = [
    searchItem('PostHog/wizard', 1350, 'teammate'),
    searchItem('PostHog/wizard', 1351, 'Operator'),
    searchItem('PostHog/wizard', 1352, 'teammate', { draft: true }),
    searchItem('PostHog/wizard', 1353, 'dependabot[bot]'),
  ];
  const authored = [
    searchItem('PostHog/wizard', 1350, 'teammate'),
    searchItem('PostHog/context-mill', 404, 'operator'),
    searchItem('PostHog/wizard', 1354, 'machine', { user: { login: 'machine', type: 'Bot' } }),
    searchItem('PostHog/context-mill', 405, 'colleague'),
  ];
  assert.equal(repoFromSearchItem(requested[0]), 'PostHog/wizard');
  assert.deepEqual(selectCandidates(requested, authored, { self: 'operator' }), [
    { key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350, title: 'PR 1350', url: 'https://github.com/PostHog/wizard/pull/1350', author: 'teammate' },
    { key: 'PostHog/context-mill#405', repo: 'PostHog/context-mill', number: 405, title: 'PR 405', url: 'https://github.com/PostHog/context-mill/pull/405', author: 'colleague' },
  ]);
});

test('search candidates accept enterprise repository URLs and skip unparseable ones', () => {
  const enterprise = searchItem('PostHog/wizard', 1360, 'teammate', { repository_url: 'https://github.example.com/api/v3/repos/PostHog/wizard' });
  const malformed = searchItem('PostHog/wizard', 1361, 'teammate', { repository_url: 'not a url' });
  const notARepo = searchItem('PostHog/wizard', 1362, 'teammate', { repository_url: 'https://api.github.com/users/teammate' });
  const valid = searchItem('PostHog/context-mill', 405, 'colleague');
  assert.equal(repoFromSearchItem(enterprise), 'PostHog/wizard');
  assert.equal(repoFromSearchItem(malformed), null);
  assert.equal(repoFromSearchItem(notARepo), null);
  assert.deepEqual(selectCandidates([malformed, enterprise, notARepo], [valid], { self: 'operator' }).map((candidate) => candidate.key), [
    'PostHog/wizard#1360', 'PostHog/context-mill#405',
  ]);
});

test('triage uses sensitive paths and counted source size', () => {
  const wizardFiles = [
    ...Array.from({ length: 5 }, (_unused, index) => ({ path: `src/agent/worker-${index}.ts`, additions: 30, deletions: 20 })),
    { path: 'src/lib/detection/agentic.ts', additions: 1, deletions: 1 },
    ...Array.from({ length: 7 }, (_unused, index) => ({ path: `tests/agent/worker-${index}.test.ts`, additions: 15, deletions: 5 })),
  ];
  const contextMillFiles = [
    ...Array.from({ length: 5 }, (_unused, index) => ({ path: `docs/context-${index}.md`, additions: 2, deletions: 2 })),
    ...Array.from({ length: 4 }, (_unused, index) => ({ path: `README-${index}.md`, additions: index < 2 ? 1 : 0, deletions: index < 2 ? 1 : 0 })),
  ];
  const workbenchFiles = [
    ...Array.from({ length: 124 }, (_unused, index) => ({ path: `apps/feature-flags/src/component-${index}.tsx`, additions: 1, deletions: 0 })),
    { path: 'package-lock.json', additions: 1000, deletions: 1000 },
  ];
  const fixtures = [
    { name: 'wizard#1350', detail: prDetail('PostHog/wizard', 1350, wizardFiles), tier: 'full', reason: '252 counted lines over 200' },
    { name: 'context-mill#404', detail: prDetail('PostHog/context-mill', 404, contextMillFiles), tier: 'stamp', reason: 'docs and tests only' },
    { name: 'wizard-workbench#4136', detail: prDetail('PostHog/wizard-workbench', 4136, workbenchFiles), tier: 'full', reason: '124 counted files over 10' },
    { name: 'workflow', detail: prDetail('PostHog/wizard', 1355, [{ path: '.github/workflows/ci.yml', additions: 2, deletions: 1 }]), tier: 'full', reason: 'touches .github/workflows/ci.yml' },
    { name: 'fork', detail: prDetail('PostHog/wizard', 1356, [{ path: 'src/index.ts', additions: 1, deletions: 0 }], true), tier: 'skip', reason: 'fork' },
  ] as const;
  for (const fixture of fixtures) {
    assert.deepEqual(triagePr(fixture.detail), { tier: fixture.tier, reasons: [fixture.reason] }, fixture.name);
  }
});

test('triage excludes each non-source category from size but reviews sensitive paths', () => {
  const ignoredPaths = [
    'docs/guide.ts', 'README.mdx', 'tests/unit.ts', 'src/handler.test.ts', 'src/handler.spec.ts',
    'src/handler_test.ts', 'pnpm-lock.yaml', 'src/snapshot.snap', '__snapshots__/state.ts',
    'fixtures/input.ts', '__fixtures__/input.ts', 'generated/client.ts', 'dist/bundle.js',
    'build/main.js', 'src/app.min.js',
  ];
  const files = ignoredPaths.map((filePath) => ({ path: filePath, additions: 300, deletions: 0 }));
  assert.deepEqual(triagePr(prDetail('PostHog/wizard', 1357, files)), { tier: 'stamp', reasons: ['no counted source files'] });
  const sensitivePaths = [
    'src/auth/login.ts', 'src/session_token.ts', 'src/permission.ts', 'src/secret-store.ts',
    '.env.production', 'keys/client.pem', 'src/api_key.ts', 'migrations/001.sql',
    '.github/workflows/ci.yml', 'Dockerfile', 'docker-compose.yml', 'infra/terraform/main.tf',
    'infra/main.tf', 'k8s/deploy.yml', 'helm/values.yaml',
  ];
  for (const filePath of sensitivePaths) {
    assert.deepEqual(triagePr(prDetail('PostHog/wizard', 1358, [{ path: filePath, additions: 1, deletions: 0 }])), {
      tier: 'full', reasons: [`touches ${filePath}`],
    }, filePath);
  }
});

test('posting requires a ready draft at the current head', () => {
  const draft = ReviewDraft.parse({
    key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350,
    title: 'PR 1350', url: 'https://github.com/PostHog/wizard/pull/1350', author: 'teammate',
    tier: 'full', reasons: ['252 counted lines over 200'], reviewedHead: HEAD,
    verdict: 'COMMENT', summary: 'Looks good', body: 'A review', comments: [], status: 'ready',
  });
  const cases = [
    { status: 'ready' as const, head: HEAD, expected: true },
    { status: 'ready' as const, head: 'b'.repeat(40), expected: false },
    { status: 'stale' as const, head: HEAD, expected: false },
    { status: 'posted' as const, head: HEAD, expected: false },
    { status: 'discarded' as const, head: HEAD, expected: false },
    { status: 'error' as const, head: HEAD, expected: false },
  ];
  for (const item of cases) assert.equal(canPost({ ...draft, status: item.status }, HEAD, item.head), item.expected);
});

test('posting refuses a replaced draft the operator never saw', () => {
  const seenHead = 'a'.repeat(40);
  const pushedHead = 'b'.repeat(40);
  const replacedDraft = ReviewDraft.parse({
    key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350,
    title: 'PR 1350', url: 'https://github.com/PostHog/wizard/pull/1350', author: 'teammate',
    tier: 'full', reasons: ['252 counted lines over 200'], reviewedHead: pushedHead,
    verdict: 'COMMENT', summary: 'Looks good', body: 'A review', comments: [], status: 'ready',
  });
  assert.equal(canPost(replacedDraft, seenHead, pushedHead), false);
  assert.equal(canPost(replacedDraft, pushedHead, pushedHead), true);
});

test('action events map only postable actions', () => {
  assert.equal(eventForAction('approve'), 'APPROVE');
  assert.equal(eventForAction('comment'), 'COMMENT');
  assert.equal(eventForAction('discard'), null);
});
