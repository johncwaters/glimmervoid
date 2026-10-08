import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const dashboardStylesheet = fs.readFileSync(path.join(REPO_ROOT, 'public', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const dashboardMarkup = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');

const DESIGN_FONT_SIZES = new Set(['10px', '11px', '12px', '14px', '16px']);
const DESIGN_FONT_WEIGHTS = new Set(['400', '700']);
const DESIGN_LABEL_TRACKING = '0.08em';
const DESIGN_HEADLINE_TRACKING = '0.1em';
const DESIGN_HEADLINE_SIZE = '16px';
const DESIGN_LABEL_SIZES = new Set(['10px', '11px']);

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

function shorthandSizesAndWeights(rule: StyleRule): { sizes: string[]; weights: string[] } {
  const shorthands = declaredValues(rule, /(?:^|[;\s])font:\s*([^;}]+)/g).filter((value) => value !== 'inherit');
  return {
    sizes: shorthands.flatMap((value) => value.match(/\b\d+(?:\.\d+)?px\b/)?.slice(0, 1) ?? []),
    weights: shorthands.flatMap((value) => value.match(/^\d{3}\b/)?.slice(0, 1) ?? []),
  };
}

test('every dashboard font size sits on the DESIGN.md type scale', () => {
  const offScale = styleRules(dashboardStylesheet).flatMap((rule) => {
    const sizes = [...declaredValues(rule, /font-size:\s*([^;}]+)/g), ...shorthandSizesAndWeights(rule).sizes];
    return sizes.filter((size) => size !== 'inherit' && !DESIGN_FONT_SIZES.has(size)).map((size) => `${rule.selector}: ${size}`);
  });
  assert.deepEqual(offScale, []);
});

test('every dashboard font weight is regular or bold, as DESIGN.md defines', () => {
  const offScale = styleRules(dashboardStylesheet).flatMap((rule) => {
    const weights = [...declaredValues(rule, /font-weight:\s*([^;}]+)/g), ...shorthandSizesAndWeights(rule).weights];
    return weights.filter((weight) => weight !== 'inherit' && !DESIGN_FONT_WEIGHTS.has(weight)).map((weight) => `${rule.selector}: ${weight}`);
  });
  assert.deepEqual(offScale, []);
});

function declaredSizes(rule: StyleRule): string[] {
  return [...declaredValues(rule, /font-size:\s*([^;}]+)/g), ...shorthandSizesAndWeights(rule).sizes];
}

test('every uppercase dashboard rule is a 0.08em label or a 16px 0.1em headline, as DESIGN.md defines', () => {
  const offScale = styleRules(dashboardStylesheet)
    .filter((rule) => /text-transform:\s*uppercase/.test(rule.declarations))
    .flatMap((rule) => {
      const tracking = declaredValues(rule, /letter-spacing:\s*([^;}]+)/g);
      if (tracking.length === 0) return [`${rule.selector}: no letter-spacing`];
      const sizes = declaredSizes(rule);
      const isHeadline = sizes.includes(DESIGN_HEADLINE_SIZE);
      const allowedTracking = isHeadline ? DESIGN_HEADLINE_TRACKING : DESIGN_LABEL_TRACKING;
      const badTracking = tracking.filter((value) => value !== allowedTracking).map((value) => `${rule.selector}: ${value}`);
      const badSizes = isHeadline ? [] : sizes.filter((size) => size !== 'inherit' && !DESIGN_LABEL_SIZES.has(size)).map((size) => `${rule.selector}: ${size}`);
      return [...badTracking, ...badSizes];
    });
  assert.deepEqual(offScale, []);
});

test('10px type is reserved for bold or uppercase labels, so captions start at 11px as DESIGN.md defines', () => {
  const smallCaptions = styleRules(dashboardStylesheet)
    .filter((rule) => [...declaredValues(rule, /font-size:\s*([^;}]+)/g), ...shorthandSizesAndWeights(rule).sizes].includes('10px'))
    .filter((rule) => !/text-transform:\s*uppercase/.test(rule.declarations) && !/font-weight:\s*700/.test(rule.declarations) && !shorthandSizesAndWeights(rule).weights.includes('700'))
    .map((rule) => rule.selector);
  assert.deepEqual(smallCaptions, []);
});

test('the dashboard shell inline styles only ever set the monospace stack, since they outrank the layered stylesheet', () => {
  const inlineStyles = [...dashboardMarkup.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  const nonMonospaceFamilies = [...inlineStyles.matchAll(/font-family:\s*([^;}]+)/g)].map((match) => match[1].trim()).filter((family) => !/monospace\)?$/.test(family));
  assert.deepEqual(nonMonospaceFamilies, []);
});
