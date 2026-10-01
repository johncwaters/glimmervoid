import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { extractAnimalStyles } from '../site/src/lib/animal-styles.ts';
import { extractDashboardTokens } from '../site/src/lib/dashboard-tokens.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const dashboardStylesheet = fs.readFileSync(path.join(REPO_ROOT, 'public', 'style.css'), 'utf8');

test('the dashboard stylesheet still yields the flying animal styles, rescoped to the site sky', () => {
  const animalStyles = extractAnimalStyles(dashboardStylesheet);
  assert.ok(animalStyles.startsWith('.sky .nyan-flight {'));
  assert.ok(animalStyles.includes('@keyframes'));
  assert.equal(animalStyles.includes('data-flying-animals'), false);
  assert.equal(animalStyles.includes('prefers-reduced-motion'), false);
});

test('a stylesheet without the flying animals block is refused', () => {
  assert.throws(() => extractAnimalStyles('body { color: red; }'), /no longer has the line/);
});

const SITE_VISUAL_TOKENS = [
  '--bg', '--bg-card', '--bg-header', '--bg-surface', '--border', '--border-dim',
  '--text', '--text-dim', '--text-head', '--accent', '--accent-dim',
  '--state-running', '--state-waiting', '--state-failed', '--state-complete', '--state-starting',
];

test('the dashboard stylesheet still yields its root token block with every token the site uses', () => {
  const dashboardTokens = extractDashboardTokens(dashboardStylesheet);
  assert.ok(dashboardTokens.startsWith(':root {'));
  assert.ok(dashboardTokens.endsWith('}'));
  for (const token of SITE_VISUAL_TOKENS) assert.ok(dashboardTokens.includes(`${token}:`), `missing ${token}`);
});

test('a stylesheet without a root token block is refused', () => {
  assert.throws(() => extractDashboardTokens('body { color: red; }'), /no longer has the line/);
});
