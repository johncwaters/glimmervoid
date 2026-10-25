import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SURFACE_RULES, OPTIONAL_FEATURE_SURFACES } from '../../public/feature-surfaces-core.ts';
import { SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import { readTracked } from '../helpers/tracked-files.ts';

test('every optional tab is listed in Settings Features and links to an existing enable toggle', () => {
  const viewRegistrySource = readTracked('public/view-registry.ts');
  assert.deepEqual(OPTIONAL_FEATURE_SURFACES.map((surface) => surface.rule).sort(), Object.keys(FEATURE_SURFACE_RULES).sort());
  for (const surface of OPTIONAL_FEATURE_SURFACES) {
    const section = SETTINGS_REGISTRY.sections.find((entry) => entry.id === surface.sectionId);
    assert.ok(section?.settings.some((setting) => setting.id === surface.settingId && setting.control === 'toggle'), `${surface.sectionId}/${surface.settingId}`);
    assert.ok(viewRegistrySource.includes(`gate: { fromSettings: FEATURE_SURFACE_RULES.${surface.rule} }`), `${surface.rule} has a gated tab`);
  }
});
