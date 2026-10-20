import type { UnseenOutcome } from '#shared/contracts/session.ts';
import { fnv1a32 } from '#shared/fnv-hash.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { STATE_ICONS } from '#shared/state-icons.ts';
import { BADGE_LABELS, STATES } from '#shared/states.ts';
import { stageNeedWords } from '../focus-view/attention-core.ts';
import { pickIncludedAnimalIndex } from '../flying-animals-core.ts';
import { ANIMALS } from '../nyan-animals-core.ts';

type PetMood = 'ambling' | 'resting' | 'asleep' | 'sitting' | 'alert';

const PET_SLEEP_AFTER_MS = 3 * 60_000;

const HASH_RANGE = 2 ** 32;

const PET_STATES: ReadonlySet<string> = new Set([
  STATES.INITIALIZING, STATES.STARTING, STATES.RUNNING, STATES.WAITING, STATES.IDLE, STATES.COMPLETE, STATES.FAILED,
]);

const BADGE_WORDS_BY_STATE: ReadonlyMap<string, string> = new Map([
  [STATES.INITIALIZING, BADGE_LABELS.INITIALIZING],
  [STATES.STARTING, BADGE_LABELS.STARTING],
  [STATES.RUNNING, BADGE_LABELS.RUNNING],
  [STATES.IDLE, BADGE_LABELS.IDLE],
]);

const MOOD_BY_SETTLED_STATE: ReadonlyMap<string, PetMood> = new Map([
  [STATES.INITIALIZING, 'resting'],
  [STATES.STARTING, 'resting'],
  [STATES.WAITING, 'alert'],
  [STATES.FAILED, 'alert'],
  [STATES.COMPLETE, 'sitting'],
  [STATES.IDLE, 'asleep'],
]);

interface PetSpot {
  leftPercent: number;
  topPercent: number;
  ambleDistancePx: number;
  ambleSeconds: number;
}

export function isPetState(state: string): boolean {
  return PET_STATES.has(state);
}

export function pickPetAnimal(sessionId: string, excludedSprites: readonly string[]) {
  const seededProgress = fnv1a32(sessionId) / HASH_RANGE;
  const animalIndex = pickIncludedAnimalIndex(excludedSprites, -1, () => seededProgress);
  if (animalIndex === null) return null;
  return ANIMALS[animalIndex] ?? null;
}

export function petSpot(sessionId: string): PetSpot {
  const spotHash = fnv1a32(`${sessionId}#spot`);
  return {
    leftPercent: 6 + (spotHash % 78),
    topPercent: 12 + ((spotHash >>> 8) % 62),
    ambleDistancePx: 24 + ((spotHash >>> 16) % 64),
    ambleSeconds: 9 + ((spotHash >>> 24) % 9),
  };
}

export function petMood({ state, activity, lastOutputAtMs, nowMs }: {
  state: string;
  activity: 'active' | 'quiet' | undefined;
  lastOutputAtMs: number | undefined;
  nowMs: number;
}): PetMood {
  if (state !== STATES.RUNNING) return MOOD_BY_SETTLED_STATE.get(state) ?? 'asleep';
  const isLongQuiet = lastOutputAtMs !== undefined && nowMs - lastOutputAtMs >= PET_SLEEP_AFTER_MS;
  if (isLongQuiet) return 'asleep';
  if (activity === 'quiet') return 'resting';
  return 'ambling';
}

export function petBubbleIcon({ state, unseenOutcome }: { state: string; unseenOutcome: UnseenOutcome | null | undefined }): StatusIcon | null {
  if (state === STATES.WAITING) return STATE_ICONS.WAITING;
  if (state === STATES.FAILED && unseenOutcome === 'failed') return STATE_ICONS.FAILED;
  return null;
}

export function stageReasonWords(state: string, pendingPromptKind: string | null): string {
  return BADGE_WORDS_BY_STATE.get(state) ?? stageNeedWords(state, pendingPromptKind);
}
