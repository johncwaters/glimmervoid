import test from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, placeLights, shouldShowLabels, NOW_RADIUS, NEXT_RADIUS, LATER_RADIUS,
  OUTER_BAND_MIN_RADIUS, OUTER_BAND_MAX_RADIUS } from '../public/calm/calm-field-core.ts';
import type { CalmTier } from '../public/calm/calm-priority-core.ts';

const fullTurnRadians = 2 * Math.PI;

test('hashUnit is deterministic, salted, uses UTF-16 code units and stays in range', () => {
  assert.equal(hashUnit(''), 0x811c9dc5 / 0x100000000);
  assert.equal(hashUnit('hello'), 0x4f9f2cab / 0x100000000);
  assert.equal(hashUnit(String.fromCharCode(0xd83d, 0xde00)), 0xcb31c4b8 / 0x100000000);
  for (const id of ['', 'alpha', 'session-42', String.fromCharCode(0xffff)]) {
    for (const salt of [0, 1, -1, 12345]) {
      const unit = hashUnit(id, salt);
      assert.equal(unit, hashUnit(id, salt));
      assert.ok(unit >= 0 && unit < 1);
    }
    assert.notEqual(hashUnit(id), hashUnit(id, 1));
  }
});

const assertEvenlySpaced = (angles: readonly number[]) => {
  const sortedAngles = [...angles].sort((first, second) => first - second);
  for (let index = 0; index < sortedAngles.length; index += 1) {
    assert.ok(sortedAngles[index] >= 0 && sortedAngles[index] < fullTurnRadians);
    const nextAngle = index + 1 < sortedAngles.length ? sortedAngles[index + 1] : sortedAngles[0] + fullTurnRadians;
    assert.ok(Math.abs(nextAngle - sortedAngles[index] - fullTurnRadians / sortedAngles.length) < 1e-9);
  }
};

test('every light across all tiers shares one even angular spread so labels on different rings never meet', () => {
  const tiers: CalmTier[] = ['now', 'next', 'later', 'ready', 'working'];
  for (const lightsPerTier of [1, 2, 5]) {
    const entries = tiers.flatMap((tier) => Array.from({ length: lightsPerTier }, (_, index) => ({ id: `${tier}-${index}`, tier })));
    const originalEntries = structuredClone(entries);
    const lights = placeLights(entries);
    assert.equal(lights.length, entries.length);
    assertEvenlySpaced(lights.map((light) => light.angle));
    assert.deepEqual(entries, originalEntries);
  }
});

test('placement is deterministic, keeps input order and uses tier radii', () => {
  const tiers: CalmTier[] = ['now', 'next', 'later', 'working', 'ready'];
  const entries = tiers.map((tier) => ({ id: tier, tier }));
  const lights = placeLights(entries);
  assert.deepEqual(placeLights(entries), lights);
  assert.deepEqual(lights.map((light) => light.id), tiers);
  assert.deepEqual(lights.slice(0, 3).map((light) => light.radius), [NOW_RADIUS, NEXT_RADIUS, LATER_RADIUS]);
  for (const outerLight of lights.slice(3)) {
    assert.equal(outerLight.radius, OUTER_BAND_MIN_RADIUS + hashUnit(outerLight.id, 1) * (OUTER_BAND_MAX_RADIUS - OUTER_BAND_MIN_RADIUS));
    assert.ok(outerLight.radius > LATER_RADIUS && outerLight.radius < OUTER_BAND_MAX_RADIUS);
  }
});

test('a single light keeps its hashed angle', () => {
  assert.deepEqual(placeLights([{ id: 'solo', tier: 'later' }]).map((light) => light.angle), [hashUnit('solo') * fullTurnRadians]);
});

test('resting entries are omitted and empty fields stay empty', () => {
  assert.deepEqual(placeLights([{ id: 'rest', tier: 'resting' }]), []);
  assert.deepEqual(placeLights([]), []);
});

test('labels appear only above the 640 pixel narrow-layout breakpoint', () => {
  assert.equal(shouldShowLabels(600), false);
  assert.equal(shouldShowLabels(640), false);
  assert.equal(shouldShowLabels(640.001), true);
  assert.equal(shouldShowLabels(641), true);
});
