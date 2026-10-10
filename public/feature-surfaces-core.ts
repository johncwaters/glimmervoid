import type { BrowserConfig } from '#shared/contracts/browser-config.ts';

export type FeatureSurfaceSettings = Partial<Pick<BrowserConfig, 'teamReview' | 'benchmarks' | 'factory' | 'posthog' | 'visions' | 'usage' | 'calmLayout'>> | null | undefined;

export type FeatureSurfaceRule = (settings: FeatureSurfaceSettings) => boolean;

export const FEATURE_SURFACE_RULES = {
  teamReview: (settings) => settings?.teamReview?.enabled === true,
  posthog: (settings) => settings?.posthog?.enabled === true,
  visions: (settings) => settings?.visions?.enabled === true,
  usage: (settings) => settings?.usage?.enabled !== false,
  benchmarks: (settings) => settings?.benchmarks?.enabled === true,
  factory: (settings) => settings?.factory?.enabled === true,
  calmLayout: (settings) => settings?.calmLayout === true,
} satisfies Record<string, FeatureSurfaceRule>;
