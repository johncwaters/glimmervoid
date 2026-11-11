import { z } from 'zod';

export const REVIEW_TEXT_MAX_CHARS = 20000;

export const ReviewCommentId = z.string().regex(/^c-[0-9a-f]{8}$/);

const ReviewReply = z.strictObject({
  text: z.string().min(1).max(REVIEW_TEXT_MAX_CHARS),
  at: z.number().int(),
});

export const ReviewComment = z.strictObject({
  id: ReviewCommentId,
  path: z.string().min(1).max(4096),
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
  lineText: z.string().max(REVIEW_TEXT_MAX_CHARS),
  text: z.string().min(1).max(REVIEW_TEXT_MAX_CHARS),
  sentAt: z.number().int(),
  status: z.enum(['open', 'resolved']),
  resolvedBy: z.enum(['operator', 'agent']).nullable(),
  replies: z.array(ReviewReply),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const ReviewState = z.strictObject({
  version: z.literal(1),
  viewedHashByPath: z.record(z.string(), z.string().nullable()),
  comments: z.array(ReviewComment),
});
export type ReviewState = z.infer<typeof ReviewState>;
