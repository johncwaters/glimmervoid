import { z } from 'zod';

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: (issue) => issue.input === undefined ? 'missing; a theme sets every color as #rrggbb' : `a color is #rrggbb, not ${JSON.stringify(issue.input)}` });

const ThemeStates = z.strictObject({
  running: HexColor, waiting: HexColor, failed: HexColor, monitoring: HexColor, done: HexColor,
  initializing: HexColor, idle: HexColor, starting: HexColor, complete: HexColor,
});
export type ThemeStateName = keyof z.infer<typeof ThemeStates>;
export const THEME_STATE_NAMES = ThemeStates.keyof().options;

function colorFor(role: string) {
  return HexColor.describe(role);
}

export const ThemePalette = z.strictObject({
  label: z.string().trim().min(1).max(40).describe('The name shown in the Theme picker'),
  mode: z.enum(['dark', 'light']).describe('Whether the theme is dark or light, which picks the terminal palette its ANSI colors are tuned for'),
  accentAnsiSlot: z.enum(['blue', 'magenta', 'none']).describe('The terminal ANSI color the accent replaces, with a lighter mix of it as that color\'s bright variant; none leaves terminal colors alone'),
  chrome: z.strictObject({
    'bg': colorFor('Page background'), 'bg-card': colorFor('Cards, panes and the terminal background'), 'bg-header': colorFor('Headers and toolbars'), 'bg-surface': colorFor('Raised controls: chips, inputs, menus and hover fills'),
    'border': colorFor('Default borders'), 'border-dim': colorFor('Faint dividers inside a card or list'), 'border-hover': colorFor('Borders of a hovered or focused control'),
    'text': colorFor('Body text'), 'text-dim': colorFor('Secondary text such as hints and empty states'), 'text-head': colorFor('Headings and emphasized text'), 'text-muted': colorFor('Labels and metadata, between text and text-dim'),
    'accent': colorFor('Links, focus rings, selection and primary actions'), 'accent-dim': colorFor('A quieter accent for selected borders'),
  }).describe('Dashboard colors; each key becomes the CSS custom property --<key>'),
  states: ThemeStates.describe('One color per session state, shown as --state-<state> on cards, dots and badges'),
});
export type ThemePalette = z.infer<typeof ThemePalette>;
