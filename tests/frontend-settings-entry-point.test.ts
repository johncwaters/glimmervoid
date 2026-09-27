import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dashboardMarkup = readFileSync(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
const headerRightMarkup = /<div class="header-right">[\s\S]*?<\/header>/.exec(dashboardMarkup)?.[0] ?? '';

function idsInOrder(markup: string) {
  return [...markup.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
}

test('the desktop header offers Settings only as a view tab', () => {
  const settingsControls = dashboardMarkup.match(/<button[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Settings<\/button>/g) ?? [];
  assert.deepEqual(settingsControls.map((control) => /id="([^"]+)"/.exec(control)?.[1]), ['tab-settings']);
});

test('help, mute and power sit side by side as dedicated header buttons', () => {
  assert.deepEqual(idsInOrder(headerRightMarkup), ['btn-add-session-header', 'btn-help', 'btn-mute', 'btn-power', 'btn-restart', 'btn-shutdown']);
});

test('the power menu holds only the server restart and shutdown actions', () => {
  const powerMenuMarkup = /<div class="header-menu-dropdown" id="power-menu-dropdown"[\s\S]*?<\/div>\s*<\/div>/.exec(dashboardMarkup)?.[0] ?? '';
  assert.deepEqual(idsInOrder(powerMenuMarkup), ['btn-restart', 'btn-shutdown']);
});

test('the mute button reports its state through aria-pressed, not its label', () => {
  const muteButtonMarkup = /<button[^>]*id="btn-mute"[^>]*>/.exec(dashboardMarkup)?.[0] ?? '';
  assert.match(muteButtonMarkup, /aria-pressed="false"/);
  assert.match(muteButtonMarkup, /aria-label="Mute alerts"/);
});
