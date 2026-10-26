import type { BrowserConfig } from '#shared/contracts/browser-config.ts';

export type FeatureSurfaceSettings = Partial<Pick<BrowserConfig, 'teamReview' | 'benchmarks' | 'posthog' | 'visions' | 'usage'>> | null | undefined;

export type FeatureSurfaceRule = (settings: FeatureSurfaceSettings) => boolean;

export const FEATURE_SURFACE_RULES = {
  teamReview: (settings) => settings?.teamReview?.enabled === true,
  posthog: (settings) => settings?.posthog?.enabled === true,
  visions: (settings) => settings?.visions?.enabled === true,
  usage: (settings) => settings?.usage?.enabled !== false,
  benchmarks: (settings) => settings?.benchmarks?.enabled === true,
} satisfies Record<string, FeatureSurfaceRule>;

interface OptionalFeatureSurface {
  rule: keyof typeof FEATURE_SURFACE_RULES;
  sectionId: string;
  settingId: string;
}

export const OPTIONAL_FEATURE_SURFACES: readonly OptionalFeatureSurface[] = [
  { rule: 'teamReview', sectionId: 'lanes-team-review', settingId: 'team-review-enabled' },
  { rule: 'usage', sectionId: 'machine-usage', settingId: 'usage-enabled' },
  { rule: 'posthog', sectionId: 'lanes-posthog', settingId: 'posthog-enabled' },
  { rule: 'visions', sectionId: 'lanes-visions', settingId: 'visions-enabled' },
  { rule: 'benchmarks', sectionId: 'lanes-benchmarks', settingId: 'benchmarks-enabled' },
];
