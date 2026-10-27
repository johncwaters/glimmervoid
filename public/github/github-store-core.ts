import { comparablePrKey } from '#shared/contracts/github-prs.ts';
import type { GithubPr } from '#shared/contracts/github-prs.ts';
import type { LinkedPr, MyPr, MyPrLaneEntry, MyPrStage } from '#shared/contracts/my-prs.ts';
import { DECIDING_REVIEW_STATES, decisionAsIfApprovalRequired, hasStandingViewerApproval } from '#shared/contracts/team-review.ts';
import type { GithubReview, InFlightReview, QueuedReview, ReviewDraft, TeamReviewStatus, TeamReviewThread } from '#shared/contracts/team-review.ts';
import { myPrFromGithubPr } from '#shared/my-pr-merge.ts';
import type { StateTone } from '../state-tone-core.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';

interface MyPrSection { title: string; prs: MyPr[] }

const SECTION_TITLES_BY_URGENCY = ['Needs you', 'Waiting', 'Ready to merge', 'Drafts', 'Merged today'] as const;

type SectionTitle = typeof SECTION_TITLES_BY_URGENCY[number];

const SECTION_TITLES_IN_DISPLAY_ORDER: readonly SectionTitle[] = ['Ready to merge', 'Needs you', 'Waiting', 'Drafts', 'Merged today'];

const SECTION_BY_STAGE: Record<MyPrStage, SectionTitle> = {
  conflicts: 'Needs you', behind: 'Needs you', 'checks-failing': 'Needs you', 'changes-requested': 'Needs you', 'unresolved-threads': 'Needs you',
  'checks-pending': 'Waiting', 'needs-approval': 'Waiting', unknown: 'Waiting',
  ready: 'Ready to merge', draft: 'Drafts', merged: 'Merged today',
};

const STAGE_LABELS: Record<MyPrStage, string> = {
  merged: 'Merged', draft: 'Draft', conflicts: 'Merge conflicts', behind: 'Behind base',
  'checks-failing': 'Checks failing', 'changes-requested': 'Changes requested',
  'unresolved-threads': 'Unresolved threads', 'checks-pending': 'Checks running',
  'needs-approval': 'Needs approval', ready: 'Ready to merge', unknown: 'Status unknown',
};

const STAGE_TONES: Record<MyPrStage, StateTone> = {
  merged: 'muted', draft: 'muted', conflicts: 'danger', behind: 'warn', 'checks-failing': 'danger',
  'changes-requested': 'warn', 'unresolved-threads': 'warn', 'checks-pending': 'wait',
  'needs-approval': 'wait', ready: 'ok', unknown: 'muted',
};

const STAGE_ICONS: Record<MyPrStage, PrStatusIcon> = {
  merged: 'merged', draft: 'draft', conflicts: 'conflict', behind: 'behind', 'checks-failing': 'failed',
  'changes-requested': 'changes-requested', 'unresolved-threads': 'thread', 'checks-pending': 'running',
  'needs-approval': 'reviewer', ready: 'ready', unknown: 'unknown',
};

interface MyPrStackRow { pr: MyPr; parentKey: string | null; depth: number }

interface MyPrStack { root: MyPr; rows: MyPrStackRow[] }

function groupStackedMyPrs(prs: readonly MyPr[]): MyPrStack[] {
  const stackParentCandidates = prs.filter((pr) => pr.state === 'OPEN' && !pr.isCrossRepository);
  const prByHeadBranch = new Map(stackParentCandidates.map((pr) => [JSON.stringify([pr.repo.toLowerCase(), pr.headRefName]), pr]));
  const childrenByParentKey = new Map<string, MyPr[]>();
  const roots: MyPr[] = [];
  for (const pr of prs) {
    const parent = pr.state === 'OPEN' ? prByHeadBranch.get(JSON.stringify([pr.repo.toLowerCase(), pr.baseRefName])) : undefined;
    if (!parent || parent.key === pr.key) {
      roots.push(pr);
      continue;
    }
    const children = childrenByParentKey.get(parent.key) ?? [];
    children.push(pr);
    childrenByParentKey.set(parent.key, children);
  }
  const stacks: MyPrStack[] = [];
  const visitedKeys = new Set<string>();
  for (const root of [...roots, ...prs]) {
    if (visitedKeys.has(root.key)) continue;
    const rows: MyPrStackRow[] = [];
    const pendingRows: MyPrStackRow[] = [{ pr: root, parentKey: null, depth: 0 }];
    while (pendingRows.length > 0) {
      const row = pendingRows.pop();
      if (!row || visitedKeys.has(row.pr.key)) continue;
      visitedKeys.add(row.pr.key);
      rows.push(row);
      const children = childrenByParentKey.get(row.pr.key) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pendingRows.push({ pr: children[index], parentKey: row.pr.key, depth: row.depth + 1 });
      }
    }
    stacks.push({ root, rows });
  }
  return stacks;
}

interface MyPrStackSection extends MyPrSection { rows: MyPrStackRow[] }

function mostUrgentSectionTitle(stack: MyPrStack): SectionTitle {
  const mostUrgentIndex = stack.rows.reduce((urgentIndex, { pr }) => Math.min(urgentIndex, SECTION_TITLES_BY_URGENCY.indexOf(SECTION_BY_STAGE[pr.stage])), SECTION_TITLES_BY_URGENCY.length - 1);
  return SECTION_TITLES_BY_URGENCY[mostUrgentIndex];
}

export function sectionStackedMyPrs(prs: readonly MyPr[]): MyPrStackSection[] {
  const sectionsByTitle = new Map(SECTION_TITLES_BY_URGENCY.map((title): [SectionTitle, MyPrStackSection] => [title, { title, prs: [], rows: [] }]));
  for (const stack of groupStackedMyPrs(prs)) {
    const section = sectionsByTitle.get(mostUrgentSectionTitle(stack));
    if (!section) continue;
    for (const row of stack.rows) {
      section.rows.push(row);
      section.prs.push(row.pr);
    }
  }
  return SECTION_TITLES_IN_DISPLAY_ORDER.flatMap((title) => sectionsByTitle.get(title) ?? []);
}

export function stageLabel(stage: MyPrStage): string { return STAGE_LABELS[stage]; }

export function stageTone(stage: MyPrStage): StateTone { return STAGE_TONES[stage]; }

export function stageIcon(stage: MyPrStage): PrStatusIcon { return STAGE_ICONS[stage]; }

export interface LiveSessionLinks { id: string; title: string; links: readonly Pick<LinkedPr, 'repo' | 'number'>[] }

export interface LinkedLiveSession { id: string; title: string }

export function joinMyPrs(entries: readonly MyPrLaneEntry[], findGithubPr: (key: string) => GithubPr | undefined): MyPr[] {
  return entries.flatMap((entry) => {
    const canonicalPr = findGithubPr(entry.key);
    if (!canonicalPr) return [];
    const repo = entry.key.slice(0, entry.key.lastIndexOf('#'));
    return [{ ...myPrFromGithubPr({ ...canonicalPr, repo }), ...entry }];
  });
}

export function liveSessionsByPrKey(sessions: Iterable<LiveSessionLinks>): Map<string, LinkedLiveSession[]> {
  const sessionsByPrKey = new Map<string, LinkedLiveSession[]>();
  for (const session of sessions) {
    for (const link of session.links) {
      const prKey = comparablePrKey(link);
      const linkedSessions = sessionsByPrKey.get(prKey) ?? [];
      if (linkedSessions.at(-1)?.id === session.id) continue;
      linkedSessions.push({ id: session.id, title: session.title });
      sessionsByPrKey.set(prKey, linkedSessions);
    }
  }
  return sessionsByPrKey;
}

export function newlyMergedPrs(previous: readonly MyPr[] | null, next: readonly MyPr[]): MyPr[] {
  if (!previous) return [];
  const openKeys = new Set(previous.filter((pr) => pr.state === 'OPEN').map((pr) => pr.key));
  return next.filter((pr) => pr.state === 'MERGED' && openKeys.has(pr.key));
}

const MAX_CELEBRATED_PR_LINES = 3;

export interface MergeCelebrationText { message: string; detailLines: string[] }

export function mergeCelebrationText(mergedPrs: readonly MyPr[]): MergeCelebrationText {
  if (mergedPrs.length === 1) return { message: `Merged ${mergedPrs[0].key}`, detailLines: [mergedPrs[0].title] };
  const listedPrLines = mergedPrs.slice(0, MAX_CELEBRATED_PR_LINES).map((mergedPr) => `${mergedPr.key} ${mergedPr.title}`);
  const unlistedCount = mergedPrs.length - listedPrLines.length;
  const detailLines = unlistedCount > 0 ? [...listedPrLines, `and ${unlistedCount} more`] : listedPrLines;
  return { message: `Merged ${mergedPrs.length} pull requests`, detailLines };
}

export function joinTeamReviews(status: TeamReviewStatus | null, findGithubPr: (key: string) => GithubPr | undefined) {
  if (!status) return null;
  const joinReview = <Review extends ReviewDraft | InFlightReview | QueuedReview>(review: Review) => {
    const pr = findGithubPr(review.key);
    if (!pr) return review;
    return {
      ...review,
      checksState: pr.rollupState,
      reviewDecision: decisionAsIfApprovalRequired(pr.reviewDecision, pr.opinionatedWriterReviewStates),
      isDraft: pr.isDraft,
      liveHead: pr.headRefOid,
      prStage: myPrFromGithubPr(pr).stage,
    };
  };
  return {
    ...status,
    drafts: status.drafts.map(joinReview),
    inFlight: status.inFlight.map(joinReview),
    queued: status.queued.map(joinReview),
  };
}

export type QueueRowKind = 'ready' | 'settled' | 'inReview' | 'queued' | 'attention' | 'posted' | 'discarded';

type ReviewPriorityBand = 'blocking-others' | 'actionable' | 'waiting-on-author' | 'not-ready';

export type ReviewPriorityReason = 'direct-request' | 'team-request' | 'changes-requested' | 'checks-failing' | 'checks-pending' | 'draft' | 'review-available' | 'approved';

export function classifyReviewPriority(review: Pick<QueuedReview, 'requestSource' | 'isDraft' | 'checksState' | 'reviewDecision'>): { band: ReviewPriorityBand; reason: ReviewPriorityReason } {
  if (review.isDraft) return { band: 'not-ready', reason: 'draft' };
  if (review.reviewDecision === 'CHANGES_REQUESTED') return { band: 'waiting-on-author', reason: 'changes-requested' };
  if (review.checksState === 'FAILURE' || review.checksState === 'ERROR') return { band: 'waiting-on-author', reason: 'checks-failing' };
  if (review.checksState === 'PENDING' || review.checksState === 'EXPECTED') return { band: 'not-ready', reason: 'checks-pending' };
  if (review.requestSource === 'direct' && review.reviewDecision === 'REVIEW_REQUIRED') return { band: 'blocking-others', reason: 'direct-request' };
  if (review.reviewDecision === 'APPROVED') return { band: 'actionable', reason: 'approved' };
  return { band: 'actionable', reason: review.requestSource === 'direct' ? 'review-available' : 'team-request' };
}

export function hasAllViewerThreadsResolved(draft: Pick<ReviewDraft, 'viewerThreads'>): boolean {
  const tally = draft.viewerThreads;
  return tally !== undefined && tally.total > 0 && tally.resolved === tally.total;
}

export function isPostedAwaitingViewer(draft: ReviewDraft): boolean {
  return draft.status === 'posted' && isAwaitingViewerAfterResolvedComments(draft);
}

export function isAwaitingViewerAfterResolvedComments(draft: ReviewDraft): boolean {
  if (!hasAllViewerThreadsResolved(draft)) return false;
  if (hasStandingViewerApproval(draft)) return false;
  const head = currentHead(draft);
  if (draft.status === 'posted' && draft.postedEvent === 'APPROVE' && draft.reviewedHead === head) return false;
  return !(draft.githubReviews ?? []).some((review) => review.isViewer && review.state === 'APPROVED' && review.commit === head);
}

export interface TeamReviewSections {
  ready: ReviewDraft[];
  noReviewNeeded: ReviewDraft[];
  inReview: InFlightReview[];
  queued: QueuedReview[];
  attention: ReviewDraft[];
  posted: ReviewDraft[];
  discarded: ReviewDraft[];
}

export function groupDrafts(status: TeamReviewStatus | null | undefined): TeamReviewSections {
  const sections: TeamReviewSections = { ready: [], noReviewNeeded: [], inReview: [], queued: [], attention: [], posted: [], discarded: [] };
  if (!status) return sections;
  const readyByBand: Record<ReviewPriorityBand, ReviewDraft[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const queuedByBand: Record<ReviewPriorityBand, QueuedReview[]> = { 'blocking-others': [], actionable: [], 'waiting-on-author': [], 'not-ready': [] };
  const bandOrder: ReviewPriorityBand[] = ['blocking-others', 'actionable', 'waiting-on-author', 'not-ready'];
  const inFlightKeys = new Set(status.inFlight.map((review) => review.key));
  sections.inReview.push(...status.inFlight);
  for (const review of status.queued) {
    if (inFlightKeys.has(review.key)) continue;
    queuedByBand[classifyReviewPriority(review).band].push(review);
  }
  for (const band of bandOrder) sections.queued.push(...queuedByBand[band]);
  const queuedKeys = new Set(sections.queued.map((review) => review.key));
  for (const draft of status.drafts) {
    if (inFlightKeys.has(draft.key) || queuedKeys.has(draft.key)) continue;
    if (answeredNonNitThreads(draft).length > 0 || isPostedAwaitingViewer(draft)) {
      readyByBand.actionable.push(draft);
      continue;
    }
    const isSettled = (draft.status === 'ready' || draft.status === 'stale' || draft.status === 'error') && !isReviewNeeded(draft);
    if (isSettled) sections.noReviewNeeded.push(draft);
    if (draft.status === 'ready' && !isSettled) readyByBand[classifyReviewPriority(draft).band].push(draft);
    if ((draft.status === 'stale' || draft.status === 'error') && !isSettled) sections.attention.push(draft);
    if (draft.status === 'posted') sections.posted.push(draft);
    if (draft.status === 'discarded') sections.discarded.push(draft);
  }
  for (const band of bandOrder) sections.ready.push(...readyByBand[band]);
  return sections;
}

function settlesReview(review: GithubReview, head: string): boolean {
  if (review.commit !== head) return false;
  return review.isViewer || DECIDING_REVIEW_STATES.has(review.state);
}

export function currentHead(draft: ReviewDraft): string {
  return draft.liveHead ?? draft.reviewedHead;
}

export function answeredNonNitThreads(draft: Pick<ReviewDraft, 'threads'>): TeamReviewThread[] {
  return (draft.threads ?? []).filter((thread) => !thread.isNit && !thread.isResolved);
}

function isReviewNeeded(draft: ReviewDraft): boolean {
  if (answeredNonNitThreads(draft).length > 0) return true;
  if (hasStandingViewerApproval(draft)) return false;
  if (isAwaitingViewerAfterResolvedComments(draft)) return true;
  return !(draft.githubReviews ?? []).some((review) => settlesReview(review, currentHead(draft)));
}

export function pullRequestLabel(repo: string, number: number): string {
  return `${repo}#${number}`;
}
