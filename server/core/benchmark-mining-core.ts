import type {
  BenchmarkCase, BenchmarkReference, CommitComparison, MergedPrListing, MinedBaseEvent, MinedPrReviewData, MinedReviewThread,
} from '../../shared/contracts/benchmark.ts';

type Refusal = { ok: false; reason: string };

interface InlineReferenceSource {
  reference: BenchmarkReference;
  commit: string | null;
  createdAt: string;
}

interface ReviewedRange {
  reviewedSha: string;
  references: BenchmarkReference[];
  earliestAt: string;
  latestAt: string;
}

interface MiningDependencies {
  repo: string;
  limit: number;
  minBodies: number;
  knownCaseIds: ReadonlySet<string>;
  now: () => number;
  listMergedPrs: (repo: string, limit: number) => Promise<{ ok: true; prs: MergedPrListing[] } | Refusal>;
  reviewData: (repo: string, numbers: readonly number[]) => Promise<Map<number, MinedPrReviewData>>;
  compareCommits: (repo: string, base: string, head: string) => Promise<CommitComparison | null>;
}

interface MinedCandidateOutcome {
  number: number;
  candidate: BenchmarkCase | null;
  refusal: string | null;
}

function isBotAuthor(author: { __typename: string; login: string } | null): boolean {
  if (!author) return false;
  return author.__typename === 'Bot' || author.login.endsWith('[bot]');
}

function authorTags(author: { __typename: string; login: string } | null): string[] {
  return [isBotAuthor(author) ? 'bot' : 'human'];
}

function isFromPrAuthor(author: { login: string } | null, prAuthorLogin: string | null): boolean {
  return author !== null && prAuthorLogin !== null && author.login === prAuthorLogin;
}

function inlineReferenceFrom(thread: MinedReviewThread, prAuthorLogin: string | null): InlineReferenceSource | null {
  const opening = thread.comments.nodes[0];
  if (!opening) return null;
  if (isFromPrAuthor(opening.author, prAuthorLogin)) return null;
  const text = opening.body.trim();
  if (!text) return null;
  const lineAtReviewedCommit = thread.originalLine ?? thread.line;
  return {
    reference: {
      id: `c${opening.databaseId}`,
      text,
      tags: authorTags(opening.author),
      path: thread.path,
      ...(lineAtReviewedCommit === null ? {} : { line: lineAtReviewedCommit }),
    },
    commit: opening.originalCommit?.oid ?? null,
    createdAt: opening.createdAt,
  };
}

function mostCommonCommit(commits: readonly string[]): { ok: true; sha: string } | Refusal {
  const countsBySha = new Map<string, number>();
  for (const sha of commits) countsBySha.set(sha, (countsBySha.get(sha) ?? 0) + 1);
  const ranked = [...countsBySha.entries()].sort((left, right) => right[1] - left[1]);
  const [leader, runnerUp] = ranked;
  if (!leader) return { ok: false, reason: 'no inline review comment names the commit it was written on' };
  if (runnerUp && runnerUp[1] === leader[1]) return { ok: false, reason: `inline comments split evenly between ${leader[0].slice(0, 8)} and ${runnerUp[0].slice(0, 8)}` };
  return { ok: true, sha: leader[0] };
}

function reviewedRangeFrom(data: MinedPrReviewData): { ok: true; range: ReviewedRange } | Refusal {
  const prAuthorLogin = data.author?.login ?? null;
  const inlineSources = data.reviewThreads.nodes
    .map((thread) => inlineReferenceFrom(thread, prAuthorLogin))
    .filter((source): source is InlineReferenceSource => source !== null);
  const reviewedCommit = mostCommonCommit(inlineSources.flatMap((source) => (source.commit ? [source.commit] : [])));
  if (!reviewedCommit.ok) return reviewedCommit;
  const reviewedSha = reviewedCommit.sha;
  const inlineAtReviewedSha = inlineSources.filter((source) => source.commit === reviewedSha);
  const reviewBodiesAtReviewedSha = data.reviews.nodes.flatMap((review) => {
    if (review.commit?.oid !== reviewedSha) return [];
    if (isFromPrAuthor(review.author, prAuthorLogin)) return [];
    const text = review.body.trim();
    if (!text || !review.submittedAt) return [];
    return [{ reference: { id: `r${review.databaseId}`, text, tags: authorTags(review.author) }, createdAt: review.submittedAt }];
  });
  const timestamps = [...inlineAtReviewedSha, ...reviewBodiesAtReviewedSha].map((source) => source.createdAt).sort();
  return {
    ok: true,
    range: {
      reviewedSha,
      references: [...inlineAtReviewedSha, ...reviewBodiesAtReviewedSha].map((source) => source.reference),
      earliestAt: timestamps[0] ?? '',
      latestAt: timestamps[timestamps.length - 1] ?? '',
    },
  };
}

function baseTipAt(events: readonly MinedBaseEvent[], currentBaseOid: string, at: string): { ok: true; sha: string } | Refusal {
  const laterEvents = events.filter((event) => event.createdAt > at).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const firstLater = laterEvents[0];
  if (!firstLater) return { ok: true, sha: currentBaseOid };
  if (firstLater.__typename === 'BaseRefChangedEvent') return { ok: false, reason: 'the base branch was retargeted after the review, so the reviewed base is unknown' };
  if (!firstLater.beforeCommit) return { ok: false, reason: 'the base branch was force-pushed after the review and GitHub no longer names its earlier tip' };
  return { ok: true, sha: firstLater.beforeCommit.oid };
}

function reviewedBaseTip(data: MinedPrReviewData, range: ReviewedRange): { ok: true; sha: string } | Refusal {
  const atEarliest = baseTipAt(data.timelineItems.nodes, data.baseRefOid, range.earliestAt);
  if (!atEarliest.ok) return atEarliest;
  const atLatest = baseTipAt(data.timelineItems.nodes, data.baseRefOid, range.latestAt);
  if (!atLatest.ok) return atLatest;
  if (atEarliest.sha !== atLatest.sha) return { ok: false, reason: 'the base branch moved while the reviewed commit was under review' };
  return atEarliest;
}

function truncationRefusal(data: MinedPrReviewData): string | null {
  if (data.reviewThreads.pageInfo.hasNextPage) return 'more review threads than one page holds';
  if (data.reviews.pageInfo.hasNextPage) return 'more reviews than one page holds';
  if (data.timelineItems.pageInfo.hasNextPage) return 'more base branch events than one page holds';
  return null;
}

function hasEnoughReviewBodies(listing: MergedPrListing, minBodies: number): boolean {
  return listing.reviewThreads.totalCount + listing.reviews.totalCount >= minBodies;
}

async function mineCandidate(
  listing: MergedPrListing,
  data: MinedPrReviewData | undefined,
  dependencies: MiningDependencies,
): Promise<MinedCandidateOutcome> {
  const refuse = (reason: string): MinedCandidateOutcome => ({ number: listing.number, candidate: null, refusal: reason });
  if (!data) return refuse('GitHub returned no review data');
  const truncated = truncationRefusal(data);
  if (truncated) return refuse(truncated);
  const reviewed = reviewedRangeFrom(data);
  if (!reviewed.ok) return refuse(reviewed.reason);
  const { range } = reviewed;
  if (range.references.length < dependencies.minBodies) return refuse(`${range.references.length} review bodies on the reviewed commit, fewer than ${dependencies.minBodies}`);
  const baseTip = reviewedBaseTip(data, range);
  if (!baseTip.ok) return refuse(baseTip.reason);
  const comparison = await dependencies.compareCommits(dependencies.repo, baseTip.sha, range.reviewedSha);
  if (!comparison) return refuse('GitHub could not compare the reviewed commit with its base');
  if (!comparison.isFileListComplete) return refuse('the reviewed diff has more files than GitHub lists');
  return {
    number: listing.number,
    refusal: null,
    candidate: {
      id: String(listing.number),
      input: {
        repo: dependencies.repo,
        number: listing.number,
        title: listing.title,
        reviewedSha: range.reviewedSha,
        baseSha: comparison.mergeBaseSha,
        changedFiles: comparison.changedFiles,
      },
      references: range.references,
      source: { kind: 'github-pr', repo: dependencies.repo, number: listing.number, url: listing.url, minedAt: dependencies.now() },
    },
  };
}

async function mineCandidates(dependencies: MiningDependencies): Promise<{ ok: true; outcomes: MinedCandidateOutcome[] } | Refusal> {
  const listed = await dependencies.listMergedPrs(dependencies.repo, dependencies.limit);
  if (!listed.ok) return listed;
  const unseen = listed.prs.filter((listing) => !dependencies.knownCaseIds.has(String(listing.number)));
  const eligible = unseen.filter((listing) => hasEnoughReviewBodies(listing, dependencies.minBodies));
  const dataByNumber = await dependencies.reviewData(dependencies.repo, eligible.map((listing) => listing.number));
  const outcomes: MinedCandidateOutcome[] = [];
  for (const listing of eligible) outcomes.push(await mineCandidate(listing, dataByNumber.get(listing.number), dependencies));
  return { ok: true, outcomes };
}

export { baseTipAt, mineCandidates, mostCommonCommit, reviewedRangeFrom };
export type { MinedCandidateOutcome, MiningDependencies };
