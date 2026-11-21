import '../helpers/isolate-home.ts';
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
const BUTTON_LOOK_SELECTOR = /\.ui-button\b|\[data-(?:variant|size|outline-state)\b/;
const PRIMITIVE_LAYOUT_PROPERTY = /^(?:display|visibility|order|position|inset|top|right|bottom|left|z-index|(?:min-|max-)?width|margin(?:-[a-z-]+)?|flex(?:-[a-z]+)?|grid-(?:area|column|row)(?:-[a-z]+)?|(?:align|justify|place)-self)$/;
const OUTLINE_STATE_WRITE = /outline-?state|(?:\.element|\bbtn(?:Mute|Help))\.(?:(?:setAttribute|removeAttribute|toggleAttribute)\(\s*['"`]aria-pressed|ariaPressed\b)/i;
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
  'btn-mute',
  'btn-power',
  'btn-remove',
  'btn-session-menu',
  'doc-editor-save',
  'hooks-btn',
  'hooks-btn-add',
  'hooks-btn-danger',
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

test('only public/ui/ sets an outlined button state', () => {
  const offenders = collectFiles(PUBLIC_DIR, /\.(ts|html)$/)
    .filter((file) => !file.startsWith(UI_DIR + path.sep))
    .filter((file) => OUTLINE_STATE_WRITE.test(fs.readFileSync(file, 'utf8')))
    .map(relativeToRoot);
  assert.deepEqual(offenders, [], `Set an outlined button's state through the setState of the handle outlineIconButton() returns:\n  ${offenders.join('\n  ')}`);
});

function topLevelBlocksOf(stylesheet: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let index = 0; index < stylesheet.length; index += 1) {
    const character = stylesheet[index];
    if (character === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth += 1;
      continue;
    }
    if (character !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    blocks.push({ prelude: stylesheet.slice(preludeStart, bodyStart - 1).replace(/[;}]/g, '').trim(), body: stylesheet.slice(bodyStart, index) });
    preludeStart = index + 1;
  }
  return blocks;
}

const PRIMITIVE_LAYERS = ['@layer primitive-layout', '@layer primitive-look'];
const LAYER_ORDER = '@layer tailwind, xterm, primitive-layout, components, primitive-look;';
const TAILWIND_ENTRY = path.join(PUBLIC_DIR, 'tailwind.css');

function propertiesOf(stylesheet: string): string[] {
  const withoutKeyframes = stylesheet.replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  return [...withoutKeyframes.matchAll(/\{([^{}]*)\}/g)].flatMap((block) => [...block[1].matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((declaration) => declaration[1].toLowerCase()));
}

function primitiveLayerBody(stylesheet: string, layer: string): string {
  return topLevelBlocksOf(withoutCssComments(stylesheet)).filter((block) => block.prelude === layer).map((block) => block.body).join('\n');
}

test('public/tailwind.css stacks primitive look above components and primitive layout below them', () => {
  const entry = withoutCssComments(fs.readFileSync(TAILWIND_ENTRY, 'utf8'));
  assert.ok(entry.includes(LAYER_ORDER), `public/tailwind.css must declare ${LAYER_ORDER}, so a component stylesheet can place a primitive but never restyle it`);
  const localImports = [...entry.matchAll(/@import\s+"(\.\/[^"]+)"\s*([^;]*);/g)];
  const misplaced = localImports.filter(([, importPath, layer]) => (importPath.startsWith('./ui/') ? layer.trim() !== '' : layer.trim() !== 'layer(components)')).map(([statement]) => statement);
  assert.deepEqual(misplaced, [], 'A public/ui/ import declares its own layers; every other local import goes into layer(components)');
});

test('every public/ui/ stylesheet keeps layout declarations in primitive-layout and the rest in primitive-look', () => {
  const offenders = fs.globSync('*.css', { cwd: UI_DIR }).sort().flatMap((name) => {
    const stylesheet = fs.readFileSync(path.join(UI_DIR, name), 'utf8');
    const strayBlocks = topLevelBlocksOf(withoutCssComments(stylesheet)).filter((block) => !PRIMITIVE_LAYERS.includes(block.prelude)).map((block) => `public/ui/${name}: ${block.prelude} outside the primitive layers`);
    const lookInLayout = propertiesOf(primitiveLayerBody(stylesheet, '@layer primitive-layout')).filter((property) => !PRIMITIVE_LAYOUT_PROPERTY.test(property)).map((property) => `public/ui/${name}: ${property} in primitive-layout`);
    const layoutInLook = propertiesOf(primitiveLayerBody(stylesheet, '@layer primitive-look')).filter((property) => PRIMITIVE_LAYOUT_PROPERTY.test(property)).map((property) => `public/ui/${name}: ${property} in primitive-look`);
    return [...strayBlocks, ...lookInLayout, ...layoutInLook];
  });
  assert.deepEqual(offenders, [], `Layout a container may override goes in primitive-layout; the look goes in primitive-look, above every component stylesheet:\n  ${offenders.join('\n  ')}`);
});

test('every stylesheet outside public/ui/ sits in the components layer and uses no !important', () => {
  const entry = withoutCssComments(fs.readFileSync(TAILWIND_ENTRY, 'utf8'));
  const offenders = collectFiles(PUBLIC_DIR, /\.css$/)
    .filter((file) => !file.startsWith(UI_DIR + path.sep) && file !== TAILWIND_ENTRY)
    .flatMap((file) => {
      const stylesheet = withoutCssComments(fs.readFileSync(file, 'utf8')).trim();
      const importedIntoComponents = entry.includes(`@import "./${path.relative(PUBLIC_DIR, file).split(path.sep).join('/')}" layer(components);`);
      const wrapsItselfInComponents = /^@layer components\s*\{[\s\S]*\}$/.test(stylesheet) && topLevelBlocksOf(stylesheet).length === 1;
      const problems: string[] = [];
      if (!importedIntoComponents && !wrapsItselfInComponents) problems.push(`${relativeToRoot(file)}: unlayered, so it outranks every primitive layer`);
      if (/!important/.test(stylesheet)) problems.push(`${relativeToRoot(file)}: !important outranks a primitive's look`);
      return problems;
    });
  assert.deepEqual(offenders, [], `Import a stylesheet into layer(components) in public/tailwind.css or wrap it in @layer components:\n  ${offenders.join('\n  ')}`);
});

function subjectCompoundOf(selector: string): string {
  let depth = 0;
  let compoundStart = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(character)) compoundStart = index + 1;
  }
  return selector.slice(compoundStart).replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
}

function rulesOf(stylesheet: string): { selectors: string[]; properties: string[] }[] {
  return [...withoutCssComments(stylesheet).matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()).filter(Boolean),
    properties: [...match[2].matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((declaration) => declaration[1].toLowerCase()),
  }));
}

function nestedStyleRulesOf(stylesheet: string): string[] {
  const openPreludes: string[] = [];
  const nested: string[] = [];
  let preludeStart = 0;
  const source = withoutCssComments(stylesheet);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === ';') preludeStart = index + 1;
    if (character === '}') {
      openPreludes.pop();
      preludeStart = index + 1;
    }
    if (character !== '{') continue;
    const prelude = source.slice(preludeStart, index).trim();
    if (openPreludes.some((openPrelude) => !openPrelude.startsWith('@'))) nested.push(prelude);
    openPreludes.push(prelude);
    preludeStart = index + 1;
  }
  return nested;
}

test('outside public/ui/ no stylesheet nests a style rule, so the primitive restyle gate reads every selector', () => {
  const offenders = collectFiles(PUBLIC_DIR, /\.css$/)
    .filter((file) => !file.startsWith(UI_DIR + path.sep))
    .flatMap((file) => nestedStyleRulesOf(fs.readFileSync(file, 'utf8')).map((prelude) => `${relativeToRoot(file)}: ${prelude}`));
  assert.deepEqual(offenders, [], `Flatten these nested rules:\n  ${offenders.join('\n  ')}`);
});

test('outside public/ui/ a stylesheet only lays out a primitive, never restyles it, even through a property the primitive leaves unset', () => {
  const offenders = collectFiles(PUBLIC_DIR, /\.css$/)
    .filter((file) => !file.startsWith(UI_DIR + path.sep))
    .flatMap((file) => rulesOf(fs.readFileSync(file, 'utf8')).flatMap((rule) => {
      const restyledProperties = rule.properties.filter((property) => !PRIMITIVE_LAYOUT_PROPERTY.test(property));
      if (restyledProperties.length === 0) return [];
      return rule.selectors.filter((selector) => /\.ui-/.test(subjectCompoundOf(selector))).map((selector) => `${relativeToRoot(file)}: ${selector} { ${restyledProperties.join(', ')} }`);
    }));
  assert.deepEqual(offenders, [], `A primitive's look lives in public/ui/; give it an option there and set only layout from the container:\n  ${offenders.join('\n  ')}`);
});

test('every public/ui/ transition runs on a motion token and every animation waits for no-preference, so reduced motion reaches primitives above components', () => {
  const offenders = fs.globSync('*.css', { cwd: UI_DIR }).sort().flatMap((name) => {
    const stylesheet = withoutCssComments(fs.readFileSync(path.join(UI_DIR, name), 'utf8')).replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    const literalTransitions = [...stylesheet.matchAll(/(?:^|[;{\s])transition(?:-duration)?\s*:\s*([^;}]+)/g)]
      .map((match) => match[1].trim())
      .filter((value) => value !== 'none' && /(?<![\w-])\d*\.?\d+m?s\b/.test(value.replace(/var\([^)]*\)/g, '')))
      .map((value) => `public/ui/${name}: transition ${value}`);
    const unguardedAnimations = topLevelBlocksOf(stylesheet).flatMap((layerBlock) => topLevelBlocksOf(layerBlock.body))
      .filter((block) => !/prefers-reduced-motion:\s*no-preference/.test(block.prelude))
      .filter((block) => /(?:^|[;{\s])animation(?:-name)?\s*:\s*(?!none)/.test(block.body))
      .map((block) => `public/ui/${name}: animation in ${block.prelude}`);
    return [...literalTransitions, ...unguardedAnimations];
  });
  assert.deepEqual(offenders, [], `Time a primitive transition with var(--transition-fast), which public/style.css shortens under prefers-reduced-motion, and wrap a primitive animation in @media (prefers-reduced-motion: no-preference):\n  ${offenders.join('\n  ')}`);
});

test('the button hit area is locked with !important in the primitive layers, so no other stylesheet can shrink it', () => {
  const stylesheet = fs.readFileSync(path.join(UI_DIR, 'button.css'), 'utf8');
  const layerBlocks = PRIMITIVE_LAYERS.flatMap((layer) => topLevelBlocksOf(primitiveLayerBody(stylesheet, layer)));
  const extension = layerBlocks.filter((block) => block.prelude === '.ui-button::after').map((block) => block.body).join('\n');
  const coarseBody = layerBlocks.filter((block) => /^@media\s*\(pointer:\s*coarse\)$/.test(block.prelude)).map((block) => block.body).join('\n');
  for (const declaration of [/all:\s*initial\s*!important/, /pointer-events:\s*inherit\s*!important/, /visibility:\s*inherit\s*!important/, /content:\s*''\s*!important/, /display:\s*block\s*!important/, /position:\s*absolute\s*!important/, /inset:\s*min\(-1px,\s*calc\(50%\s*-\s*16px\)\)\s+0\s*!important/]) {
    assert.match(extension, declaration, `public/ui/button.css: .ui-button::after must lock ${declaration.source}, a 32px tall mouse hit area that never reaches sideways into a neighbor`);
  }
  assert.match(coarseBody, /\.ui-button::after\s*\{\s*inset:\s*min\(-1px,\s*calc\(50%\s*-\s*22px\)\)\s*!important\s*;/, 'public/ui/button.css: @media (pointer: coarse) must lock a 44px hit area on every side');
});
