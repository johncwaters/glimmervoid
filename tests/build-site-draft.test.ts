import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildSiteDraft, extractAnimalStyles } from '../scripts/build-site-draft.ts';

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

test('the draft template inlines the animal styles at its single placeholder', () => {
  const template = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'website', 'draft.template.html'), 'utf8');
  const draft = buildSiteDraft(template, '.sky .nyan-flight { left: 0; }');
  assert.ok(draft.includes('.sky .nyan-flight { left: 0; }'));
  assert.equal(draft.includes('/*__ANIMALS_CSS__*/'), false);
});

test('a template without exactly one placeholder is refused', () => {
  assert.throws(() => buildSiteDraft('<style></style>', ''), /exactly one/);
});
