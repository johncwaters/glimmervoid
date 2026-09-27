import type { BrowserConfig } from '#shared/contracts/browser-config.ts';

type FeatureSurfaceSettings = Partial<Pick<BrowserConfig, 'teamReview' | 'posthog' | 'visions' | 'usage' | 'millEnabled'>>;

export function availableSurfacesFromSettings(settings: FeatureSurfaceSettings | null | undefined) {
  return {
    prs: settings?.teamReview?.enabled === true,
    radar: settings?.posthog?.enabled === true,
    visions: settings?.visions?.enabled === true,
    usage: settings?.usage?.enabled !== false,
    mill: settings?.millEnabled !== false,
  };
}
