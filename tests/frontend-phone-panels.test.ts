import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const importCore = () => import('../public/phone/phone-panels-core.ts');
const readSource = (relativePath: string) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('every desktop view but Focus and Calm becomes a phone More screen, in desktop order', async () => {
  const { phonePanelsFromDesktopViews } = await importCore();
  const panels = phonePanelsFromDesktopViews([
    { view: 'calm', label: 'Calm', el: 'calm-panel' },
    { view: 'focus', label: 'Focus', el: 'focus-panel' },
    { view: 'prs', label: 'Reviews', glyph: '#', el: 'prs-panel' },
    { view: 'factory', label: 'Factory', el: 'factory-panel' },
  ]);

  assert.deepEqual(panels, [
    { id: 'prs', label: 'Reviews', glyph: '#', el: 'prs-panel' },
    { id: 'factory', label: 'Factory', glyph: 'F', el: 'factory-panel' },
  ]);
});

test('a desktop tab with no glyph of its own gets the first letter of its trimmed label', async () => {
  const { phonePanelsFromDesktopViews } = await importCore();
  const [panel] = phonePanelsFromDesktopViews([{ view: 'benchmarks', label: '  bench ', glyph: null, el: 'bench-panel' }]);

  assert.deepEqual(panel, { id: 'benchmarks', label: 'bench', glyph: 'B', el: 'bench-panel' });
});

test('the phone shell names no desktop view: its More screens come from the desktop tab list', () => {
  const appSource = readSource('../public/app.ts');
  const phoneShellSource = readSource('../public/phone/phone-shell.ts');
  const headerTabViews = [...readSource('../public/index.html').matchAll(/class="header-tab" id="tab-([a-z]+)"/g)].map((match) => match[1]);
  const viewTabsSource = appSource.slice(appSource.indexOf('const VIEW_TABS = ['), appSource.indexOf('function isViewAvailable'));
  const registeredViews = [...viewTabsSource.matchAll(/\{ view: '([a-z]+)',/g)].map((match) => match[1]);

  assert.ok(headerTabViews.length > 0);
  assert.deepEqual([...registeredViews].sort(), [...headerTabViews].sort());
  assert.match(appSource, /panels: phonePanelsFromDesktopViews\(VIEW_TABS\.map\(/);
  for (const view of registeredViews) {
    assert.doesNotMatch(phoneShellSource, new RegExp(`'${view}'`), `phone-shell.ts hand-lists the ${view} view`);
  }
});
