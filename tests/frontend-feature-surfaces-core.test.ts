import test from 'node:test';
import assert from 'node:assert/strict';

import { FEATURE_SURFACE_RULES } from '../public/feature-surfaces-core.ts';
import type { FeatureSurfaceSettings } from '../public/feature-surfaces-core.ts';

const availableSurfacesFromSettings = (settings: FeatureSurfaceSettings) => Object.fromEntries(Object.entries(FEATURE_SURFACE_RULES).map(([setting, isAvailable]) => [setting, isAvailable(settings)]));

test('feature surfaces are null-safe and use the default availability for Usage and Reviews', () => {
  const expected = { teamReview: true, issues: false, posthog: false, visions: false, usage: true, benchmarks: false };
  assert.deepEqual(availableSurfacesFromSettings(null), expected);
  assert.deepEqual(availableSurfacesFromSettings(undefined), expected);
  assert.deepEqual(availableSurfacesFromSettings({ teamReview: null, issues: null, posthog: null, visions: null, usage: null, benchmarks: null }), expected);
});

test('feature surfaces follow their respective settings fields', () => {
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: true },
    issues: { enabled: true },
    posthog: { enabled: true },
    visions: { enabled: true },
    usage: { enabled: false },
    benchmarks: { enabled: true },
  }), { teamReview: true, issues: true, posthog: true, visions: true, usage: false, benchmarks: true });
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: false },
    issues: { enabled: false },
    posthog: { enabled: false },
    visions: { enabled: false },
    usage: { enabled: true },
    benchmarks: { enabled: false },
  }), { teamReview: false, issues: false, posthog: false, visions: false, usage: true, benchmarks: false });
});
