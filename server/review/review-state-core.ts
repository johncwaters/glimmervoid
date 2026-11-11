import type { ReviewComment, ReviewState } from '../../shared/contracts/review-state.ts';

type ReviewCommentDraft = Omit<ReviewComment, 'status' | 'resolvedBy' | 'replies'>;
type ReviewEdit = { ok: true; state: ReviewState } | { ok: false; error: string };

function emptyReviewState(): ReviewState {
  return { version: 1, viewedHashByPath: {}, comments: [] };
}

function markViewed(state: ReviewState, path: string, contentHash: string | null, isViewed: boolean): ReviewState {
  const viewedHashByPath = { ...state.viewedHashByPath };
  if (isViewed) viewedHashByPath[path] = contentHash;
  if (!isViewed) delete viewedHashByPath[path];
  return { ...state, viewedHashByPath };
}

function addComment(state: ReviewState, draft: ReviewCommentDraft): ReviewState {
  return { ...state, comments: [...state.comments, { ...draft, status: 'open', resolvedBy: null, replies: [] }] };
}

function editComment(state: ReviewState, commentId: string, edit: (comment: ReviewComment) => ReviewComment | string): ReviewEdit {
  const comment = state.comments.find((candidate) => candidate.id === commentId);
  if (!comment) return { ok: false, error: `No review comment ${commentId}` };
  const edited = edit(comment);
  if (typeof edited === 'string') return { ok: false, error: edited };
  return { ok: true, state: { ...state, comments: state.comments.map((candidate) => (candidate.id === commentId ? edited : candidate)) } };
}

function replyToComment(state: ReviewState, commentId: string, text: string, at: number): ReviewEdit {
  return editComment(state, commentId, (comment) => {
    if (comment.status === 'resolved') return `Review comment ${commentId} is resolved and takes no reply`;
    return { ...comment, replies: [...comment.replies, { text, at }] };
  });
}

function resolveComment(state: ReviewState, commentId: string, by: 'operator' | 'agent'): ReviewEdit {
  return editComment(state, commentId, (comment) => (comment.status === 'resolved' ? comment : { ...comment, status: 'resolved', resolvedBy: by }));
}

function commentPasteText(comment: ReviewComment): string {
  const sideNote = comment.side === 'old' ? ' (old side)' : '';
  return `Review comment ${comment.id} on ${comment.path}:${comment.line}${sideNote}:\n${comment.text}\nAnswer it in your reply.`;
}

export { addComment, commentPasteText, emptyReviewState, markViewed, replyToComment, resolveComment };
export type { ReviewCommentDraft };
