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
  { states: [RUNNING, WAITING, RUNNING, WAITING, RUNNING], focusedRow: 1, holdMs: 4 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, WAITING, RUNNING], focusedRow: 3, holdMs: 4 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, RUNNING, RUNNING], focusedRow: null, holdMs: 3 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, COMPLETE, FAILED], focusedRow: 4, holdMs: 4 * BEAT_MS },
  { states: [RUNNING, RUNNING, RUNNING, RUNNING, RUNNING], focusedRow: null, holdMs: 3 * BEAT_MS },
];

export const FIRST_ATTENTION_FRAME = ATTENTION_FRAMES[0];

export const ATTENTION_CHIP_STATES = [FAILED, WAITING, COMPLETE] as const;

export type AttentionChipState = (typeof ATTENTION_CHIP_STATES)[number];

export function attentionCountsOf(frame: AttentionFrame): Record<AttentionChipState, number> {
  const countOf = (state: AttentionChipState) => frame.states.filter((rowState) => rowState === state).length;
  return { [FAILED]: countOf(FAILED), [WAITING]: countOf(WAITING), [COMPLETE]: countOf(COMPLETE) };
}
