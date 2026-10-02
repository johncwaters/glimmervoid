import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { baseTipAt, mineCandidates, mostCommonCommit, reviewedRangeFrom } from '../server/core/benchmark-mining-core.ts';
import type { MiningDependencies } from '../server/core/benchmark-mining-core.ts';
import { BenchmarkCase, MinedPrReviewData, PrCheckoutCaseInput } from '../shared/contracts/benchmark.ts';
import type { CommitComparison, MergedPrListing, MinedPrReviewData as MinedPrReviewDataType } from '../shared/contracts/benchmark.ts';

const REVIEWED_SHA = '1'.repeat(40);
const LATER_PUSH_SHA = '2'.repeat(40);
const BASE_AT_REVIEW = '4'.repeat(40);
const MERGE_BASE = '7'.repeat(40);

const STACKED_PR: MinedPrReviewDataType = MinedPrReviewData.parse(JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'benchmark', 'stacked-pr-review-data.json'), 'utf8',
)));

function listing(number: number, totalBodies = 10): MergedPrListing {
  return {
    number, title: `PR ${number}`, url: `https://github.com/Acme/gateway/pull/${number}`, mergedAt: '2026-09-19T00:00:00Z',
    reviewThreads: { totalCount: totalBodies }, reviews: { totalCount: 0 },
  };
}

function miningDependencies(overrides: Partial<MiningDependencies> = {}): MiningDependencies & { comparisons: [string, string][] } {
  const comparisons: [string, string][] = [];
  return {
    repo: 'Acme/gateway', limit: 10, minBodies: 3, knownCaseIds: new Set(), now: () => 5000,
    listMergedPrs: async () => ({ ok: true, prs: [listing(464)] }),
    reviewData: async (_repo, numbers) => new Map(numbers.map((number) => [number, STACKED_PR])),
    compareCommits: async (_repo, base, head): Promise<CommitComparison> => {
      comparisons.push([base, head]);
      return { mergeBaseSha: MERGE_BASE, changedFiles: ['src/stream.ts', 'src/usage.ts'], isFileListComplete: true };
    },
    comparisons,
    ...overrides,
  };
}

test('the reviewed commit is the one most inline comments were written on, and only its comments become references', () => {
  const reviewed = reviewedRangeFrom(STACKED_PR);
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  assert.equal(reviewed.range.reviewedSha, REVIEWED_SHA);
  assert.deepEqual(reviewed.range.references.map((reference) => reference.id), ['c1001', 'c1002', 'c1003', 'c1004', 'c1005', 'c1006', 'r2002']);
  assert.equal(reviewed.range.earliestAt, '2026-09-10T09:00:00Z');
  assert.equal(reviewed.range.latestAt, '2026-09-10T09:10:00Z');
});

test('references carry bot or human tags and the line at the reviewed commit', () => {
  const reviewed = reviewedRangeFrom(STACKED_PR);
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  const byId = new Map(reviewed.range.references.map((reference) => [reference.id, reference]));
  assert.deepEqual(byId.get('c1001')?.tags, ['bot']);
  assert.deepEqual(byId.get('c1003')?.tags, ['human']);
  assert.equal(byId.get('c1003')?.line, 612);
  assert.equal(byId.get('c1006')?.line, 18);
  assert.equal(byId.get('r2002')?.path, undefined);
  assert.equal(byId.get('r2002')?.line, undefined);
});

test('the pull request author, empty bodies and comments on a later push are never references', () => {
  const reviewed = reviewedRangeFrom(STACKED_PR);
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  const ids = new Set(reviewed.range.references.map((reference) => reference.id));
  for (const excluded of ['c1007', 'c1008', 'c1009', 'r2001', 'r2003', 'r2004']) assert.equal(ids.has(excluded), false, excluded);
});

test('an even split between two commits is refused rather than guessed', () => {
  assert.deepEqual(mostCommonCommit([REVIEWED_SHA, LATER_PUSH_SHA]).ok, false);
  assert.deepEqual(mostCommonCommit([]).ok, false);
  assert.deepEqual(mostCommonCommit([REVIEWED_SHA, LATER_PUSH_SHA, REVIEWED_SHA]), { ok: true, sha: REVIEWED_SHA });
});

test('the base at review time is the tip the next base force push replaced', () => {
  const events = STACKED_PR.timelineItems.nodes;
  assert.deepEqual(baseTipAt(events, STACKED_PR.baseRefOid, '2026-09-10T09:00:00Z'), { ok: true, sha: BASE_AT_REVIEW });
  assert.deepEqual(baseTipAt(events, STACKED_PR.baseRefOid, '2026-09-30T00:00:00Z'), { ok: true, sha: STACKED_PR.baseRefOid });
  assert.equal(baseTipAt([{ __typename: 'BaseRefChangedEvent', createdAt: '2026-09-12T00:00:00Z' }], STACKED_PR.baseRefOid, '2026-09-10T00:00:00Z').ok, false);
  assert.equal(baseTipAt([{ __typename: 'BaseRefForcePushedEvent', createdAt: '2026-09-12T00:00:00Z', beforeCommit: null }], STACKED_PR.baseRefOid, '2026-09-10T00:00:00Z').ok, false);
});

test('mining a stacked pull request compares the reviewed commit against the base tip at review time', async () => {
  const dependencies = miningDependencies();
  const mined = await mineCandidates(dependencies);
  assert.equal(mined.ok, true);
  if (!mined.ok) return;
  assert.equal(mined.outcomes.length, 1);
  const [outcome] = mined.outcomes;
  assert.equal(outcome.refusal, null);
  assert.deepEqual(dependencies.comparisons, [[BASE_AT_REVIEW, REVIEWED_SHA]]);
  const candidate = BenchmarkCase.parse(outcome.candidate);
  assert.equal(candidate.id, '464');
  assert.deepEqual(candidate.source, { kind: 'github-pr', repo: 'Acme/gateway', number: 464, url: 'https://github.com/Acme/gateway/pull/464', minedAt: 5000 });
  const input = PrCheckoutCaseInput.parse(candidate.input);
  assert.equal(input.reviewedSha, REVIEWED_SHA);
  assert.equal(input.baseSha, MERGE_BASE);
  assert.deepEqual(input.changedFiles, ['src/stream.ts', 'src/usage.ts']);
});

test('mining skips known cases and listings under the body count without fetching their review data', async () => {
  const fetchedNumbers: number[] = [];
  const dependencies = miningDependencies({
    knownCaseIds: new Set(['464']),
    listMergedPrs: async () => ({ ok: true, prs: [listing(464), listing(465, 2), listing(466)] }),
    reviewData: async (_repo, numbers) => {
      fetchedNumbers.push(...numbers);
      return new Map(numbers.map((number) => [number, STACKED_PR]));
    },
  });
  const mined = await mineCandidates(dependencies);
  assert.equal(mined.ok, true);
  assert.deepEqual(fetchedNumbers, [466]);
});

test('mining refuses a candidate with too few references, truncated pages, missing data or an incomplete file list', async () => {
  const refusalFor = async (overrides: Partial<MiningDependencies>) => {
    const mined = await mineCandidates(miningDependencies(overrides));
    assert.equal(mined.ok, true);
    if (!mined.ok) return null;
    return mined.outcomes[0]?.refusal ?? null;
  };
  assert.match(String(await refusalFor({ minBodies: 8 })), /7 review bodies on the reviewed commit, fewer than 8/);
  const truncated = { ...STACKED_PR, reviewThreads: { ...STACKED_PR.reviewThreads, pageInfo: { hasNextPage: true } } };
  assert.match(String(await refusalFor({ reviewData: async () => new Map([[464, truncated]]) })), /more review threads/);
  assert.match(String(await refusalFor({ reviewData: async () => new Map() })), /no review data/);
  assert.match(String(await refusalFor({ compareCommits: async () => null })), /could not compare/);
  assert.match(String(await refusalFor({ compareCommits: async () => ({ mergeBaseSha: MERGE_BASE, changedFiles: [], isFileListComplete: false }) })), /more files/);
});

test('a failed listing fails the whole mine with its reason', async () => {
  const mined = await mineCandidates(miningDependencies({ listMergedPrs: async () => ({ ok: false, reason: 'gh graphql search failed' }) }));
  assert.deepEqual(mined, { ok: false, reason: 'gh graphql search failed' });
});
