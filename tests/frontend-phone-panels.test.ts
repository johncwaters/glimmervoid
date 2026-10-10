import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const importCore = () => import('../public/phone/phone-panels-core.ts');
const readSource = (relativePath: string) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('every desktop view but Focus and Calm becomes a phone More screen, in desktop order', async () => {
  const { phonePanelsFromDesktopViews } = await importCore();
  const panels = phonePanelsFromDesktopViews([
    { view: 'calm', label: 'Calm', el: 'calm-panel', hasOwnPhoneScreen: true },
    { view: 'focus', label: 'Focus', el: 'focus-panel', hasOwnPhoneScreen: true },
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
  const htmlSource = readSource('../public/index.html');
  const registrySource = readSource('../public/view-registry.ts');
  const viewTabsSource = registrySource.slice(registrySource.indexOf('const definitions:'), registrySource.indexOf('const main ='));
  const registeredViews = [...viewTabsSource.matchAll(/\{ view: '([a-z]+)',/g)].map((match) => match[1]);

  assert.deepEqual(registeredViews, ['calm', 'focus', 'prs', 'issues', 'usage', 'radar', 'visions', 'hooks', 'trace', 'benchmarks', 'factory', 'settings']);
  assert.match(htmlSource, /id="header-tabs" role="tablist" aria-label="Primary views"/);
  assert.doesNotMatch(htmlSource, /class="header-tab"/);
  assert.match(registrySource, /const views = definitions\.map\(\(definition\) =>/);
  assert.match(registrySource, /const tab = el\('button', 'header-tab', definition\.label\)/);
  assert.match(registrySource, /tab\.id = `tab-\$\{definition\.view\}`;/);
  assert.ok(registrySource.includes("queryTag(document, '#header-tabs', 'div').replaceChildren(...viewsInTabOrder(views).map((view) => view.tab));"));
  assert.match(appSource, /const VIEW_TABS = createDashboardViews\(/);
  assert.match(appSource, /panels: phonePanelsFromDesktopViews\(VIEW_TABS\)/);
  for (const view of registeredViews) {
    assert.doesNotMatch(phoneShellSource, new RegExp(`'${view}'`), `phone-shell.ts hand-lists the ${view} view`);
  }
});
