import test from 'node:test';
import assert from 'node:assert/strict';
import { hashUnit, placeLights, shouldShowLabels, NOW_RADIUS, NEXT_RADIUS, LATER_RADIUS,
  OUTER_BAND_MIN_RADIUS, OUTER_BAND_MAX_RADIUS } from '../public/calm/calm-field-core.ts';
import type { CalmTier } from '../public/calm/calm-priority-core.ts';

const fullTurnRadians = 2 * Math.PI;
const bandOf = (tier: CalmTier) => (tier === 'working' || tier === 'ready' ? 'outer' : tier);

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

test('adding or removing a light only changes spacing on its own ring', () => {
  const tiers: CalmTier[] = ['now', 'next', 'later', 'ready', 'working'];
  const entries = tiers.flatMap((tier) => [0, 1, 2].map((index) => ({ id: `${tier}-${index}`, tier })));
  const originalEntries = structuredClone(entries);
  const originalLights = placeLights(entries, 0.5);
  for (const changedTier of tiers) {
    const addedLights = placeLights([...entries, { id: 'added', tier: changedTier }], 0.5);
    const removedLights = placeLights(entries.filter((entry) => entry.id !== `${changedTier}-1`), 0.5);
    for (const light of originalLights) {
      if (bandOf(light.tier) === bandOf(changedTier)) continue;
      if (light.id === `${changedTier}-1`) continue;
      assert.deepEqual(addedLights.find((entry) => entry.id === light.id), light);
      assert.deepEqual(removedLights.find((entry) => entry.id === light.id), light);
    }
  }
  assert.deepEqual(entries, originalEntries);
});

for (const tier of ['now', 'next', 'later', 'working'] as const) {
  for (const minGapRadians of [0, 0.3, 2]) {
    test(`spacing on ${tier} honors every circular gap with requested gap ${minGapRadians}`, () => {
      const lights = placeLights(Array.from({ length: 12 }, (_, index) => ({ id: `light-${index}`, tier })), minGapRadians);
      const angles = lights.map((light) => light.angle).sort((first, second) => first - second);
      const expectedGapRadians = Math.min(minGapRadians, fullTurnRadians / lights.length);
      for (let index = 0; index < angles.length; index += 1) {
        assert.ok(angles[index] >= 0 && angles[index] < fullTurnRadians);
        const nextAngle = index + 1 < angles.length ? angles[index + 1] : angles[0] + fullTurnRadians;
        assert.ok(nextAngle - angles[index] >= expectedGapRadians - 1e-12);
      }
    });
  }
}

test('placement uses ring radii, hashed ring angles and hashed outer-band radii', () => {
  const tiers: CalmTier[] = ['now', 'next', 'later', 'working', 'ready'];
  const lights = placeLights(tiers.map((tier) => ({ id: tier, tier })), 1);
  assert.deepEqual(lights.slice(0, 3).map((light) => light.radius), [NOW_RADIUS, NEXT_RADIUS, LATER_RADIUS]);
  for (const light of lights.slice(0, 3)) assert.equal(light.angle, hashUnit(light.id) * fullTurnRadians);
  for (const outerLight of lights.slice(3)) {
    assert.equal(outerLight.radius, OUTER_BAND_MIN_RADIUS + hashUnit(outerLight.id, 1) * (OUTER_BAND_MAX_RADIUS - OUTER_BAND_MIN_RADIUS));
    assert.ok(outerLight.radius > LATER_RADIUS && outerLight.radius < OUTER_BAND_MAX_RADIUS);
  }
});

test('ready and working lights share the outer band evenly whatever gap the rings request', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ id: `outer-${index}`, tier: index % 2 ? 'ready' as const : 'working' as const }));
  const angles = placeLights(entries, 0.1).map((light) => light.angle).sort((first, second) => first - second);
  for (let index = 0; index < angles.length; index += 1) {
    const nextAngle = index + 1 < angles.length ? angles[index + 1] : angles[0] + fullTurnRadians;
    assert.ok(Math.abs(nextAngle - angles[index] - fullTurnRadians / angles.length) < 1e-9);
  }
});

test('resting entries are omitted and empty fields stay empty', () => {
  assert.deepEqual(placeLights([{ id: 'rest', tier: 'resting' }], 1), []);
  assert.deepEqual(placeLights([], 1), []);
});

test('labels appear only above the 640 pixel narrow-layout breakpoint', () => {
  assert.equal(shouldShowLabels(600), false);
  assert.equal(shouldShowLabels(640), false);
  assert.equal(shouldShowLabels(640.001), true);
  assert.equal(shouldShowLabels(641), true);
});
