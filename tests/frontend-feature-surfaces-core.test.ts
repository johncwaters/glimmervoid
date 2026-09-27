import test from 'node:test';
import assert from 'node:assert/strict';

import { availableSurfacesFromSettings } from '../public/feature-surfaces-core.ts';

test('feature surfaces are null-safe and use the default availability for Usage and Mill', () => {
  const expected = { prs: false, radar: false, visions: false, usage: true, mill: true };
  assert.deepEqual(availableSurfacesFromSettings(null), expected);
  assert.deepEqual(availableSurfacesFromSettings(undefined), expected);
  assert.deepEqual(availableSurfacesFromSettings({ teamReview: null, posthog: null, visions: null, usage: null }), expected);
});

test('feature surfaces follow their respective settings fields', () => {
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: true },
    posthog: { enabled: true },
    visions: { enabled: true },
    usage: { enabled: false },
    millEnabled: false,
  }), { prs: true, radar: true, visions: true, usage: false, mill: false });
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: false },
    posthog: { enabled: false },
    visions: { enabled: false },
    usage: { enabled: true },
    millEnabled: true,
  }), { prs: false, radar: false, visions: false, usage: true, mill: true });
});
