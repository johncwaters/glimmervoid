import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const readRepoFile = (relativePath: string) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
const withoutComments = (stylesheet: string) => stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

const PRIMITIVE_STYLESHEETS = fs.globSync('public/ui/*.css', { cwd: REPO_ROOT }).sort();
const SPACING_SCALE_PX = new Set([0, 6, 8, 12, 16, 24]);
const SPACING_PROPERTY = /^(?:(?:padding|margin)(?:-[a-z]+)*|gap|row-gap|column-gap)$/;
const PX_LITERAL = /-?\d*\.?\d+px\b/g;
const HAS_PX_LITERAL = /\dpx\b/;
const BORDER_WIDTH_SUBTRACTED = /-\s+1px\b/g;
const BORDER_OVERLAP_MARGIN = '-1px';
const TYPE_TOKEN = /^var\(--type-[a-z0-9-]+\)$/;

interface Declaration {
  file: string;
  selector: string;
  property: string;
  value: string;
}

interface Exemption {
  file: string;
  selector: string;
  declaration: string;
  reason: string;
}

const OFF_SCALE_EXEMPTIONS: Exemption[] = [
  { file: 'public/ui/button.css', selector: '.ui-button-shortcut', declaration: 'padding: 0 4px', reason: 'the shortcut key cap fits an 18px box; 6px would widen a two-character cap' },
  { file: 'public/ui/notice.css', selector: '.notice', declaration: 'gap: 8px 10px', reason: 'the notice banner predates the scale; its spacing moves with a reviewed visible change, not this foundation' },
  { file: 'public/ui/notice.css', selector: '.notice-actions', declaration: 'gap: 10px', reason: 'the notice banner predates the scale; its spacing moves with a reviewed visible change, not this foundation' },
  { file: 'public/ui/notice.css', selector: '.notice-command', declaration: 'padding: 2px 8px', reason: 'the inline command chip keeps its 2px block padding until it moves onto --chip-height' },
];

function declarationsOf(file: string): Declaration[] {
  const stylesheet = withoutComments(readRepoFile(file));
  return [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((rule) => {
    const selector = rule[1].trim();
    return rule[2]
      .split(';')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.includes(':'))
      .map((chunk) => {
        const colon = chunk.indexOf(':');
        return { file, selector, property: chunk.slice(0, colon).trim(), value: chunk.slice(colon + 1).trim() };
      });
  });
}

const declarations = PRIMITIVE_STYLESHEETS.flatMap(declarationsOf);
const fontSizeDeclarations = declarations.filter((declaration) => declaration.property === 'font-size');
const spacingDeclarations = declarations.filter((declaration) => SPACING_PROPERTY.test(declaration.property));
const describe = (declaration: Declaration) => `${declaration.file} ${declaration.selector} { ${declaration.property}: ${declaration.value} }`;
const isExempt = (declaration: Declaration) =>
  OFF_SCALE_EXEMPTIONS.some((exemption) => exemption.file === declaration.file && exemption.selector === declaration.selector && exemption.declaration === `${declaration.property}: ${declaration.value}`);

function offScalePx(declaration: Declaration): string[] {
  const withoutBorderWidths = declaration.value.replace(BORDER_WIDTH_SUBTRACTED, '');
  return [...withoutBorderWidths.matchAll(PX_LITERAL)]
    .map((match) => match[0])
    .filter((literal) => !SPACING_SCALE_PX.has(Number.parseFloat(literal)))
    .filter((literal) => !(literal === BORDER_OVERLAP_MARGIN && declaration.property.startsWith('margin')));
}

test('the gate reads every primitive stylesheet and finds font sizes and px spacing to check', () => {
  assert.ok(PRIMITIVE_STYLESHEETS.includes('public/ui/button.css'), 'public/ui/button.css was not scanned');
  assert.ok(PRIMITIVE_STYLESHEETS.includes('public/ui/notice.css'), 'public/ui/notice.css was not scanned');
  assert.ok(fontSizeDeclarations.length > 0, 'no font-size declaration found in public/ui/*.css');
  assert.ok(spacingDeclarations.some((declaration) => HAS_PX_LITERAL.test(declaration.value)), 'no px spacing declaration found in public/ui/*.css');
});

test('every primitive font size is a type token or inherits', () => {
  const offScale = fontSizeDeclarations.filter((declaration) => declaration.value !== 'inherit' && !TYPE_TOKEN.test(declaration.value)).map(describe);
  assert.deepEqual(offScale, []);
});

test('every px literal in primitive padding, margin and gap is on the spacing scale, a 1px border width taken off, or a -1px border overlap', () => {
  const offScale = spacingDeclarations.filter((declaration) => !isExempt(declaration) && offScalePx(declaration).length > 0).map(describe);
  assert.deepEqual(offScale, []);
});

test('every off-scale exemption names a declaration that exists and is still off the scale', () => {
  const stale = OFF_SCALE_EXEMPTIONS.filter((exemption) => {
    const match = spacingDeclarations.find((declaration) => isExempt(declaration) && declaration.file === exemption.file && declaration.selector === exemption.selector);
    return !match || offScalePx(match).length === 0 || exemption.reason.length === 0;
  }).map((exemption) => `${exemption.file} ${exemption.selector} { ${exemption.declaration} }`);
  assert.deepEqual(stale, []);
});

function controlTokenValues(blockSelector: string): Record<string, string> {
  const blocks = [...withoutComments(readRepoFile('public/style.css')).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) => rule[1].trim() === blockSelector && /--type-/.test(rule[2]));
  assert.equal(blocks.length, 1, `expected one ${blockSelector} token rule in public/style.css`);
  return Object.fromEntries([...blocks[0][2].matchAll(/--((?:control|chip)-[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function bibleControlSizes(): Record<string, { px: string; phonePx: string }> {
  const controlsBlock = readRepoFile('brand-bible/shape.yaml').match(/^controls:\n((?: {2}.*\n)+)/m)?.[1] ?? '';
  return Object.fromEntries([...controlsBlock.matchAll(/^ {2}([a-z-]+): \{ px: (\d+), phonePx: (\d+) \}$/gm)].map((match) => [match[1], { px: `${match[2]}px`, phonePx: `${match[3]}px` }]));
}

test('the control size tokens carry the brand bible shape controls, desktop and phone', () => {
  const bible = bibleControlSizes();
  assert.ok(Object.keys(bible).length >= 6, 'brand-bible/shape.yaml controls block did not parse');
  const root = controlTokenValues(':root');
  const phone = { ...root, ...controlTokenValues('html[data-layout="phone"]') };
  assert.deepEqual(root, Object.fromEntries(Object.entries(bible).map(([token, sizes]) => [token, sizes.px])));
  assert.deepEqual(phone, Object.fromEntries(Object.entries(bible).map(([token, sizes]) => [token, sizes.phonePx])));
  const namedInDesignDoc = new Set([...readRepoFile('DESIGN.md').matchAll(/--((?:control|chip)-[a-z-]+)/g)].map((match) => match[1]));
  assert.deepEqual(Object.keys(bible).filter((token) => !namedInDesignDoc.has(token)), []);
});
