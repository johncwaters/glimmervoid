import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dashboardMarkup = readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const registrySource = readFileSync(path.join(import.meta.dirname, '..', 'public', 'view-registry.ts'), 'utf8');

test('the desktop header offers Settings only as a view tab', () => {
  const settingsControls = [...registrySource.matchAll(/\{ view: '([^']+)', label: 'Settings',/g)];
  assert.deepEqual(settingsControls.map((control) => `tab-${control[1]}`), ['tab-settings']);
  assert.doesNotMatch(dashboardMarkup, /<button[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Settings<\/button>/);
  assert.match(registrySource, /const tab = el\('button', 'header-tab', definition\.label\)/);
  assert.match(registrySource, /tab\.id = `tab-\$\{definition\.view\}`;/);
  assert.match(registrySource, /tab\.setAttribute\('role', 'tab'\)/);
});

test('the mute button reports its state through aria-pressed, not its label', () => {
  const muteButtonMarkup = /<button[^>]*id="btn-mute"[^>]*>/.exec(dashboardMarkup)?.[0] ?? '';
  assert.match(muteButtonMarkup, /aria-pressed="false"/);
  assert.match(muteButtonMarkup, /aria-label="Mute alerts"/);
});
