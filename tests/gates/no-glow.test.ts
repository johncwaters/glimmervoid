import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const GLOW_COLOR = /var\(--(?:accent|state-|prototype-accent)/;
const NUMERIC_LENGTH = /^-?(?:\d*\.)?\d+(?:px|em|rem)?$/;
const BORDER_WIDTH_KEYWORD_PX: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const BOX_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const STRIPE_SIDES = { left: 'left', right: 'right', 'inline-start': 'left', 'inline-end': 'right' } as const;
const STRIPE_COLOR = /var\(--(?:accent|state-)/;

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

function lengthInPx(token: string): number {
  const remsOrEms = /r?em$/.test(token) ? 16 : 1;
  return Number.parseFloat(token) * remsOrEms;
}

function shadowLengths(shadowLayer: string): number[] {
  return splitOutsideParentheses(shadowLayer, /\s/)
    .filter((token) => NUMERIC_LENGTH.test(token))
    .map(lengthInPx);
}

function borderWidthPx(value: string): number {
  const tokens = splitOutsideParentheses(value, /\s/);
  const keywordWidths = tokens.filter((token) => token in BORDER_WIDTH_KEYWORD_PX).map((token) => BORDER_WIDTH_KEYWORD_PX[token]);
  return Math.max(0, ...shadowLengths(value), ...keywordWidths);
}

function sideValues(value: string): Record<(typeof BOX_SIDES)[number], string> {
  const [top, right = top, bottom = top, left = right] = splitOutsideParentheses(value, /\s/);
  return { top, right, bottom, left };
}

function blurRadius(shadowLayer: string): number {
  return shadowLengths(shadowLayer)[2] ?? 0;
}

function isInsetSideStripe(shadowLayer: string): boolean {
  const [horizontalOffset = 0, verticalOffset = 0] = shadowLengths(shadowLayer);
  return /\binset\b/.test(shadowLayer) && Math.abs(horizontalOffset) > 1 && verticalOffset === 0 && STRIPE_COLOR.test(shadowLayer);
}

interface SideBorder {
  widthPx?: number;
  isColored?: boolean;
}

function sideBordersOf(declarationBlock: string): Map<string, SideBorder> {
  const borderBySide = new Map<string, SideBorder>(BOX_SIDES.map((side) => [side, {}]));
  for (const [, property, value] of declarationBlock.matchAll(/(?:^|[;{\s])(border(?:-[a-z-]+)?)\s*:\s*([^;}]+)/g)) {
    const boxWide = /^border(?:-(width|color))?$/.exec(property);
    if (boxWide) {
      const perSide = boxWide[1] ? sideValues(value) : undefined;
      for (const side of BOX_SIDES) {
        const sideValue = perSide?.[side] ?? value;
        const border = borderBySide.get(side) as SideBorder;
        if (boxWide[1] !== 'color') border.widthPx = borderWidthPx(sideValue);
        if (boxWide[1] !== 'width') border.isColored = STRIPE_COLOR.test(sideValue);
      }
      continue;
    }
    const oneSide = /^border-(left|right|inline-start|inline-end)(?:-(width|color))?$/.exec(property);
    if (!oneSide) continue;
    const border = borderBySide.get(STRIPE_SIDES[oneSide[1] as keyof typeof STRIPE_SIDES]) as SideBorder;
    if (oneSide[2] !== 'color') border.widthPx = borderWidthPx(value);
    if (oneSide[2] !== 'width') border.isColored = STRIPE_COLOR.test(value);
  }
  return borderBySide;
}

function sideBorderStripes(stylesheet: string): string[] {
  const declarationBlocks = [...stylesheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
  const widestNeutralPx = { left: 0, right: 0 };
  const blockBorders = declarationBlocks.map((block) => ({ ...block, borderBySide: sideBordersOf(block.body) }));
  for (const { borderBySide } of blockBorders) {
    for (const side of ['left', 'right'] as const) widestNeutralPx[side] = Math.max(widestNeutralPx[side], borderBySide.get(side)?.widthPx ?? 0);
  }
  return blockBorders.flatMap(({ selector, borderBySide }) => {
    const top = borderBySide.get('top') as SideBorder;
    return (['left', 'right'] as const)
      .filter((side) => {
        const border = borderBySide.get(side) as SideBorder;
        const widthPx = border.widthPx ?? widestNeutralPx[side];
        const isFullFrame = top.isColored === border.isColored && top.widthPx === border.widthPx;
        return border.isColored === true && widthPx > 1 && !isFullFrame;
      })
      .map((side) => `${selector} border-${side} stripe`);
  });
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
  const layers = shadowLayers(uncommented);
  const blurredShadows = layers.filter((layer) => GLOW_COLOR.test(layer) && blurRadius(layer) > 0);
  const insetStripes = layers.filter(isInsetSideStripe);
  return [...blurredShadows, ...insetStripes, ...radialHazes(uncommented), ...sideBorderStripes(uncommented)].map((finding) => `${relativePath}: ${finding}`);
}

test('no dashboard or site stylesheet blurs an accent or state color into a glow or draws it as a side stripe', () => {
  const dashboardGlows = [
    ...fs.globSync('public/**/*.css', { cwd: REPO_ROOT }).map((stylesheetPath) => glowsIn(stylesheetPath, readRepoFile(stylesheetPath))),
    ...fs.globSync('public/**/*.html', { cwd: REPO_ROOT }).map((markupPath) => glowsIn(markupPath, styleBlocks(readRepoFile(markupPath)))),
  ].flat();
  const siteGlows = [
    ...fs.globSync('site/src/**/*.css', { cwd: REPO_ROOT }).map((stylesheetPath) => glowsIn(stylesheetPath, readRepoFile(stylesheetPath))),
    ...fs.globSync('site/src/**/*.astro', { cwd: REPO_ROOT }).map((markupPath) => glowsIn(markupPath, styleBlocks(readRepoFile(markupPath)))),
  ].flat();
  assert.deepEqual([...dashboardGlows, ...siteGlows], [], 'state reads through a tinted fill, a full border and one motion, never a blurred glow or a side stripe (DESIGN.md Elevation, Don\'t)');
});
