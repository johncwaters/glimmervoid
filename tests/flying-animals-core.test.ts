import assert from 'node:assert/strict';
import test from 'node:test';
import { ANIMALS } from '../public/nyan-animals.ts';
import {
  deriveFlyingAnimalLaunch,
  FLYING_ANIMALS_DEFAULTS,
  flyingAnimalsFlightBlockReason,
  hasIncludedAnimals,
  normalizeExcludedSprites,
  normalizeFlyingAnimalsOptions,
  pickIncludedAnimalIndex,
} from '../public/flying-animals-core.ts';

const allSprites = ANIMALS.map((animal) => animal.sprite);

test('flights default to a 20 to 40 second pause between them', () => {
  assert.equal(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMinGapSeconds, 20);
  assert.equal(FLYING_ANIMALS_DEFAULTS.flyingAnimalsMaxGapSeconds, 40);
});

test('missing and malformed preferences fall back to the defaults', () => {
  assert.deepEqual(normalizeFlyingAnimalsOptions(), { ...FLYING_ANIMALS_DEFAULTS, flyingAnimalsExcludedSprites: [] });
  assert.deepEqual(normalizeFlyingAnimalsOptions({
    flyingAnimalsMinGapSeconds: '10', flyingAnimalsMaxGapSeconds: Number.NaN,
    flyingAnimalsMinDurationSeconds: null, flyingAnimalsMaxDurationSeconds: Number.POSITIVE_INFINITY,
    flyingAnimalsScale: {}, flyingAnimalsOnPhone: 'false', flyingAnimalsExcludedSprites: 'is-cat',
  }), { ...FLYING_ANIMALS_DEFAULTS, flyingAnimalsExcludedSprites: [] });
});

test('timing and size clamp to their allowed ranges and reversed endpoints swap', () => {
  const options = normalizeFlyingAnimalsOptions({
    flyingAnimalsMinGapSeconds: 400, flyingAnimalsMaxGapSeconds: -10,
    flyingAnimalsMinDurationSeconds: 70, flyingAnimalsMaxDurationSeconds: -2,
    flyingAnimalsScale: 4, flyingAnimalsOnPhone: false,
  });
  assert.equal(options.flyingAnimalsMinGapSeconds, 0);
  assert.equal(options.flyingAnimalsMaxGapSeconds, 300);
  assert.equal(options.flyingAnimalsMinDurationSeconds, 1);
  assert.equal(options.flyingAnimalsMaxDurationSeconds, 60);
  assert.equal(options.flyingAnimalsScale, 2);
  assert.equal(options.flyingAnimalsOnPhone, false);
  assert.equal(normalizeFlyingAnimalsOptions({ flyingAnimalsScale: 0.1 }).flyingAnimalsScale, 0.5);
  const reversed = normalizeFlyingAnimalsOptions({ flyingAnimalsMinGapSeconds: 15, flyingAnimalsMaxGapSeconds: 5 });
  assert.equal(reversed.flyingAnimalsMinGapSeconds, 5);
  assert.equal(reversed.flyingAnimalsMaxGapSeconds, 15);
  const equal = normalizeFlyingAnimalsOptions({ flyingAnimalsMinDurationSeconds: 7, flyingAnimalsMaxDurationSeconds: 7 });
  assert.equal(equal.flyingAnimalsMinDurationSeconds, equal.flyingAnimalsMaxDurationSeconds);
});

test('exclusions discard duplicates and unknown ids while unlisted animals stay included', () => {
  assert.deepEqual(normalizeExcludedSprites(['is-cat', 'is-cat', 'is-missing', null, 3]), ['is-cat']);
  assert.deepEqual(normalizeExcludedSprites(null), []);
  const seen = new Set<number | null>();
  for (let step = 0; step < 100; step++) seen.add(pickIncludedAnimalIndex(['is-cat'], -1, () => step / 100));
  assert.equal(seen.has(0), false);
  assert.equal(seen.size, ANIMALS.length - 1);
});

test('included selection never repeats with multiple animals and reaches every alternative', () => {
  const exclusions = allSprites.slice(4);
  for (const previousIndex of [-1, 0, 1, 2, 3, 10]) {
    const seen = new Set<number | null>();
    for (let step = 0; step <= 100; step++) {
      const selected = pickIncludedAnimalIndex(exclusions, previousIndex, () => step / 100);
      assert.notEqual(selected, previousIndex);
      seen.add(selected);
    }
    assert.equal(seen.size, previousIndex >= 0 && previousIndex < 4 ? 3 : 4);
  }
});

test('one included animal repeats and no included animals produce no launch', () => {
  const exclusions = allSprites.filter((sprite) => sprite !== 'is-hedgehog');
  assert.equal(pickIncludedAnimalIndex(exclusions, 18, () => 0.5), 18);
  assert.equal(pickIncludedAnimalIndex(allSprites), null);
  assert.equal(deriveFlyingAnimalLaunch(normalizeFlyingAnimalsOptions({ flyingAnimalsExcludedSprites: allSprites }), 0), null);
});

test('launches use the current timing values and allow an explicit excluded animal preview', () => {
  const options = normalizeFlyingAnimalsOptions({
    flyingAnimalsMinGapSeconds: 10, flyingAnimalsMaxGapSeconds: 30,
    flyingAnimalsMinDurationSeconds: 2, flyingAnimalsMaxDurationSeconds: 4,
    flyingAnimalsExcludedSprites: allSprites,
  });
  assert.deepEqual(deriveFlyingAnimalLaunch(options, -1, () => 0.5, 'is-cat'), {
    animalIndex: 0, durationSeconds: 3, gapMs: 20000, firstDelaySeconds: 1.5, verticalProgress: 0.5,
  });
  assert.equal(deriveFlyingAnimalLaunch(options, -1, () => 0, 'is-missing'), null);
  for (const progress of [0, 1]) {
    const launch = deriveFlyingAnimalLaunch(options, -1, () => progress, 'is-cat');
    assert.ok(launch);
    assert.equal(launch.durationSeconds, progress === 0 ? 2 : 4);
    assert.equal(launch.gapMs, progress === 0 ? 10000 : 30000);
  }
});

test('flight availability explains disabled, reduced motion and phone layout preferences', () => {
  const availability = { isEnabled: true, hasReducedMotion: false, isPhone: false, options: normalizeFlyingAnimalsOptions() };
  assert.equal(flyingAnimalsFlightBlockReason(availability), null);
  assert.match(flyingAnimalsFlightBlockReason({ ...availability, isEnabled: false }) ?? '', /Turn on flying animals/);
  assert.match(flyingAnimalsFlightBlockReason({ ...availability, hasReducedMotion: true }) ?? '', /reduced motion/);
  const options = normalizeFlyingAnimalsOptions({ flyingAnimalsOnPhone: false });
  assert.equal(flyingAnimalsFlightBlockReason({ ...availability, options }), null);
  assert.match(flyingAnimalsFlightBlockReason({ ...availability, options, isPhone: true }) ?? '', /phone layout/);
});

test('animals count as included until every sprite is excluded', () => {
  assert.equal(hasIncludedAnimals([]), true);
  assert.equal(hasIncludedAnimals(allSprites.slice(1)), true);
  assert.equal(hasIncludedAnimals(allSprites), false);
});
