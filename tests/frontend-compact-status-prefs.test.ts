import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompactStatusLabels, setCompactStatusLabels, getThemeId } from '../public/ui-prefs.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';

test('compact sidebar status defaults off, normalizes booleans and persists without changing other preferences', (context) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storedValues = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
    },
  });
  context.after(() => {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
      return;
    }
    Reflect.deleteProperty(globalThis, 'localStorage');
  });
  assert.equal(isCompactStatusLabels(), false);
  storedValues.set('glimmervoid-ui-prefs', JSON.stringify({ compactStatusLabels: 'true', themeId: 'midnight' }));
  assert.equal(isCompactStatusLabels(), false);
  setCompactStatusLabels(true);
  assert.equal(isCompactStatusLabels(), true);
  assert.equal(getThemeId(), 'midnight');
  assert.equal(JSON.parse(storedValues.get('glimmervoid-ui-prefs') ?? '{}').compactStatusLabels, true);
  setCompactStatusLabels(false);
  assert.equal(isCompactStatusLabels(), false);
  const setting = SETTINGS_MAP.find((section) => section.id === 'browser-appearance')?.settings.find((entry) => entry.id === 'compact-status');
  assert.equal(setting?.path, 'pref:compactStatusLabels');
  assert.equal(setting?.control, 'toggle');
  assert.ok(setting && 'defaultValue' in setting);
  assert.equal(setting.defaultValue, false);
});
