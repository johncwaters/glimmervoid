import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ReviewState } from '../../shared/contracts/review-state.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { loadJsonStateFile, loadedJsonValue, writeJsonAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import type { ReviewCommentDraft } from './review-state-core.ts';
import { addComment, commentPasteText, emptyReviewState, markViewed, replyToComment, resolveComment } from './review-state-core.ts';

const REVIEWS_FOLDER_NAME = 'reviews';
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_GONE_ERROR = 'That session is no longer on the dashboard.';
const COMMENT_DELIVERY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface PasteTarget {
  pasteTextWhenReady(text: string, options: { submit: boolean; timeoutMs: number }): { ok: boolean; reason?: string };
}

type ReviewOutcome = { ok: true } | { ok: false; error: string };
type CommentInput = Omit<ReviewCommentDraft, 'id' | 'sentAt'>;

interface ReviewPort {
  read(sessionId: string): Promise<ReviewState | null>;
  markViewed(sessionId: string, filePath: string, contentHash: string | null, isViewed: boolean): Promise<ReviewOutcome>;
  sendComment(sessionId: string, input: CommentInput): Promise<ReviewOutcome>;
  reply(sessionId: string, commentId: string, text: string): Promise<ReviewOutcome>;
  resolve(sessionId: string, commentId: string, by: 'operator' | 'agent'): Promise<ReviewOutcome>;
  forgetSession(sessionId: string): Promise<void>;
}

function createReviewWiring({ reviewsRoot, broadcastControl, findSession, now = Date.now }: {
  reviewsRoot: string;
  broadcastControl: (message: ControlMessageRecord) => void;
  findSession: (sessionId: string) => PasteTarget | null;
  now?: () => number;
}): ReviewPort {
  const stateBySessionId = new Map<string, ReviewState>();
  const queue = createKeyedSerialQueue();

  function reviewFileOf(sessionId: string): string {
    return path.join(reviewsRoot, `${sessionId}.json`);
  }

  async function load(sessionId: string): Promise<ReviewState | null> {
    const known = stateBySessionId.get(sessionId);
    if (known) return known;
    const outcome = await loadJsonStateFile({ filePath: reviewFileOf(sessionId), parse: (raw) => ReviewState.safeParse(raw).data ?? null });
    if (outcome.status === 'unreadable' || outcome.status === 'corrupt') return null;
    const loaded = loadedJsonValue(outcome) ?? emptyReviewState();
    stateBySessionId.set(sessionId, loaded);
    return loaded;
  }

  function change(sessionId: string, edit: (state: ReviewState) => { ok: true; state: ReviewState; after?: () => ReviewOutcome } | { ok: false; error: string }): Promise<ReviewOutcome> {
    if (!SAFE_SESSION_ID.test(sessionId) || !findSession(sessionId)) return Promise.resolve({ ok: false, error: SESSION_GONE_ERROR });
    return queue.run(sessionId, async (): Promise<ReviewOutcome> => {
      const state = await load(sessionId);
      if (!state) return { ok: false, error: 'Could not read the saved review for this session, so nothing was changed.' };
      const edited = edit(state);
      if (!edited.ok) return edited;
      await writeJsonAtomic(reviewFileOf(sessionId), edited.state, { mkdir: true });
      stateBySessionId.set(sessionId, edited.state);
      broadcastControl({ type: 'review-state', id: sessionId, state: edited.state });
      return edited.after ? edited.after() : { ok: true };
    });
  }

  async function read(sessionId: string): Promise<ReviewState | null> {
    if (!SAFE_SESSION_ID.test(sessionId)) return emptyReviewState();
    return queue.run(sessionId, () => load(sessionId));
  }

  function sendComment(sessionId: string, input: CommentInput): Promise<ReviewOutcome> {
    const session = findSession(sessionId);
    if (!session) return Promise.resolve({ ok: false, error: SESSION_GONE_ERROR });
    const comment: ReviewCommentDraft = { ...input, id: `c-${crypto.randomBytes(4).toString('hex')}`, sentAt: now() };
    return change(sessionId, (state) => {
      const next = addComment(state, comment);
      const sent = next.comments.at(-1);
      return {
        ok: true,
        state: next,
        after: (): ReviewOutcome => {
          if (!sent) return { ok: true };
          const pasted = session.pasteTextWhenReady(commentPasteText(sent), { submit: true, timeoutMs: COMMENT_DELIVERY_TIMEOUT_MS });
          return pasted.ok ? { ok: true } : { ok: false, error: `The comment was saved, but it could not be sent to the agent (${pasted.reason ?? 'unknown'})` };
        },
      };
    });
  }

  async function forgetSession(sessionId: string): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return;
    await queue.run(sessionId, async () => {
      stateBySessionId.delete(sessionId);
      await fs.promises.rm(reviewFileOf(sessionId), { force: true });
    });
  }

  return {
    read,
    markViewed: (sessionId, filePath, contentHash, isViewed) => change(sessionId, (state) => ({ ok: true, state: markViewed(state, filePath, contentHash, isViewed) })),
    sendComment,
    reply: (sessionId, commentId, text) => change(sessionId, (state) => replyToComment(state, commentId, text, now())),
    resolve: (sessionId, commentId, by) => change(sessionId, (state) => resolveComment(state, commentId, by)),
    forgetSession,
  };
}

export { createReviewWiring, REVIEWS_FOLDER_NAME };
export type { ReviewPort };
