import type { ThemePalette } from '#shared/contracts/theme-palette.ts';
import { themeCssColors } from '#shared/theme-colors-core.ts';
import { BUILT_IN_THEME_PALETTES } from '#shared/theme-palettes.ts';
import { brandCssColors } from './brand-colors.ts';
import { setThemeColors } from './ui-prefs.ts';

type ThemeMode = ThemePalette['mode'];

interface ThemeDefinition {
  label: string;
  colors: Record<string, string>;
  terminal: Record<string, string>;
}

const ANSI_HUES_BY_MODE: Record<ThemeMode, Record<string, string>> = {
  dark: {
    red:          '#ef4444',
    brightRed:    '#f87171',
    green:        '#22c55e',
    brightGreen:  '#4ade80',
    yellow:       '#eab308',
    brightYellow: '#facc15',
    blue:         '#3b82f6',
    brightBlue:   '#60a5fa',
    magenta:      '#a855f7',
    brightMagenta:'#c084fc',
    cyan:         '#06b6d4',
    brightCyan:   '#22d3ee',
  },
  light: {
    red:          '#b91c1c',
    brightRed:    '#dc2626',
    green:        '#15803d',
    brightGreen:  '#008223',
    yellow:       '#92400e',
    brightYellow: '#a16207',
    blue:         '#1d4ed8',
    brightBlue:   '#2563eb',
    magenta:      '#6d28d9',
    brightMagenta:'#7c3aed',
    cyan:         '#0e7490',
    brightCyan:   '#00799a',
  },
};

const ANSI_NEUTRALS_BY_MODE: Record<ThemeMode, Record<string, string>> = {
  dark: {
    black:       '--border',
    brightBlack: '--text-muted',
    white:       '--text',
    brightWhite: '--text-head',
  },
  light: {
    black:       '--text-head',
    brightBlack: '--text-dim',
    white:       '--text-dim',
    brightWhite: '--text',
  },
};

const BRIGHT_ACCENT_WHITE_SHARE = 0.35;

function mixTowardWhite(hexColor: string, whiteShare: number): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hexColor.slice(offset, offset + 2), 16));
  const mixedChannels = channels.map((channel) => Math.round(channel + (255 - channel) * whiteShare));
  return `#${mixedChannels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function buildAccentAnsi(palette: ThemePalette): Record<string, string> {
  if (palette.accentAnsiSlot === 'none') return {};
  const brightSlot = `bright${palette.accentAnsiSlot[0].toUpperCase()}${palette.accentAnsiSlot.slice(1)}`;
  return {
    [palette.accentAnsiSlot]: '--accent',
    [brightSlot]: mixTowardWhite(palette.chrome.accent, BRIGHT_ACCENT_WHITE_SHARE),
  };
}

function defineTheme(palette: ThemePalette): ThemeDefinition {
  return {
    label: palette.label,
    colors: { ...themeCssColors(palette), ...brandCssColors(palette.mode) },
    terminal: {
      background:   '--bg-card',
      foreground:   '--text',
      cursor:       '--accent',
      cursorAccent: '--bg-card',
      ...ANSI_NEUTRALS_BY_MODE[palette.mode],
      ...ANSI_HUES_BY_MODE[palette.mode],
      ...buildAccentAnsi(palette),
    },
  };
}

const THEMES: Record<string, ThemeDefinition> = Object.fromEntries(
  Object.entries(BUILT_IN_THEME_PALETTES).map(([themeId, palette]) => [themeId, defineTheme(palette)]),
);

const DEFAULT_THEME = 'glimmer';

let unicornThemeEnteredListener: (() => void) | null = null;
let _currentThemeId: string | null = null;
let requestedThemeId: string | null = null;
let packThemesById: Record<string, ThemeDefinition> = {};

function themeById(themeId: string): ThemeDefinition | undefined {
  return Object.hasOwn(THEMES, themeId) ? THEMES[themeId] : packThemesById[themeId];
}

export function setPackThemes(packThemes: readonly { id: string; palette: ThemePalette }[]): boolean {
  packThemesById = Object.fromEntries(packThemes.map(({ id, palette }) => [id, defineTheme(palette)]));
  const wantedThemeId = requestedThemeId ?? DEFAULT_THEME;
  const shownThemeId = themeById(wantedThemeId) ? wantedThemeId : DEFAULT_THEME;
  if (shownThemeId === _currentThemeId && !Object.hasOwn(packThemesById, shownThemeId)) return false;
  showTheme(shownThemeId);
  return true;
}

export function applyTheme(themeId: string) {
  requestedThemeId = themeId;
  if (!themeById(themeId)) return;
  showTheme(themeId);
}

function showTheme(themeId: string) {
  const theme = themeById(themeId);
  if (!theme) return;

  const prev = _currentThemeId;
  _currentThemeId = themeId;
  const root = document.documentElement;
  root.dataset.theme = themeId;
  for (const [prop, value] of Object.entries(theme.colors)) {
    root.style.setProperty(prop, value);
  }
  setThemeColors(theme.colors);

  if (themeId !== 'unicorn') return;
  if (prev === null || prev === 'unicorn') return;
  unicornThemeEnteredListener?.();
}

export function onUnicornThemeEntered(listener: () => void) {
  unicornThemeEnteredListener = listener;
}


export const BRIEF_OFF_ATTRIBUTE = 'data-chat-brief-off';

export function applyChatBriefOff(isBriefOff: boolean): void {
  document.documentElement.toggleAttribute(BRIEF_OFF_ATTRIBUTE, isBriefOff);
}

export function applyPhoneArrowPad(isEnabled: boolean) {
  document.documentElement.toggleAttribute('data-arrow-pad', isEnabled);
}

export function getTerminalTheme(): Record<string, string> {
  const theme = themeById(_currentThemeId || DEFAULT_THEME);
  if (!theme) return {};

  const style = getComputedStyle(document.documentElement);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.terminal)) {
    result[key] = value.startsWith('--') ? style.getPropertyValue(value).trim() : value;
  }
  return result;
}

export function currentThemeColors(): { id: string | null; colors: Record<string, string> } {
  return { id: _currentThemeId, colors: { ...themeById(_currentThemeId ?? DEFAULT_THEME)?.colors } };
}

export function getThemeList(): { id: string; label: string }[] {
  return Object.entries({ ...THEMES, ...packThemesById }).map(([id, t]) => ({ id, label: t.label }));
}
