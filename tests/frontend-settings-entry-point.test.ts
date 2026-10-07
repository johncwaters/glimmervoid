import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dashboardMarkup = readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');

test('the desktop header offers Settings only as a view tab', () => {
  const settingsControls = dashboardMarkup.match(/<button[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Settings<\/button>/g) ?? [];
  assert.deepEqual(settingsControls.map((control) => /id="([^"]+)"/.exec(control)?.[1]), ['tab-settings']);
});

test('the mute button reports its state through aria-pressed, not its label', () => {
  const muteButtonMarkup = /<button[^>]*id="btn-mute"[^>]*>/.exec(dashboardMarkup)?.[0] ?? '';
  assert.match(muteButtonMarkup, /aria-pressed="false"/);
  assert.match(muteButtonMarkup, /aria-label="Mute alerts"/);
});
