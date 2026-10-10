import test from 'node:test';
import assert from 'node:assert/strict';

import * as ranges from '../shared/settings-ranges.ts';
import type { SettingsRange } from '../shared/settings-ranges.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';
import type { SettingsSection } from '../public/settings-map.ts';

test('every map number setting names a range the shared catalog carries', () => {
  const catalog: Record<string, SettingsRange | undefined> = ranges.SETTINGS_RANGES;
  const sections: readonly SettingsSection[] = SETTINGS_MAP;
  for (const setting of sections.flatMap((section) => section.settings)) {
    if (setting.control !== 'number') continue;
    const named = setting.range;
    assert.ok(named, `${setting.id} is a number control with no range`);
    assert.ok(catalog[named], `${setting.id} names ${named}, which the shared catalog does not carry`);
  }
});
