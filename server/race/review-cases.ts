import fsp from 'node:fs/promises';
import path from 'node:path';

import type { RaceReviewCase, ReviewCaseEntry } from '../../shared/contracts/race.ts';
import { PrCheckoutCaseInput, ReviewCase } from '../../shared/contracts/review-case.ts';
import { errorMessage } from '../../shared/text.ts';
import { mineCandidates } from '../core/review-case-mining-core.ts';
import { githubStoreRateLimitedError } from '../github/github-store-poller.ts';
import type { GithubStoreRead } from '../github/github-store-poller.ts';
import type { GithubLaneStore } from '../github/github-store-wiring.ts';
import { writeJsonAtomic } from '../json-file.ts';
import { clock } from '../../shared/clock.ts';

const LEGACY_CASES_FOLDER = 'cases';
const MINED_PULL_REQUEST_LIMIT = 30;
const MIN_REVIEW_BODIES = 2;

type MineOutcome = { ok: true; mined: number; refused: number } | { ok: false; error: string };

interface ReviewCaseLibraryDependencies {
  minedRoot: string;
  legacySuitesRoot: string;
  store: Pick<GithubLaneStore, 'requestMergedPrs' | 'requestReviewCaseData' | 'requestCompareCommits'>;
  now?: () => number;
  log: Pick<Console, 'warn'>;
}

function raceReviewCaseOf(reviewCase: ReviewCase): RaceReviewCase | null {
  const input = PrCheckoutCaseInput.safeParse(reviewCase.input);
  if (!input.success) return null;
  return { caseId: reviewCase.id, repo: input.data.repo, baseSha: input.data.baseSha, headSha: input.data.reviewedSha, changedFiles: input.data.changedFiles, references: reviewCase.references };
}

function titleOf(reviewCase: ReviewCase, repo: string): string {
  const title = reviewCase.input.title;
  return typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 300) : `${repo} ${reviewCase.id}`;
}

const SAFE_FOLDER_NAME = /^[a-z0-9._-]{1,100}$/;

function isSafeFolderName(name: string): boolean {
  return SAFE_FOLDER_NAME.test(name) && name !== '.' && name !== '..';
}

function minedCasesDirOf(minedRoot: string, repo: string): string | null {
  const [owner, name] = repo.toLowerCase().split('/');
  if (!isSafeFolderName(owner) || !isSafeFolderName(name)) return null;
  return path.join(minedRoot, owner, name);
}

async function readCase(filePath: string): Promise<ReviewCase | null> {
  const text = await fsp.readFile(filePath, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const parsed = ReviewCase.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function caseFileNames(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
}

async function subfolderNames(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && isSafeFolderName(entry.name.toLowerCase())).map((entry) => entry.name).sort();
}

async function entriesIn(casesDir: string, keyPrefix: string): Promise<ReviewCaseEntry[]> {
  const entries: ReviewCaseEntry[] = [];
  for (const fileName of await caseFileNames(casesDir)) {
    const reviewCase = await readCase(path.join(casesDir, fileName));
    const raceCase = reviewCase ? raceReviewCaseOf(reviewCase) : null;
    if (!reviewCase || !raceCase) continue;
    entries.push({ key: `${keyPrefix}/${reviewCase.id}`, title: titleOf(reviewCase, raceCase.repo), url: reviewCase.source.kind === 'github-pr' ? reviewCase.source.url : null, reviewCase: raceCase });
  }
  return entries;
}

function createReviewCaseLibrary({ minedRoot, legacySuitesRoot, store, now = clock.nowMs, log }: ReviewCaseLibraryDependencies) {
  async function list(): Promise<ReviewCaseEntry[]> {
    const entries: ReviewCaseEntry[] = [];
    for (const owner of await subfolderNames(minedRoot)) {
      for (const name of await subfolderNames(path.join(minedRoot, owner))) entries.push(...await entriesIn(path.join(minedRoot, owner, name), `${owner}/${name}`));
    }
    for (const suite of await subfolderNames(legacySuitesRoot)) entries.push(...await entriesIn(path.join(legacySuitesRoot, suite, LEGACY_CASES_FOLDER), `suite ${suite}`));
    return entries;
  }

  async function mine(repo: string): Promise<MineOutcome> {
    const casesDir = minedCasesDirOf(minedRoot, repo);
    if (!casesDir) return { ok: false, error: `${repo} is not a GitHub owner/repo name.` };
    const knownCaseIds = new Set((await caseFileNames(casesDir)).map((fileName) => fileName.replace(/\.json$/, '')));
    let rateLimitWaitMs: number | null = null;
    async function miningRead<Value>(read: () => Promise<GithubStoreRead<Value>>, fallback: Value): Promise<Value> {
      if (rateLimitWaitMs !== null) return fallback;
      const response = await read();
      if (!response.isRateLimited) return response.value;
      rateLimitWaitMs = response.waitMs;
      return fallback;
    }
    const mined = await mineCandidates({
      repo, limit: MINED_PULL_REQUEST_LIMIT, minBodies: MIN_REVIEW_BODIES, knownCaseIds, now,
      listMergedPrs: (slug, limit) => miningRead(() => store.requestMergedPrs(slug, limit, 'no-wait'), { ok: false, reason: 'gh graphql search failed' }),
      reviewData: (slug, numbers) => miningRead(() => store.requestReviewCaseData(slug, numbers, 'no-wait'), new Map()),
      compareCommits: (slug, base, head) => miningRead(() => store.requestCompareCommits(slug, base, head, 'no-wait'), null),
    });
    if (rateLimitWaitMs !== null) return { ok: false, error: githubStoreRateLimitedError(rateLimitWaitMs, 'merged pull requests') };
    if (!mined.ok) return { ok: false, error: mined.reason };
    await fsp.mkdir(casesDir, { recursive: true });
    let minedCount = 0;
    for (const outcome of mined.outcomes) {
      if (!outcome.candidate) {
        log.warn(`[race] ${repo}#${outcome.number} not mined as a review case: ${outcome.refusal}`);
        continue;
      }
      const written = await writeJsonAtomic(path.join(casesDir, `${outcome.candidate.id}.json`), outcome.candidate).then(() => true, (error: unknown) => {
        log.warn(`[race] could not save review case ${repo}#${outcome.number}: ${errorMessage(error)}`);
        return false;
      });
      if (written) minedCount += 1;
    }
    return { ok: true, mined: minedCount, refused: mined.outcomes.length - minedCount };
  }

  return { list, mine };
}

type ReviewCaseLibrary = ReturnType<typeof createReviewCaseLibrary>;

export { createReviewCaseLibrary };
export type { ReviewCaseLibrary };
