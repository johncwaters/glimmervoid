import { z } from 'zod';
import type { ClientMessage } from './control-messages.ts';
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

export const REVIEW_ACTION_TYPES = [
  'team-review-action', 'open-team-review-session', 'my-pr-merge', 'my-pr-merge-when-ready', 'my-pr-keep-mergeable',
  'pr-flow-dispose', 'pr-flow-undo', 'pr-flow-save-rule', 'pr-flow-approve', 'pr-action-run',
] as const satisfies readonly ClientMessage['type'][];

const REVIEW_ACTION_GRANTS: { readonly [Type in (typeof REVIEW_ACTION_TYPES)[number]]: string } = {
  'team-review-action': 'post, discard or requeue team reviews and resolve their threads',
  'open-team-review-session': 'open an agent session on a pull request',
  'my-pr-merge': 'merge your pull requests',
  'my-pr-merge-when-ready': 'turn merge when ready on or off',
  'my-pr-keep-mergeable': 'turn keep mergeable on or off',
  'pr-flow-dispose': 'dismiss review items, hand them to a session or run their actions',
  'pr-flow-undo': 'reopen handled review items',
  'pr-flow-save-rule': 'save rules to your config',
  'pr-flow-approve': 'approve PR flow commands',
  'pr-action-run': 'run PR actions',
};

export const REVIEW_ACTIONS_GRANT_TEXT = REVIEW_ACTION_TYPES.map((type) => REVIEW_ACTION_GRANTS[type]).join(', ');

export const ReviewsSnapshot = z.object({ groups: z.array(ReviewQueueGroup).describe('The Reviews tab queue in display order: your turn, agent working, waiting on others, set aside') });
export type ReviewsSnapshot = z.infer<typeof ReviewsSnapshot>;
