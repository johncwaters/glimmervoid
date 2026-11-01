import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const readRepoFile = (relativePath: string) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
const withoutComments = (stylesheet: string) => stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
const styleBlocks = (markup: string) => [...markup.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');

const dashboardStylesheetPaths = fs.globSync('public/**/*.css', { cwd: REPO_ROOT }).filter((stylesheetPath) => !stylesheetPath.endsWith('tailwind.css'));
const dashboardStylesheet = withoutComments(dashboardStylesheetPaths.map(readRepoFile).join('\n'));
const dashboardMarkup = readRepoFile('public/index.html');
const shellInlineStylesheet = withoutComments(styleBlocks(dashboardMarkup));
const loginPageStylesheet = styleBlocks(readRepoFile('server/remote-auth.ts'));
const tailwindStylesheet = readRepoFile('public/tailwind.css');
const typographyBible = readRepoFile('brand-bible/typography.yaml');

const TYPE_TOKEN_BY_ROLE = { label: 'meta', meta: 'meta', body: 'body', title: 'title', display: 'display' } as const;
const TYPE_TOKENS = new Set(['var(--type-meta)', 'var(--type-body)', 'var(--type-title)', 'var(--type-display)']);
const LITERAL_SIZE_TOKENS = new Map([['12px', 'var(--type-meta)'], ['14px', 'var(--type-body)'], ['16px', 'var(--type-title)'], ['20px', 'var(--type-display)']]);
const BIBLE_FONT_WEIGHTS = new Set(['400', '700']);
const LABEL_TRACKING = '0.08em';
const DISPLAY_TRACKING = '0.1em';
const UNTRACKED_VALUES = new Set(['0', 'normal', 'inherit']);
const TAILWIND_SIZE_UTILITY = /(?<![\w-])text-(?:xs|sm|base|lg|\d*xl|\[\d[^\]\s]*\])(?![\w-])/g;

interface StyleRule {
  selector: string;
  declarations: string;
}

function styleRules(stylesheet: string): StyleRule[] {
  return [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), declarations: match[2] }));
}

function declaredValues(rule: StyleRule, property: RegExp): string[] {
  return [...rule.declarations.matchAll(property)].map((match) => match[1].trim());
}

function fontShorthands(rule: StyleRule): string[] {
  return declaredValues(rule, /(?:^|[;\s])font:\s*([^;}]+)/g).filter((value) => value !== 'inherit');
}

function declaredSizes(rule: StyleRule): string[] {
  const shorthandSizes = fontShorthands(rule).flatMap((value) => value.match(/var\(--type-[a-z]+\)|\b\d+(?:\.\d+)?(?:px|r?em|%)/)?.slice(0, 1) ?? []);
  return [...declaredValues(rule, /font-size:\s*([^;}]+)/g), ...shorthandSizes].filter((size) => size !== 'inherit');
}

function declaredWeights(rule: StyleRule): string[] {
  const shorthandWeights = fontShorthands(rule).flatMap((value) => value.match(/^\d{3}\b/)?.slice(0, 1) ?? []);
  return [...declaredValues(rule, /font-weight:\s*([^;}]+)/g), ...shorthandWeights].filter((weight) => weight !== 'inherit');
}

function rulesWithLiteralSizesAsTokens(stylesheet: string): StyleRule[] {
  return styleRules(stylesheet).map((rule) => ({
    selector: rule.selector,
    declarations: rule.declarations.replace(/\b\d+(?:\.\d+)?px\b/g, (size) => LITERAL_SIZE_TOKENS.get(size) ?? size),
  }));
}

function typeTokenValues(): Map<string, string> {
  return new Map([...dashboardStylesheet.matchAll(/--type-([a-z]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function bibleRoleSizes(): Map<string, string> {
  const scaleBlock = typographyBible.match(/^scale:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
  return new Map([...scaleBlock.matchAll(/^ {2}([a-z]+):.*\bsizePx: (\d+)/gm)].map((match) => [match[1], `${match[2]}px`]));
}

test('every dashboard font size is a type token', () => {
  const offScale = styleRules(dashboardStylesheet).flatMap((rule) => declaredSizes(rule).filter((size) => !TYPE_TOKENS.has(size)).map((size) => `${rule.selector}: ${size}`));
  assert.deepEqual(offScale, []);
});

test('the type tokens carry the brand bible typography sizes, role for role', () => {
  const tokenValues = typeTokenValues();
  const bibleSizes = Object.fromEntries(bibleRoleSizes());
  const tokenSizes = Object.fromEntries(Object.entries(TYPE_TOKEN_BY_ROLE).map(([role, token]) => [role, tokenValues.get(token) ?? '']));
  assert.deepEqual(bibleSizes, tokenSizes);
});

test('the dashboard shell and the login page set sizes only on the type scale', () => {
  const offScale = [shellInlineStylesheet, loginPageStylesheet].flatMap((stylesheet) =>
    styleRules(stylesheet).flatMap((rule) => declaredSizes(rule).filter((size) => !LITERAL_SIZE_TOKENS.has(size)).map((size) => `${rule.selector}: ${size}`)),
  );
  assert.deepEqual(offScale, []);
});

test('Tailwind text sizes are only the type roles, and no markup or script reaches for another', () => {
  const themeTextSizes = [...tailwindStylesheet.matchAll(/^\s*--text-([\w*-]+):\s*([^;]+);/gm)].map((match) => `${match[1]}: ${match[2].trim()}`);
  assert.deepEqual(themeTextSizes, ['*: initial', 'meta: var(--type-meta)', 'body: var(--type-body)', 'title: var(--type-title)', 'display: var(--type-display)']);
  const sourcePaths = fs.globSync('public/**/*.{ts,html}', { cwd: REPO_ROOT });
  const strayUtilities = sourcePaths.flatMap((sourcePath) => [...readRepoFile(sourcePath).matchAll(TAILWIND_SIZE_UTILITY)].map((match) => `${sourcePath}: ${match[0]}`));
  assert.deepEqual(strayUtilities, []);
});

test('every dashboard font weight is regular or bold, as the brand bible defines', () => {
  const offScale = styleRules(dashboardStylesheet).flatMap((rule) => declaredWeights(rule).filter((weight) => !BIBLE_FONT_WEIGHTS.has(weight)).map((weight) => `${rule.selector}: ${weight}`));
  assert.deepEqual(offScale, []);
});

test('only uppercase rules carry tracking: 0.08em at the meta size, 0.1em at the display size', () => {
  const rules = [...styleRules(dashboardStylesheet), ...rulesWithLiteralSizesAsTokens(shellInlineStylesheet)];
  const offScale = rules.flatMap((rule) => {
    const tracking = declaredValues(rule, /letter-spacing:\s*([^;}]+)/g);
    const undoesInheritedUppercase = /text-transform:\s*(?:none|lowercase|capitalize)/.test(rule.declarations);
    if (undoesInheritedUppercase && tracking.length === 0) return [`${rule.selector}: undoes uppercase but keeps the inherited tracking`];
    if (!/text-transform:\s*uppercase/.test(rule.declarations)) {
      return tracking.filter((value) => !UNTRACKED_VALUES.has(value)).map((value) => `${rule.selector}: lowercase ${value}`);
    }
    if (tracking.length === 0) return [`${rule.selector}: no letter-spacing`];
    const sizes = declaredSizes(rule);
    const isDisplay = sizes.includes('var(--type-display)');
    const allowedTracking = isDisplay ? DISPLAY_TRACKING : LABEL_TRACKING;
    const badTracking = tracking.filter((value) => value !== allowedTracking).map((value) => `${rule.selector}: ${value}`);
    const badSizes = sizes.filter((size) => size !== 'var(--type-meta)' && size !== 'var(--type-display)').map((size) => `${rule.selector}: uppercase ${size}`);
    return [...badTracking, ...badSizes];
  });
  assert.deepEqual(offScale, []);
});

test('no dashboard rule turns off CommitMono contextual alternates, which carry its smart kerning', () => {
  const shapingOverrides = [dashboardStylesheet, shellInlineStylesheet].flatMap((stylesheet) =>
    styleRules(stylesheet).filter((rule) => /font-(?:feature-settings|variant-ligatures|kerning)\s*:/.test(rule.declarations)).map((rule) => rule.selector),
  );
  assert.deepEqual(shapingOverrides, []);
});

test('the dashboard shell inline styles only ever set the monospace stack, since they outrank the layered stylesheet', () => {
  const nonMonospaceFamilies = [...shellInlineStylesheet.matchAll(/font-family:\s*([^;}]+)/g)].map((match) => match[1].trim()).filter((family) => !/monospace\)?$/.test(family));
  assert.deepEqual(nonMonospaceFamilies, []);
});
