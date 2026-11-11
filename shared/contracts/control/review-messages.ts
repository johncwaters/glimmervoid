import { z } from 'zod';
import { REVIEW_TEXT_MAX_CHARS, ReviewComment, ReviewCommentId, ReviewState } from '../review-state.ts';
import { loose, optionalError, requestId, sessionId } from './control-fields.ts';

const reviewText = z.string().trim().min(1).max(REVIEW_TEXT_MAX_CHARS);

export const reviewClientVariants = [
  loose('request-review-state', { id: sessionId }),
  loose('review-mark-viewed', { id: sessionId, requestId, path: ReviewComment.shape.path, contentHash: z.string().nullable(), isViewed: z.boolean() }),
  loose('review-send-comment', {
    id: sessionId,
    requestId,
    path: ReviewComment.shape.path,
    side: ReviewComment.shape.side,
    line: ReviewComment.shape.line,
    lineText: ReviewComment.shape.lineText,
    text: reviewText,
  }),
  loose('review-resolve-comment', { id: sessionId, requestId, commentId: ReviewCommentId }),
] as const;

export const reviewServerVariants = [
  loose('review-state', { id: sessionId, state: ReviewState }),
  loose('review-result', { requestId, ok: z.boolean(), error: optionalError }),
] as const;
