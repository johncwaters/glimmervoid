import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UI_DIR = path.join(PUBLIC_DIR, 'ui');
const PRESSABLE_OWNER = path.join(UI_DIR, 'pressable.ts');
const SKIP_DIRS = new Set(['node_modules', 'dist']);
const BUTTON_CREATION = /\bel\(\s*['"`]button['"`]|createElement\(\s*['"`]button['"`]|<button\b/i;
const BUTTON_LOOK_SELECTOR = /\.ui-button\b|\[data-(?:variant|size)\b/;
const RETIRED_CLASSES: string[] = [
  'bench-action-button',
  'btn-action',
  'btn-add-header',
  'btn-celebrations',
  'btn-dialog',
  'btn-dialog-cancel',
  'btn-dialog-confirm',
  'btn-dialog-danger',
  'btn-dialog-ghost',
  'btn-dialog-icon',
  'btn-docs',
  'btn-face-plan',
  'btn-help',
  'btn-menu',
  'btn-power',
  'btn-remove',
  'btn-session-menu',
  'doc-editor-save',
  'hooks-btn',
  'hooks-btn-add',
  'hooks-btn-danger',
  'issues-back',
  'issues-small-action',
  'phone-back',
  'phone-changes',
  'plan-action',
  'plan-draft-chip',
  'plan-minimize-button',
  'plan-revision-next',
  'plan-revision-previous',
  'plan-section-comment',
  'plan-sheet-close',
  'plan-view-button',
  'pr-action',
  'pr-action-ghost',
  'pr-session-open-button',
  'radar-action',
  'radar-open-trace',
  'review-bar-merge',
  'review-btn',
  'review-btn-danger',
  'review-btn-primary',
  'review-look-show-all',
  'reviews-refresh-button',
  'session-group-add',
  'session-group-forget',
  'session-row-remove',
  'session-row-undo',
  'settings-update-button',
  'settings-view-back',
  'settings-view-copy-json',
  'settings-view-copy-link',
  'settings-view-reset',
  'settings-view-tab-order-move',
  'shown-zoom-control',
  'telemetry-banner-dismiss',
  'trace-copy',
  'trace-load-earlier',
  'update-banner-copy',
  'update-banner-dismiss',
  'usage-back',
  'usage-refresh',
  'wb-button',
  'wb-icon-button',
  'wb-inspect-action',
];

function collectFiles(dir: string, extensions: RegExp, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, extensions, found);
      continue;
    }
    if (extensions.test(entry.name)) found.push(fullPath);
  }
  return found;
}

const relativeToRoot = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
const withoutCssComments = (stylesheet: string) => stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
const selectorsOf = (stylesheet: string) => [...withoutCssComments(stylesheet).matchAll(/([^{};]+)\{/g)].map((match) => match[1].trim());

test('only public/ui/pressable.ts creates buttons in the dashboard', () => {
  const sources = collectFiles(PUBLIC_DIR, /\.(ts|html)$/);
  assert.match(fs.readFileSync(PRESSABLE_OWNER, 'utf8'), BUTTON_CREATION, 'public/ui/pressable.ts no longer matches the button pattern, so the gate would pass vacuously');

  const offenders = sources
    .filter((file) => file !== PRESSABLE_OWNER)
    .filter((file) => BUTTON_CREATION.test(fs.readFileSync(file, 'utf8')))
    .map(relativeToRoot);
  assert.deepEqual(offenders, [], `Build buttons with button() from public/ui/button.ts, or createPressable() from public/ui/pressable.ts for tabs, rows, menu items and keys:\n  ${offenders.join('\n  ')}`);
});

test('only public/ui/ styles the button component', () => {
  const offenders = collectFiles(PUBLIC_DIR, /\.css$/)
    .filter((file) => !file.startsWith(UI_DIR + path.sep))
    .flatMap((file) => selectorsOf(fs.readFileSync(file, 'utf8')).filter((selector) => BUTTON_LOOK_SELECTOR.test(selector)).map((selector) => `${relativeToRoot(file)}: ${selector}`));
  assert.deepEqual(offenders, [], `Button looks live in public/ui/button.css; lay buttons out from their container instead:\n  ${offenders.join('\n  ')}`);
});

test('retired button classes are gone from every stylesheet and source', () => {
  const offenders = collectFiles(PUBLIC_DIR, /\.(css|ts|html)$/).flatMap((file) => {
    const contents = fs.readFileSync(file, 'utf8');
    return RETIRED_CLASSES.filter((className) => new RegExp(`(?<![\\w-])${className}(?![\\w-])`).test(contents)).map((className) => `${relativeToRoot(file)}: ${className}`);
  });
  assert.deepEqual(offenders, [], `These classes were retired by the button component:\n  ${offenders.join('\n  ')}`);
});
