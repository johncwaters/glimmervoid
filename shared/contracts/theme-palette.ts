import { z } from 'zod';

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'a color is #rrggbb' });

const ThemeStates = z.strictObject({
  running: HexColor, waiting: HexColor, failed: HexColor, monitoring: HexColor, done: HexColor,
  initializing: HexColor, idle: HexColor, starting: HexColor, complete: HexColor,
});
export type ThemeStateName = keyof z.infer<typeof ThemeStates>;
export const THEME_STATE_NAMES = ThemeStates.keyof().options;

export const ThemePalette = z.strictObject({
  label: z.string().trim().min(1).max(40),
  mode: z.enum(['dark', 'light']),
  accentAnsiSlot: z.enum(['blue', 'magenta', 'none']),
  chrome: z.strictObject({
    'bg': HexColor, 'bg-card': HexColor, 'bg-header': HexColor, 'bg-surface': HexColor,
    'border': HexColor, 'border-dim': HexColor, 'border-hover': HexColor,
    'text': HexColor, 'text-dim': HexColor, 'text-head': HexColor, 'text-muted': HexColor,
    'accent': HexColor, 'accent-dim': HexColor,
  }),
  states: ThemeStates,
});
export type ThemePalette = z.infer<typeof ThemePalette>;
