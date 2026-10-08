import test from 'node:test';
import assert from 'node:assert/strict';

import { availableSurfacesFromSettings } from '../public/feature-surfaces-core.ts';

test('feature surfaces are null-safe and use the default availability for Usage', () => {
  const expected = { prs: false, radar: false, visions: false, usage: true, benchmarks: false, factory: false, calm: false };
  assert.deepEqual(availableSurfacesFromSettings(null), expected);
  assert.deepEqual(availableSurfacesFromSettings(undefined), expected);
  assert.deepEqual(availableSurfacesFromSettings({ teamReview: null, posthog: null, visions: null, usage: null, benchmarks: null, factory: null, calmLayout: undefined }), expected);
});

test('feature surfaces follow their respective settings fields', () => {
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: true },
    posthog: { enabled: true },
    visions: { enabled: true },
    usage: { enabled: false },
    benchmarks: { enabled: true },
    factory: { enabled: true },
    calmLayout: true,
  }), { prs: true, radar: true, visions: true, usage: false, benchmarks: true, factory: true, calm: true });
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: false },
    posthog: { enabled: false },
    visions: { enabled: false },
    usage: { enabled: true },
    benchmarks: { enabled: false },
    factory: { enabled: false },
    calmLayout: false,
  }), { prs: false, radar: false, visions: false, usage: true, benchmarks: false, factory: false, calm: false });
});
