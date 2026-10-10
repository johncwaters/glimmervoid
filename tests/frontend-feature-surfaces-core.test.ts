import test from 'node:test';
import assert from 'node:assert/strict';

import { FEATURE_SURFACE_RULES } from '../public/feature-surfaces-core.ts';
import type { FeatureSurfaceSettings } from '../public/feature-surfaces-core.ts';

const availableSurfacesFromSettings = (settings: FeatureSurfaceSettings) => Object.fromEntries(Object.entries(FEATURE_SURFACE_RULES).map(([setting, isAvailable]) => [setting, isAvailable(settings)]));

test('feature surfaces are null-safe and use the default availability for Usage', () => {
  const expected = { teamReview: false, posthog: false, visions: false, usage: true, benchmarks: false, factory: false, calmLayout: false };
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
  }), { teamReview: true, posthog: true, visions: true, usage: false, benchmarks: true, factory: true, calmLayout: true });
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: false },
    posthog: { enabled: false },
    visions: { enabled: false },
    usage: { enabled: true },
    benchmarks: { enabled: false },
    factory: { enabled: false },
    calmLayout: false,
  }), { teamReview: false, posthog: false, visions: false, usage: true, benchmarks: false, factory: false, calmLayout: false });
});
