import test from 'node:test';
import assert from 'node:assert/strict';

const storedValueByKey = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => storedValueByKey.get(key) ?? null,
  setItem: (key: string, value: string) => { storedValueByKey.set(key, value); },
};
Object.defineProperty(globalThis, 'localStorage', { value: fakeLocalStorage, configurable: true });

test('review sidebar starts closed even for a profile that saved the old open state', async () => {
  storedValueByKey.set('glimmervoid-ui-prefs', JSON.stringify({ reviewSidebarCollapsed: false, themeId: 'dusk' }));
  const { isReviewSidebarExpanded, getThemeId } = await import('../public/ui-prefs.ts');
  assert.equal(isReviewSidebarExpanded(), false);
  assert.equal(getThemeId(), 'dusk');
});

test('review sidebar remembers being opened', async () => {
  storedValueByKey.clear();
  const { isReviewSidebarExpanded, setReviewSidebarExpanded } = await import('../public/ui-prefs.ts');
  assert.equal(isReviewSidebarExpanded(), false);
  setReviewSidebarExpanded(true);
  assert.equal(isReviewSidebarExpanded(), true);
});

test('review sidebar remembers the notes view across preference reads', async () => {
  storedValueByKey.clear();
  const { getReviewSidebarView, setReviewSidebarView } = await import('../public/ui-prefs.ts');
  assert.equal(getReviewSidebarView(), 'map');
  setReviewSidebarView('notes');
  assert.equal(JSON.parse(storedValueByKey.get('glimmervoid-ui-prefs') ?? '{}').reviewSidebarView, 'notes');
  assert.equal(getReviewSidebarView(), 'notes');
  setReviewSidebarView('diff');
  assert.equal(getReviewSidebarView(), 'diff');
  setReviewSidebarView('map');
  assert.equal(getReviewSidebarView(), 'map');
});

test('review sidebar falls back to map for an unknown stored view', async () => {
  storedValueByKey.set('glimmervoid-ui-prefs', JSON.stringify({ reviewSidebarView: 'unknown' }));
  const { getReviewSidebarView } = await import('../public/ui-prefs.ts');
  assert.equal(getReviewSidebarView(), 'map');
});
