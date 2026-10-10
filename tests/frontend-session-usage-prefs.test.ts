import assert from 'node:assert/strict';
import test from 'node:test';
import { isSessionUsageChips, setSessionUsageChips, getThemeId } from '../public/ui-prefs.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';
import { stubLocalStorageForTest } from './helpers/frontend-global-stub.ts';

test('session usage chips defaults off, normalizes booleans and persists without changing other preferences', (context) => {
  const storedValues = stubLocalStorageForTest(context);
  assert.equal(isSessionUsageChips(), false);
  storedValues.set('glimmervoid-ui-prefs', JSON.stringify({ sessionUsageChips: 'true', themeId: 'midnight' }));
  assert.equal(isSessionUsageChips(), false);
  setSessionUsageChips(true);
  assert.equal(isSessionUsageChips(), true);
  assert.equal(getThemeId(), 'midnight');
  assert.equal(JSON.parse(storedValues.get('glimmervoid-ui-prefs') ?? '{}').sessionUsageChips, true);
  setSessionUsageChips(false);
  assert.equal(isSessionUsageChips(), false);
  const setting = SETTINGS_MAP.find((section) => section.id === 'browser-appearance')?.settings.find((entry) => entry.id === 'session-usage-chips');
  assert.equal(setting?.path, 'pref:sessionUsageChips');
  assert.equal(setting?.control, 'toggle');
  assert.ok(setting && 'defaultValue' in setting);
  assert.equal(setting.defaultValue, false);
  const settings = SETTINGS_MAP.find((section) => section.id === 'browser-appearance')?.settings ?? [];
  assert.equal(settings.findIndex((entry) => entry.id === 'session-usage-chips'), settings.findIndex((entry) => entry.id === 'compact-status') + 1);
});
