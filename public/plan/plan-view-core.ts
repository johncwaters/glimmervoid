import { CONTROL_FRAME_ENVELOPE_BYTES, CONTROL_FRAME_MAX_BYTES } from '#shared/contracts/control-messages.ts';
import {
  PLAN_BODY_CAP_BYTES,
  PLAN_COMMENTS_MAX,
  PLAN_COMMENT_MAX_CHARS,
  PLAN_HOOK_OUTPUT_MAX_CHARS,
} from '#shared/contracts/plan-review.ts';
import type {
  PlanChangedPush,
  PlanDecisionKind,
  PlanReview,
  PlanReviewState,
  PlanSectionComment,
} from '#shared/contracts/plan-review.ts';

export type PlanChangedMessage = PlanChangedPush;

export type PlanActionKind = Extract<PlanDecisionKind, 'approve' | 'revise' | 'terminal'>;
export type PlanMode = 'read' | 'changes' | 'edit';

export interface PlanViewInput {
  state: PlanReviewState;
  selectedAgentId: string | null;
  selectedRevision: number | null;
  body: string | null;
  isConnected: boolean;
  isDecisionInFlight?: boolean;
  isDraft?: boolean;
  pendingCommentCount?: number;
  hasUnsavedComment?: boolean;
  problem?: string | null;
}

export interface PlanDecisionExtras {
  comments?: PlanSectionComment[];
  plan?: string;
}

export interface PlanActionView {
  kind: PlanActionKind;
  label: string;
  enabled: boolean;
}

const ACTION_LABELS: readonly { kind: PlanActionKind; label: string }[] = Object.freeze([
  { kind: 'approve', label: 'Approve' },
  { kind: 'revise', label: 'Send feedback' },
  { kind: 'terminal', label: 'Answer in terminal' },
]);

export function isApprovalDecision(decision: PlanDecisionKind | null): boolean {
  return decision === 'approve' || decision === 'approve-accept-edits';
}

export function isApprovedReview(review: PlanReview): boolean {
  const isSettled = review.state === 'decided' || review.state === 'closed';
  return isSettled && isApprovalDecision(review.lastDecision);
}

export function isApprovalConfirmed(state: PlanReviewState, agentId: string | null): boolean {
  const review = state.reviews.find((candidate) => candidate.agentId === agentId);
  return review !== undefined && isApprovedReview(review);
}

function reviewFor(state: PlanReviewState, selectedAgentId: string | null) {
  return state.reviews.find((review) => review.agentId === selectedAgentId) ?? state.reviews[0] ?? null;
}

function selectedRevisionFor(input: PlanViewInput) {
  const review = reviewFor(input.state, input.selectedAgentId);
  if (!review) return null;
  if (input.selectedRevision && review.revisions.some((entry) => entry.revision === input.selectedRevision)) {
    return input.selectedRevision;
  }
  return review.revisions.at(-1)?.revision ?? null;
}

export function openRevisionFor(state: PlanReviewState, selectedAgentId: string | null): number | null {
  return reviewFor(state, selectedAgentId)?.openRevision?.revision ?? null;
}

export function previousRevisionFor(
  state: PlanReviewState,
  selectedAgentId: string | null,
  revision: number | null,
): number | null {
  if (revision === null) return null;
  const revisions = reviewFor(state, selectedAgentId)?.revisions ?? [];
  const position = revisions.findIndex((entry) => entry.revision === revision);
  if (position <= 0) return null;
  return revisions[position - 1].revision;
}

export function formatRelativeAge(receivedAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - receivedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return 'just now';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function isDecidable(input: PlanViewInput, review: PlanReview | null, selectedRevision: number | null): boolean {
  return review !== null
    && review.state === 'open'
    && review.openRevision !== null
    && review.openRevision.revision === selectedRevision
    && input.body !== null
    && input.isConnected
    && input.isDraft !== true
    && !input.isDecisionInFlight;
}

function actionsFor(input: PlanViewInput, review: PlanReview | null, selectedRevision: number | null): PlanActionView[] {
  const canDecide = isDecidable(input, review, selectedRevision);
  const hasComments = (input.pendingCommentCount ?? 0) > 0;
  const canSendOrApprove = input.hasUnsavedComment !== true;
  return ACTION_LABELS.map(({ kind, label }) => ({
    kind,
    label,
    enabled: canDecide && (kind === 'terminal' || (canSendOrApprove && (kind === 'revise' ? hasComments : !hasComments))),
  }));
}

function reviewStatus(review: PlanReview, revision: number | null): string {
  if (review.openRevision !== null) {
    if (review.openRevision.revision === revision) return '';
    return `Rev ${review.openRevision.revision} is the one open`;
  }
  if (revision !== null && review.approvedRevision === revision) return 'Approved';
  if (review.state === 'released') return 'Answer in the terminal';
  if (review.state === 'decided') {
    return review.lastDecision === 'revise' ? 'Feedback sent, waiting for the next revision' : 'Approved';
  }
  return 'Closed';
}

function composedFeedbackChars(extras: PlanDecisionExtras): number {
  let total = 0;
  for (const entry of extras.comments ?? []) total += entry.comment.trim().length + (entry.heading?.length ?? 0);
  return total;
}

function decisionFrameBytes(extras: PlanDecisionExtras): number {
  return new TextEncoder().encode(JSON.stringify(extras)).byteLength + CONTROL_FRAME_ENVELOPE_BYTES;
}

export function planLimitRefusal(extras: PlanDecisionExtras): string | null {
  const plan = extras.plan;
  if (plan !== undefined && plan.length === 0) return 'the edited plan is empty, so nothing was sent';
  if (plan !== undefined && new TextEncoder().encode(plan).byteLength > PLAN_BODY_CAP_BYTES) {
    return 'the edited plan is over the plan size cap, so nothing was sent';
  }
  const comments = extras.comments ?? [];
  if (comments.length > PLAN_COMMENTS_MAX) {
    return `more than ${PLAN_COMMENTS_MAX} section comments are pending, so nothing was sent`;
  }
  const overCap = comments.find((entry) => entry.comment.length > PLAN_COMMENT_MAX_CHARS
    || (entry.heading?.length ?? 0) > PLAN_COMMENT_MAX_CHARS);
  if (overCap) return `a section comment is over ${PLAN_COMMENT_MAX_CHARS} characters, so nothing was sent`;
  if (composedFeedbackChars(extras) > PLAN_HOOK_OUTPUT_MAX_CHARS) {
    return `the feedback composes more than the ${PLAN_HOOK_OUTPUT_MAX_CHARS} characters the hook reply carries, so nothing was sent`;
  }
  if (decisionFrameBytes(extras) > CONTROL_FRAME_MAX_BYTES) {
    return 'the decision is larger than one control frame carries, so nothing was sent';
  }
  return null;
}

function problemNote(problem: string | null | undefined): string {
  if (!problem) return '';
  return `, ${problem}`;
}

function statusDetail(input: PlanViewInput, review: PlanReview | null, revision: number | null): string {
  if (!input.isConnected) return 'Disconnected';
  if (!review || revision === null) return 'No plan revision selected';
  if (input.isDecisionInFlight) return 'Sending your decision';
  if (input.body === null) return 'Loading';
  if (input.isDraft === true) return 'Draft';
  const reviewDetail = reviewStatus(review, revision);
  if (reviewDetail) return reviewDetail;
  if (input.hasUnsavedComment === true) return 'Save or cancel the open comment first.';
  const count = input.pendingCommentCount ?? 0;
  if (count <= 0) return '';
  return count === 1 ? '1 comment to send. Remove it to approve.' : `${count} comments to send. Remove them to approve.`;
}

function statusLine(input: PlanViewInput, review: PlanReview | null, revision: number | null): string {
  const detail = statusDetail(input, review, revision);
  if (!detail) return input.problem ?? '';
  return `${detail}${problemNote(input.problem)}`;
}

export function createPlanViewModel(input: PlanViewInput) {
  const review = reviewFor(input.state, input.selectedAgentId);
  const selectedRevision = selectedRevisionFor(input);
  return {
    tabs: input.state.reviews.map((entry) => ({
      agentId: entry.agentId,
      label: entry.agentId === null ? 'Main' : entry.agentType || 'Agent',
      selected: entry === review,
    })),
    revisions: (review?.revisions ?? []).map((entry) => ({
      revision: entry.revision,
      label: `Rev ${entry.revision}`,
      isOpen: entry.revision === review?.openRevision?.revision,
      receivedAt: entry.receivedAt,
      selected: entry.revision === selectedRevision,
    })),
    selectedAgentId: review?.agentId ?? null,
    selectedRevision,
    previousRevision: previousRevisionFor(input.state, review?.agentId ?? null, selectedRevision),
    status: statusLine(input, review, selectedRevision),
    actions: actionsFor(input, review, selectedRevision),
    modes: [
      { kind: 'read' as const, label: 'Read', enabled: true },
      { kind: 'changes' as const, label: 'Changes', enabled: previousRevisionFor(input.state, review?.agentId ?? null, selectedRevision) !== null && input.isDraft !== true },
      { kind: 'edit' as const, label: 'Edit', enabled: isDecidable(input, review, selectedRevision) },
    ],
  };
}

export function mergePlanChanged(state: PlanReviewState, message: PlanChangedMessage): PlanReviewState {
  const reviewIndex = state.reviews.findIndex((review) => review.agentId === message.agentId);
  const currentReview = reviewIndex === -1 ? null : state.reviews[reviewIndex];
  const revisions = [...(currentReview?.revisions ?? [])];
  const knownRevisionIndex = revisions.findIndex((entry) => entry.revision === message.revision);
  const summary = { revision: message.revision, receivedAt: message.receivedAt, chars: message.chars, title: message.title };
  revisions[knownRevisionIndex === -1 ? revisions.length : knownRevisionIndex] = summary;
  revisions.sort((left, right) => left.revision - right.revision);
  const review: PlanReview = {
    agentId: message.agentId,
    agentType: message.agentType,
    revisions,
    state: message.state,
    openRevision: message.state === 'open' ? { revision: message.revision, since: message.receivedAt } : null,
    approvedRevision: message.approvedRevision,
    lastDecision: message.lastDecision,
  };
  const reviews = [...state.reviews];
  reviews[reviewIndex === -1 ? reviews.length : reviewIndex] = review;
  return { reviews };
}

export interface ReadingPosition {
  headingOffsets: readonly number[];
  scrollTop: number;
  isScrolledToEnd: boolean;
  readingLineOffset: number;
}

export function currentHeadingIndex({ headingOffsets, scrollTop, isScrolledToEnd, readingLineOffset }: ReadingPosition): number | null {
  if (headingOffsets.length === 0) return null;
  if (isScrolledToEnd) return headingOffsets.length - 1;
  const readingLine = scrollTop + readingLineOffset;
  let currentIndex = 0;
  for (let index = 0; index < headingOffsets.length; index++) {
    if (headingOffsets[index] > readingLine) break;
    currentIndex = index;
  }
  return currentIndex;
}
