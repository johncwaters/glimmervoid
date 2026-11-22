import { FLYING_ANIMALS_DEFAULTS } from '#shared/settings-ranges.ts';
import { ANIMALS } from './nyan-animals-core.ts';

const SWOOP_CHANCE = 1 / 25;
const SWOOP_ARC_MULTIPLIER = 3;

type FlyingAnimalsAdvanced = { [Key in keyof typeof FLYING_ANIMALS_DEFAULTS]: typeof FLYING_ANIMALS_DEFAULTS[Key] extends boolean ? boolean : number };
type FlyingAnimalsOptions = FlyingAnimalsAdvanced & { flyingAnimalsExcludedSprites: string[] };

export function normalizeExcludedSprites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const knownSprites = new Set(ANIMALS.map((animal) => animal.sprite));
  return [...new Set(value.filter((sprite): sprite is string => typeof sprite === 'string' && knownSprites.has(sprite)))];
}

export function normalizeFlyingAnimalsOptions(values: Partial<Record<keyof FlyingAnimalsOptions, unknown>> = {}): FlyingAnimalsOptions {
  return {
    ...FLYING_ANIMALS_DEFAULTS,
    flyingAnimalsExcludedSprites: normalizeExcludedSprites(values.flyingAnimalsExcludedSprites),
  };
}

export function hasIncludedAnimals(excludedSprites: readonly string[]): boolean {
  return ANIMALS.some((animal) => !excludedSprites.includes(animal.sprite));
}

function pickIncludedAnimalIndex(excludedSprites: readonly string[], previousIndex = -1, random: () => number = Math.random): number | null {
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
  const firstDelaySeconds = random() * durationSeconds;
  const verticalProgress = random();
  const isRightToLeft = random() < 0.5;
  const arcMultiplier = random() < SWOOP_CHANCE ? SWOOP_ARC_MULTIPLIER : 1;
  const arcProgress = (random() * 2 - 1) * arcMultiplier;
  return { animalIndex, durationSeconds, gapMs, firstDelaySeconds, verticalProgress, isRightToLeft, arcProgress };
}

export function flyingAnimalsFlightBlockReason({ isEnabled, hasReducedMotion, isPhone, options }: {
  isEnabled: boolean; hasReducedMotion: boolean; isPhone: boolean; options: FlyingAnimalsOptions;
}): string | null {
  if (hasReducedMotion) return 'Flights are disabled because reduced motion is enabled.';
  if (!isEnabled) return 'Turn on flying animals to use Fly now.';
  if (isPhone && !options.flyingAnimalsOnPhone) return 'Turn on Show on phone layout to use Fly now here.';
  return null;
}
