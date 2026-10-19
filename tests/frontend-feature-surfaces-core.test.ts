import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FEATURE_SURFACE_RULES, OPTIONAL_FEATURE_SURFACES } from '../public/feature-surfaces-core.ts';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import type { FeatureSurfaceSettings } from '../public/feature-surfaces-core.ts';

const availableSurfacesFromSettings = (settings: FeatureSurfaceSettings) => Object.fromEntries(Object.entries(FEATURE_SURFACE_RULES).map(([setting, isAvailable]) => [setting, isAvailable(settings)]));

test('feature surfaces are null-safe and use the default availability for Usage', () => {
  const expected = { teamReview: false, posthog: false, visions: false, usage: true, benchmarks: false, factory: false };
  assert.deepEqual(availableSurfacesFromSettings(null), expected);
  assert.deepEqual(availableSurfacesFromSettings(undefined), expected);
  assert.deepEqual(availableSurfacesFromSettings({ teamReview: null, posthog: null, visions: null, usage: null, benchmarks: null, factory: null }), expected);
});

test('feature surfaces follow their respective settings fields', () => {
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: true },
    posthog: { enabled: true },
    visions: { enabled: true },
    usage: { enabled: false },
    benchmarks: { enabled: true },
    factory: { enabled: true },
  }), { teamReview: true, posthog: true, visions: true, usage: false, benchmarks: true, factory: true });
  assert.deepEqual(availableSurfacesFromSettings({
    teamReview: { enabled: false },
    posthog: { enabled: false },
    visions: { enabled: false },
    usage: { enabled: true },
    benchmarks: { enabled: false },
    factory: { enabled: false },
  }), { teamReview: false, posthog: false, visions: false, usage: true, benchmarks: false, factory: false });
});

test('every optional tab is listed in Settings Features and links to an existing enable toggle', () => {
  const viewRegistrySource = readFileSync(new URL('../public/view-registry.ts', import.meta.url), 'utf8');
  assert.deepEqual(OPTIONAL_FEATURE_SURFACES.map((surface) => surface.rule).sort(), Object.keys(FEATURE_SURFACE_RULES).sort());
  for (const surface of OPTIONAL_FEATURE_SURFACES) {
    const section = SETTINGS_REGISTRY.sections.find((entry) => entry.id === surface.sectionId);
    assert.ok(section?.settings.some((setting) => setting.id === surface.settingId && setting.control === 'toggle'), `${surface.sectionId}/${surface.settingId}`);
    assert.ok(viewRegistrySource.includes(`gate: { fromSettings: FEATURE_SURFACE_RULES.${surface.rule} }`), `${surface.rule} has a gated tab`);
  }
});
