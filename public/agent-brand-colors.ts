import type { ThemePalette } from '#shared/contracts/theme-palette.ts';

type ThemeMode = ThemePalette['mode'];

const AGENT_BRAND_COLOR_BY_AGENT_ID: ReadonlyMap<string, Record<ThemeMode, string>> = new Map([
  ['claude-code', { dark: '#d97757', light: '#c66647' }],
  ['gemini', { dark: '#3186ff', light: '#287ef6' }],
  ['kimi', { dark: '#007cff', light: '#007cff' }],
  ['qwen', { dark: '#6950ef', light: '#6950ef' }],
]);

function agentBrandProperty(agentId: string): string {
  return `--agent-brand-${agentId}`;
}

export function agentBrandCssColors(mode: ThemeMode): Record<string, string> {
  return Object.fromEntries([...AGENT_BRAND_COLOR_BY_AGENT_ID].map(([agentId, colorByMode]) => [agentBrandProperty(agentId), colorByMode[mode]]));
}

export function agentBrandColorReference(agentId: string): string {
  return `var(${agentBrandProperty(agentId)}, var(--text-head))`;
}
