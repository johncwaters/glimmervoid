import { THEME_STATE_NAMES } from './contracts/theme-palette.ts';
import type { ThemePalette, ThemeStateName } from './contracts/theme-palette.ts';

const STRONG_TINT_STATES: ReadonlySet<ThemeStateName> = new Set(['waiting', 'monitoring']);

function stateColors(states: ThemePalette['states']): Record<string, string> {
  return Object.fromEntries(THEME_STATE_NAMES.flatMap((stateName) => {
    const tintPercent = STRONG_TINT_STATES.has(stateName) ? 8 : 6;
    return [[`--state-${stateName}`, states[stateName]], [`--state-${stateName}-bg`, `color-mix(in oklab, var(--state-${stateName}) ${tintPercent}%, transparent)`]];
  }));
}

export function themeCssColors(palette: ThemePalette): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(palette.chrome).map(([token, color]) => [`--${token}`, color])), ...stateColors(palette.states) };
}
