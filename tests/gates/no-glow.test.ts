import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const GLOW_COLOR = /var\(--(?:accent|state-|prototype-accent)/;
const NUMERIC_LENGTH = /^-?(?:\d*\.)?\d+(?:px|em|rem)?$/;

const readRepoFile = (relativePath: string) => fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
const withoutComments = (stylesheet: string) => stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
const styleBlocks = (markup: string) => [...markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');

function splitOutsideParentheses(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0 && separator.test(character)) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function blurRadius(shadowLayer: string): number {
  const lengths = splitOutsideParentheses(shadowLayer, /\s/).filter((token) => NUMERIC_LENGTH.test(token));
  return Number.parseFloat(lengths[2] ?? '0');
}

function shadowLayers(stylesheet: string): string[] {
  const declared = [...stylesheet.matchAll(/(?:box-shadow|text-shadow|--[\w-]+)\s*:\s*([^;}]+)/g)].flatMap((match) => splitOutsideParentheses(match[1], /,/));
  const filtered = [...stylesheet.matchAll(/drop-shadow\(((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)\)/g)].map((match) => match[1]);
  return [...declared, ...filtered];
}

function radialHazes(stylesheet: string): string[] {
  const gradients = [...stylesheet.matchAll(/radial-gradient\(((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)\)/g)].map((match) => match[1]);
  return gradients.filter((gradient) => {
    const colorStops = splitOutsideParentheses(gradient, /,/);
    return colorStops.some(isSoftGlowStop) && colorStops.some((colorStop) => colorStop.startsWith('transparent'));
  });
}

function isSoftGlowStop(colorStop: string): boolean {
  const tokens = splitOutsideParentheses(colorStop, /\s/);
  const glowColorIndex = tokens.findIndex((token) => GLOW_COLOR.test(token));
  return glowColorIndex >= 0 && glowColorIndex === tokens.length - 1;
}

function glowsIn(relativePath: string, stylesheet: string): string[] {
  const uncommented = withoutComments(stylesheet);
  const blurredShadows = shadowLayers(uncommented).filter((layer) => GLOW_COLOR.test(layer) && blurRadius(layer) > 0);
  return [...blurredShadows, ...radialHazes(uncommented)].map((glow) => `${relativePath}: ${glow}`);
}

test('no dashboard or site stylesheet blurs an accent or state color into a glow', () => {
  const dashboardGlows = [
    ...fs.globSync('public/**/*.css', { cwd: REPO_ROOT }).map((stylesheetPath) => glowsIn(stylesheetPath, readRepoFile(stylesheetPath))),
    ...fs.globSync('public/**/*.html', { cwd: REPO_ROOT }).map((markupPath) => glowsIn(markupPath, styleBlocks(readRepoFile(markupPath)))),
  ].flat();
  const siteGlows = [
    ...fs.globSync('site/src/**/*.css', { cwd: REPO_ROOT }).map((stylesheetPath) => glowsIn(stylesheetPath, readRepoFile(stylesheetPath))),
    ...fs.globSync('site/src/**/*.astro', { cwd: REPO_ROOT }).map((markupPath) => glowsIn(markupPath, styleBlocks(readRepoFile(markupPath)))),
  ].flat();
  assert.deepEqual([...dashboardGlows, ...siteGlows], [], 'state reads through a tinted fill, a border step and one motion, never a blurred glow (DESIGN.md Elevation)');
});
