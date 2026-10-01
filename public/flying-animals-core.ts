import { FLYING_ANIMALS_GAP_RANGE, FLYING_ANIMALS_DURATION_RANGE, FLYING_ANIMALS_SCALE_RANGE } from '#shared/settings-ranges.ts';
import { ANIMALS } from './nyan-animals.ts';

export const FLYING_ANIMALS_DEFAULTS = Object.freeze({
  flyingAnimalsMinGapSeconds: 20,
  flyingAnimalsMaxGapSeconds: 40,
  flyingAnimalsMinDurationSeconds: 6.9,
  flyingAnimalsMaxDurationSeconds: 11.5,
  flyingAnimalsScale: 1,
  flyingAnimalsOnPhone: true,
});

export type FlyingAnimalsAdvanced = { [Key in keyof typeof FLYING_ANIMALS_DEFAULTS]: typeof FLYING_ANIMALS_DEFAULTS[Key] extends boolean ? boolean : number };
export type FlyingAnimalsOptions = FlyingAnimalsAdvanced & { flyingAnimalsExcludedSprites: string[] };

export function normalizeFlyingAnimalsNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export function normalizeExcludedSprites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const knownSprites = new Set(ANIMALS.map((animal) => animal.sprite));
  return [...new Set(value.filter((sprite): sprite is string => typeof sprite === 'string' && knownSprites.has(sprite)))];
}

export function normalizeFlyingAnimalsOptions(values: Partial<Record<keyof FlyingAnimalsOptions, unknown>> = {}): FlyingAnimalsOptions {
  const defaults = FLYING_ANIMALS_DEFAULTS;
  const gapRange = FLYING_ANIMALS_GAP_RANGE;
  const durationRange = FLYING_ANIMALS_DURATION_RANGE;
  const minGap = normalizeFlyingAnimalsNumber(values.flyingAnimalsMinGapSeconds, defaults.flyingAnimalsMinGapSeconds, gapRange);
  const maxGap = normalizeFlyingAnimalsNumber(values.flyingAnimalsMaxGapSeconds, defaults.flyingAnimalsMaxGapSeconds, gapRange);
  const minDuration = normalizeFlyingAnimalsNumber(values.flyingAnimalsMinDurationSeconds, defaults.flyingAnimalsMinDurationSeconds, durationRange);
  const maxDuration = normalizeFlyingAnimalsNumber(values.flyingAnimalsMaxDurationSeconds, defaults.flyingAnimalsMaxDurationSeconds, durationRange);
  return {
    flyingAnimalsMinGapSeconds: Math.min(minGap, maxGap),
    flyingAnimalsMaxGapSeconds: Math.max(minGap, maxGap),
    flyingAnimalsMinDurationSeconds: Math.min(minDuration, maxDuration),
    flyingAnimalsMaxDurationSeconds: Math.max(minDuration, maxDuration),
    flyingAnimalsScale: normalizeFlyingAnimalsNumber(values.flyingAnimalsScale, defaults.flyingAnimalsScale, FLYING_ANIMALS_SCALE_RANGE),
    flyingAnimalsOnPhone: typeof values.flyingAnimalsOnPhone === 'boolean' ? values.flyingAnimalsOnPhone : defaults.flyingAnimalsOnPhone,
    flyingAnimalsExcludedSprites: normalizeExcludedSprites(values.flyingAnimalsExcludedSprites),
  };
}

export function hasIncludedAnimals(excludedSprites: readonly string[]): boolean {
  return ANIMALS.some((animal) => !excludedSprites.includes(animal.sprite));
}

export function pickIncludedAnimalIndex(excludedSprites: readonly string[], previousIndex = -1, random: () => number = Math.random): number | null {
  const includedIndices = ANIMALS.flatMap((animal, index) => excludedSprites.includes(animal.sprite) ? [] : [index]);
  if (includedIndices.length === 0) return null;
  const candidates = includedIndices.length > 1 ? includedIndices.filter((index) => index !== previousIndex) : includedIndices;
  const randomProgress = Math.min(1, Math.max(0, random()));
  return candidates[Math.min(candidates.length - 1, Math.floor(randomProgress * candidates.length))];
}

export function deriveFlyingAnimalLaunch(options: FlyingAnimalsOptions, previousIndex: number, random: () => number = Math.random, requestedSprite?: string) {
  const animalIndex = requestedSprite === undefined
    ? pickIncludedAnimalIndex(options.flyingAnimalsExcludedSprites, previousIndex, random)
    : ANIMALS.findIndex((animal) => animal.sprite === requestedSprite);
  if (animalIndex === null || animalIndex < 0) return null;
  const durationSeconds = options.flyingAnimalsMinDurationSeconds + random() * (options.flyingAnimalsMaxDurationSeconds - options.flyingAnimalsMinDurationSeconds);
  const gapMs = 1000 * (options.flyingAnimalsMinGapSeconds + random() * (options.flyingAnimalsMaxGapSeconds - options.flyingAnimalsMinGapSeconds));
  return { animalIndex, durationSeconds, gapMs, firstDelaySeconds: random() * durationSeconds, verticalProgress: random() };
}

export function flyingAnimalsFlightBlockReason({ isEnabled, hasReducedMotion, isPhone, options }: {
  isEnabled: boolean; hasReducedMotion: boolean; isPhone: boolean; options: FlyingAnimalsOptions;
}): string | null {
  if (hasReducedMotion) return 'Flights are disabled because reduced motion is enabled.';
  if (!isEnabled) return 'Turn on flying animals to use Fly now.';
  if (isPhone && !options.flyingAnimalsOnPhone) return 'Turn on Show on phone layout to use Fly now here.';
  return null;
}
