import { z } from 'zod';
import { MyPr } from './my-prs.ts';
import { UnseenOutcome } from './session.ts';
import { InFlightReview, QueuedReview, ReviewDraft } from './team-review.ts';

export const ReviewQueueGroupId = z.enum(['turn', 'working', 'waiting', 'aside']);
export const ReviewQueueAction = z.enum(['fix', 'review', 'reply', 'update', 'merge']).describe('What the operator does next on this item; null when nothing is theirs to do');
const ReviewQueueRowKind = z.enum(['ready', 'settled', 'inReview', 'queued', 'attention', 'posted', 'discarded']);
const ReviewAttentionKind = z.enum(['waiting', ...UnseenOutcome.options]);

const ReviewStackRow = z.object({
  pr: MyPr,
  parentKey: z.string().nullable().describe('The key of the pull request this one is stacked on; null at the bottom of a stack'),
  depth: z.number().int().nonnegative(),
  stackSize: z.number().int().positive(),
  stackHeight: z.number().int().nonnegative(),
});

const queueItemShape = {
  key: z.string(),
  prKey: z.string().describe('The pull request key, owner/repo#number in lowercase'),
  action: ReviewQueueAction.nullable(),
  attention: ReviewAttentionKind.nullable(),
};

export const ReviewQueueItem = z.discriminatedUnion('source', [
  z.object({ ...queueItemShape, source: z.literal('team').describe("A teammate's pull request the review lane reviews"), kind: ReviewQueueRowKind, review: z.union([ReviewDraft, InFlightReview, QueuedReview]) }),
  z.object({ ...queueItemShape, source: z.literal('mine').describe("One of the operator's own pull requests"), pr: MyPr, stackRow: ReviewStackRow }),
]);

const ReviewQueueGroup = z.object({ id: ReviewQueueGroupId, title: z.string(), items: z.array(ReviewQueueItem) });

export const ReviewsSnapshot = z.object({ groups: z.array(ReviewQueueGroup).describe('The Reviews tab queue in display order: your turn, agent working, waiting on others, set aside') });
export type ReviewsSnapshot = z.infer<typeof ReviewsSnapshot>;
