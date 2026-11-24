import type { ThemePalette } from '#shared/contracts/theme-palette.ts';
import { COMMUNITY_SOURCES } from '#shared/contracts/community.ts';
import type { CommunitySource } from '#shared/contracts/community.ts';

type ThemeMode = ThemePalette['mode'];

const AGENT_BRAND_COLOR_BY_AGENT_ID: ReadonlyMap<string, Record<ThemeMode, string>> = new Map([
  ['claude-code', { dark: '#d97757', light: '#c66647' }],
  ['gemini', { dark: '#3186ff', light: '#287ef6' }],
  ['kimi', { dark: '#007cff', light: '#007cff' }],
  ['qwen', { dark: '#6950ef', light: '#6950ef' }],
]);

const SOURCE_BRAND_COLOR_BY_SOURCE: Readonly<Record<CommunitySource, Record<ThemeMode, string>>> = {
  forum: { dark: '#f9bd2b', light: '#b7791f' },
  discord: { dark: '#7983f5', light: '#5865f2' },
};

function agentBrandProperty(agentId: string): string {
  return `--agent-brand-${agentId}`;
}

function sourceBrandProperty(source: CommunitySource): string {
  return `--source-brand-${source}`;
}

export function brandCssColors(mode: ThemeMode): Record<string, string> {
  const agentColors = [...AGENT_BRAND_COLOR_BY_AGENT_ID].map(([agentId, colorByMode]) => [agentBrandProperty(agentId), colorByMode[mode]]);
  const sourceColors = COMMUNITY_SOURCES.map((source) => [sourceBrandProperty(source), SOURCE_BRAND_COLOR_BY_SOURCE[source][mode]]);
  return Object.fromEntries([...agentColors, ...sourceColors]);
}

export function agentBrandColorReference(agentId: string): string {
  return `var(${agentBrandProperty(agentId)}, var(--text-head))`;
}

export function sourceBrandColorReference(source: CommunitySource): string {
  return `var(${sourceBrandProperty(source)}, var(--text-head))`;
}
