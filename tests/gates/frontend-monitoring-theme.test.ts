import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyTheme, getThemeList } from '../../public/theme.ts';
import { SETTINGS_REGISTRY } from '../../shared/settings/registry.ts';
import { stubGlobalForTest } from '../helpers/frontend-global-stub.ts';

const colorBible = fs.readFileSync(path.join(import.meta.dirname, '../../brand-bible/color.yaml'), 'utf8').replace(/\r\n/g, '\n');

interface BibleTheme {
  label: string;
  overrides: Map<string, string>;
}

interface ContrastPair {
  foreground: string;
  background: string;
  minContrast: number;
}

const HEX_COLOR_VALUE = /^["']?(#[0-9a-f]{6})["']?$/i;

function topLevelBlock(key: string): string {
  const block = colorBible.match(new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[a-zA-Z]|(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(block, `brand-bible/color.yaml has no ${key} block`);
  return block;
}

function namedEntries(block: string, indent: number): { name: string; body: string }[] {
  const entryStart = new RegExp(`^(?= {${indent}}[a-z-]+:)`, 'm');
  return block.split(entryStart).filter((chunk) => chunk.trim() !== '').map((chunk) => {
    const name = chunk.match(new RegExp(`^ {${indent}}([a-z-]+):`))?.[1];
    assert.ok(name, `brand-bible/color.yaml has an entry that does not parse: ${chunk.trim().split('\n')[0]}`);
    return { name, body: chunk };
  });
}

function parseHexColor(rawValue: string | undefined, where: string): string {
  const color = rawValue?.trim().match(HEX_COLOR_VALUE)?.[1];
  assert.ok(color, `brand-bible/color.yaml ${where} has no hex colour that parses`);
  return color.toLowerCase();
}

function readBibleTokens(): Map<string, string> {
  return new Map(namedEntries(topLevelBlock('tokens'), 2).map((token) => {
    const rawValue = token.body.match(/^ {4}value:(.*)$/m)?.[1];
    return [token.name, parseHexColor(rawValue, `token ${token.name}`)];
  }));
}

function readBibleThemes(): Map<string, BibleTheme> {
  return new Map(namedEntries(topLevelBlock('themes'), 2).map((theme) => {
    const label = theme.body.match(/^ {4}label: (.+)$/m)?.[1];
    assert.ok(label, `brand-bible/color.yaml theme ${theme.name} has no label`);
    const overrideLines = theme.body.split('\n').filter((line) => /^ {6}\S/.test(line));
    const overrides = new Map(overrideLines.map((line) => {
      const [tokenName, ...valueParts] = line.trim().split(':');
      return [tokenName, parseHexColor(valueParts.join(':'), `theme ${theme.name} override ${tokenName}`)];
    }));
    return [theme.name, { label, overrides }];
  }));
}

function readBibleContrastPairs(): ContrastPair[] {
  const pairLines = topLevelBlock('pairs').split('\n').filter((line) => line.trim().startsWith('-'));
  return pairLines.map((line) => {
    const field = (fieldName: string) => line.match(new RegExp(`${fieldName}:\\s*([a-z0-9.-]+)`))?.[1];
    const foreground = field('foreground');
    const background = field('background');
    const minContrast = Number(field('minContrast'));
    assert.ok(foreground && background && minContrast > 0, `brand-bible/color.yaml has a contrast pair that does not parse: ${line.trim()}`);
    return { foreground, background, minContrast };
  });
}

function relativeLuminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)?.map((channel) => {
    const intensity = Number.parseInt(channel, 16) / 255;
    if (intensity <= 0.04045) return intensity / 12.92;
    return ((intensity + 0.055) / 1.055) ** 2.4;
  });
  assert.ok(channels && channels.length === 3, color);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function captureAppliedThemeColors(context: test.TestContext): (themeId: string) => Map<string, string> {
  const colors = new Map<string, string>();
  stubGlobalForTest(context, 'document', { documentElement: { dataset: {}, style: { setProperty: (name: string, value: string) => colors.set(name, value) } } });
  return (themeId) => {
    colors.clear();
    applyTheme(themeId);
    return new Map(colors);
  };
}

test('every theme defines a distinct Monitoring color', (context) => {
  const colorsOfTheme = captureAppliedThemeColors(context);
  const themes = getThemeList().sort((first, second) => Number(second.id === 'unicorn') - Number(first.id === 'unicorn'));
  for (const theme of themes) {
    const colors = colorsOfTheme(theme.id);
    const monitoring = colors.get('--state-monitoring');
    assert.ok(monitoring, theme.id);
    assert.ok(colors.get('--state-monitoring-bg'), theme.id);
    for (const [token, color] of colors) {
      if (!token.startsWith('--state-') || token === '--state-monitoring' || !/^#[0-9a-f]{6}$/i.test(color)) continue;
      assert.notEqual(monitoring.toLowerCase(), color.toLowerCase(), `${theme.id}: ${token}`);
    }
  }
});

test('every theme ships exactly the colors, label and contrast the brand bible declares', (context) => {
  const colorsOfTheme = captureAppliedThemeColors(context);
  const bibleTokens = readBibleTokens();
  const bibleThemes = readBibleThemes();
  const contrastPairs = readBibleContrastPairs();
  const shippedThemes = getThemeList();
  assert.ok(bibleTokens.size > 0 && contrastPairs.length > 0, 'brand-bible/color.yaml tokens or pairs did not parse');

  assert.deepEqual(shippedThemes.map((theme) => theme.id).sort(), [...bibleThemes.keys()].sort(), 'public/theme.ts and brand-bible/color.yaml list different themes');

  const themeSetting = SETTINGS_REGISTRY.sections.flatMap((section) => section.settings).find((setting) => setting.id === 'theme');
  const bibleDefaultTheme = colorBible.match(/^defaultTheme: (\S+)$/m)?.[1];
  assert.equal(themeSetting?.defaultValue, bibleDefaultTheme, 'the theme setting default differs from the bible defaultTheme');

  for (const shippedTheme of shippedThemes) {
    const bibleTheme = bibleThemes.get(shippedTheme.id);
    assert.ok(bibleTheme, shippedTheme.id);
    assert.equal(shippedTheme.label, bibleTheme.label, `${shippedTheme.id}: label`);

    const shippedColors = colorsOfTheme(shippedTheme.id);
    const expectedColors = new Map([...bibleTokens, ...bibleTheme.overrides]);
    for (const [token, bibleColor] of expectedColors) {
      const shippedColor = shippedColors.get(`--${token}`);
      if (shippedColor === undefined) continue;
      assert.equal(shippedColor.toLowerCase(), bibleColor, `${shippedTheme.id}: --${token} is ${shippedColor}, bible says ${bibleColor}`);
    }

    for (const pair of contrastPairs) {
      const foreground = shippedColors.get(`--${pair.foreground}`);
      const background = shippedColors.get(`--${pair.background}`);
      assert.ok(foreground && background, `${shippedTheme.id}: ${pair.foreground} on ${pair.background} is not set`);
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= pair.minContrast, `${shippedTheme.id}: ${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}, bible needs ${pair.minContrast}`);
    }
  }
});
