import assert from 'node:assert/strict';
import test from 'node:test';
import { isCompactStatusLabels, setCompactStatusLabels, getThemeId } from '../public/ui-prefs.ts';
import { SETTINGS_MAP } from '../public/settings-map.ts';

const PLAN_PROMPT_KIND = 'plan';

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

test('compact status hides the status word on the desktop rail and the phone Board alike', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rowOutsidePlanPrompt = `html[data-compact-status] .phone-row:not([data-prompt="${PLAN_PROMPT_KIND}"])`;

  assert.match(css, /html\[data-compact-status\] \.focus-pill-label \{ display: none; \}/);
  assert.ok(css.includes(`${rowOutsidePlanPrompt} .phone-row-badge { display: none; }`));
  assert.ok(css.includes(`${rowOutsidePlanPrompt} .phone-row-meta:has(.phone-row-merge:empty) { display: none; }`));
  assert.doesNotMatch(css, /html\[data-compact-status\] \.phone-row-(badge|meta)/);
});

test('the phone Board stamps the prompt kind that the compact status rule exempts, and words a plan row Plan ready', async () => {
  const { readFileSync } = await import('node:fs');
  const boardScreenSource = readFileSync(new URL('../public/phone/board-screen.ts', import.meta.url), 'utf8');

  assert.ok(boardScreenSource.includes(`ui.pendingPromptKind === '${PLAN_PROMPT_KIND}' ? 'Plan ready' : label`));
  assert.ok(boardScreenSource.includes("row.dataset.prompt = ui.pendingPromptKind ?? ''"));
});
