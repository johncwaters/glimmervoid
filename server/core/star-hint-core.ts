import { STAR_HINT_PROMPT_THRESHOLD } from '../../shared/contracts/star-hint.ts';
import type { StarHintOutcome, StarHintState } from '../../shared/contracts/star-hint.ts';

interface HookEventNotice {
  event: string;
  payload: Record<string, unknown>;
}

const FIELDS_OLDER_BUILDS_REQUIRE = Object.freeze({ signalsByFeature: {}, settledByFeature: {}, lastShownAtByView: {}, pendingHint: null });

function emptyStarHintState(): StarHintState {
  return { ...FIELDS_OLDER_BUILDS_REQUIRE, starHintPromptCount: 0, starHintOutcome: null };
}

function isOperatorPromptEvent({ event, payload }: HookEventNotice): boolean {
  return event.toLowerCase() === 'userpromptsubmit' && typeof payload.prompt === 'string' && payload.prompt.trim() !== '';
}

function countStarHintPrompt(state: StarHintState): StarHintState {
  if (state.starHintOutcome !== null || state.starHintPromptCount >= STAR_HINT_PROMPT_THRESHOLD) return state;
  return { ...state, starHintPromptCount: state.starHintPromptCount + 1 };
}

function isStarHintPending(state: StarHintState): boolean {
  return state.starHintOutcome === null && state.starHintPromptCount >= STAR_HINT_PROMPT_THRESHOLD;
}

function settleStarHint(state: StarHintState, outcome: StarHintOutcome): StarHintState {
  if (state.starHintOutcome !== null) return state;
  return { ...state, starHintOutcome: outcome };
}

export { countStarHintPrompt, emptyStarHintState, isOperatorPromptEvent, isStarHintPending, settleStarHint };
export type { HookEventNotice };
