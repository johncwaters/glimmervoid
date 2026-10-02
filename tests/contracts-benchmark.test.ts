import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BenchmarkCase, BenchmarkCellResult, BenchmarkReport, BenchmarkRun, BenchmarkStatus, BenchmarkSuite, PrCheckoutCaseInput,
} from '../shared/contracts/benchmark.ts';

const SHA = 'a'.repeat(40);

const REVIEW_LADDER_SUITE = {
  id: 'review-ladder',
  title: 'Code review ladder',
  caseSource: { kind: 'github-merged-prs', repo: 'Acme/gateway', minBodies: 3, limit: 50 },
  workspace: { kind: 'pr-checkout' },
  subject: { promptTemplate: 'Review {repoPath} from {baseSha}', output: 'review-findings', timeoutSeconds: 1800 },
  arms: [
    { id: 'dotfiles-6ca4980', env: { CLAUDE_CONFIG_DIR: '/stage/a/.claude' }, setup: { command: ['bash', 'stage.sh', '6ca4980'] } },
    { id: 'dotfiles-main', env: { CLAUDE_CONFIG_DIR: '/stage/b/.claude' }, extraArgs: ['--model', 'opus'] },
  ],
  baselineArm: 'dotfiles-6ca4980',
  trials: 1,
  scorer: { kind: 'llm-judge-match', model: 'opus' },
};

const MANUAL_JSON_SUITE = {
  id: 'json-extract',
  title: 'JSON extraction',
  caseSource: { kind: 'manual' },
  workspace: { kind: 'none' },
  subject: { promptTemplate: 'Extract fields', output: 'json', timeoutSeconds: 60 },
  arms: [{ id: 'a' }, { id: 'b' }],
  baselineArm: 'a',
  trials: 3,
  scorer: { kind: 'llm-judge-match', model: 'sonnet' },
};

const MINED_CASE = {
  id: '464',
  input: { repo: 'Acme/gateway', number: 464, reviewedSha: SHA, baseSha: 'b'.repeat(40), changedFiles: ['src/router.ts'] },
  references: [
    { id: 'r1', text: 'Retry loop never backs off', tags: ['human'], path: 'src/router.ts', line: 42 },
    { id: 'r2', text: 'Missing null check on provider', tags: ['bot'] },
  ],
  source: { kind: 'github-pr', repo: 'Acme/gateway', number: 464, url: 'https://github.com/Acme/gateway/pull/464', minedAt: 1000 },
};

const SCORED_CELL = {
  caseId: '464', armId: 'dotfiles-main', trial: 1, status: 'scored', startedAt: 1000, finishedAt: 2000,
  degradedReasons: [], findingCount: 4,
  judgements: [
    { referenceId: 'r1', verdict: 'found', findingIndexes: [0] },
    { referenceId: 'r2', verdict: 'missed', findingIndexes: [] },
  ],
  costUsd: 1.25, error: null,
};

test('the review ladder suite and a generic manual json suite both parse', () => {
  assert.deepEqual(BenchmarkSuite.parse(REVIEW_LADDER_SUITE), REVIEW_LADDER_SUITE);
  assert.deepEqual(BenchmarkSuite.parse(MANUAL_JSON_SUITE), MANUAL_JSON_SUITE);
});

test('a suite fails closed on shapes the runner cannot honor', () => {
  for (const invalid of [
    { ...REVIEW_LADDER_SUITE, arms: [REVIEW_LADDER_SUITE.arms[0]] },
    { ...REVIEW_LADDER_SUITE, arms: [REVIEW_LADDER_SUITE.arms[0], REVIEW_LADDER_SUITE.arms[0]] },
    { ...REVIEW_LADDER_SUITE, baselineArm: 'missing-arm' },
    { ...REVIEW_LADDER_SUITE, id: '../escape' },
    { ...REVIEW_LADDER_SUITE, trials: 0 },
    { ...REVIEW_LADDER_SUITE, subject: { ...REVIEW_LADDER_SUITE.subject, output: 'markdown' } },
    { ...REVIEW_LADDER_SUITE, subject: { ...REVIEW_LADDER_SUITE.subject, timeoutSeconds: 5 } },
    { ...REVIEW_LADDER_SUITE, workspace: { kind: 'container' } },
    { ...REVIEW_LADDER_SUITE, caseSource: { kind: 'github-merged-prs', repo: 'gateway', minBodies: 3, limit: 50 } },
    { ...REVIEW_LADDER_SUITE, scorer: { kind: 'exact-match' } },
    { ...REVIEW_LADDER_SUITE, arms: [{ id: 'a', setup: { command: [] } }, { id: 'b' }] },
    { ...REVIEW_LADDER_SUITE, unexpected: true },
  ]) assert.equal(BenchmarkSuite.safeParse(invalid).success, false, JSON.stringify(invalid).slice(0, 120));
});

test('an arm may not carry the OAuth token Glimmervoid injects per cell', () => {
  const leakingArm = { id: 'leaky', env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-value' } };
  const parsed = BenchmarkSuite.safeParse({ ...REVIEW_LADDER_SUITE, arms: [leakingArm, REVIEW_LADDER_SUITE.arms[1]], baselineArm: 'leaky' });
  assert.equal(parsed.success, false);
  assert.match(String(parsed.error?.issues[0]?.message), /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('a mined case parses and its input satisfies the pr-checkout workspace', () => {
  assert.deepEqual(BenchmarkCase.parse(MINED_CASE), MINED_CASE);
  assert.deepEqual(PrCheckoutCaseInput.parse(MINED_CASE.input), MINED_CASE.input);
  assert.equal(PrCheckoutCaseInput.safeParse({ ...MINED_CASE.input, reviewedSha: 'HEAD' }).success, false);
});

test('a case needs at least one reference and unique reference ids', () => {
  assert.equal(BenchmarkCase.safeParse({ ...MINED_CASE, references: [] }).success, false);
  assert.equal(BenchmarkCase.safeParse({ ...MINED_CASE, references: [MINED_CASE.references[0], MINED_CASE.references[0]] }).success, false);
  assert.equal(BenchmarkCase.safeParse({ ...MINED_CASE, references: [{ ...MINED_CASE.references[0], line: 0 }] }).success, false);
});

test('a run record keeps every cell with its judgements and rejects unknown verdicts', () => {
  const run = { id: 'run-1', suiteId: 'review-ladder', status: 'interrupted', startedAt: 1000, finishedAt: 3000, error: null, cells: [SCORED_CELL] };
  assert.deepEqual(BenchmarkRun.parse(run), run);
  assert.equal(BenchmarkCellResult.safeParse({ ...SCORED_CELL, judgements: [{ referenceId: 'r1', verdict: 'maybe', findingIndexes: [] }] }).success, false);
  assert.equal(BenchmarkCellResult.safeParse({ ...SCORED_CELL, status: 'invalid', error: 'worktree dirtied', degradedReasons: ['LANE_DEATH: redteam'] }).success, true);
  assert.equal(BenchmarkRun.safeParse({ ...run, status: 'paused' }).success, false);
});

test('a status push carries a derived paired report per suite', () => {
  const armScore = { trials: 1, recall: 0.5, recallByTag: { human: 1, bot: 0 }, degraded: 0, invalid: 0, costUsd: 1.25 };
  const report = {
    runId: 'run-1', suiteId: 'review-ladder', status: 'completed', baselineArm: 'dotfiles-6ca4980',
    armIds: ['dotfiles-6ca4980', 'dotfiles-main'],
    rows: [{ caseId: '464', arms: { 'dotfiles-6ca4980': armScore, 'dotfiles-main': armScore }, deltaVsBaseline: { 'dotfiles-main': 0 } }],
    totals: { 'dotfiles-6ca4980': armScore, 'dotfiles-main': armScore },
  };
  assert.deepEqual(BenchmarkReport.parse(report), report);
  assert.equal(BenchmarkReport.safeParse({ ...report, totals: { a: { ...armScore, recall: 1.5 } } }).success, false);
  const status = {
    type: 'benchmark-status', ts: 1000, configured: true, reason: null, inFlight: null,
    suites: [{ id: 'review-ladder', title: 'Code review ladder', error: null, caseCount: 5, candidateCount: 0, armIds: report.armIds, baselineArm: 'dotfiles-6ca4980', latestReport: report }],
  };
  assert.equal(BenchmarkStatus.safeParse(status).success, true);
  const brokenSuite = { ...status.suites[0], title: 'broken', error: 'suite.json: baselineArm must name one of the arms', armIds: [], baselineArm: null, latestReport: null };
  assert.equal(BenchmarkStatus.safeParse({ ...status, suites: [brokenSuite] }).success, true);
});
