import test from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import { collectDirtyBlocks, hydrateFromSettings } from '../public/settings/settings-view-core.ts';

const SECTIONS = SETTINGS_REGISTRY.sections;

test('an unavailable stored project id can be cleared from a projects-control save', () => {
  const payload = {
    projectChoices: [{ id: 'shown', name: 'Shown' }],
    visions: { enabled: true, projects: ['shown', 'missing'] },
  };
  const original = hydrateFromSettings(SECTIONS, payload);
  const edited = hydrateFromSettings(SECTIONS, payload);
  edited['visions.projects'] = [];
  assert.deepEqual(collectDirtyBlocks(SECTIONS, original, edited), {
    visions: { enabled: true, projects: [] },
  });
});
