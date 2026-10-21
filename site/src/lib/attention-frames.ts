import { STATES } from '../../../shared/states.ts';
import { BEAT_MS } from './feature-frames.ts';

type ShownState = typeof STATES.RUNNING | typeof STATES.WAITING | typeof STATES.COMPLETE | typeof STATES.FAILED;

export interface AttentionFrame {
  states: readonly ShownState[];
  focusedRow: number | null;
  holdMs: number;
}

const { RUNNING, WAITING, COMPLETE, FAILED } = STATES;

export const ATTENTION_FRAMES: readonly AttentionFrame[] = [
  { states: [RUNNING, WAITING, RUNNING, RUNNING, RUNNING], focusedRow: 1, holdMs: 4 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, RUNNING, RUNNING], focusedRow: null, holdMs: 3 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, COMPLETE, FAILED], focusedRow: 4, holdMs: 4 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, RUNNING, RUNNING], focusedRow: null, holdMs: 3 * BEAT_MS },
];

export const FIRST_ATTENTION_FRAME = ATTENTION_FRAMES[0];

export function attentionBannerOf(frame: AttentionFrame): { state: ShownState; text: string } {
  if (frame.focusedRow === null) return { state: RUNNING, text: 'ALL CLEAR' };
  const focusedState = frame.states[frame.focusedRow];
  if (focusedState === FAILED) return { state: FAILED, text: '1 FAILED' };
  return { state: WAITING, text: '1 NEEDS YOU' };
}
