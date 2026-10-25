import posthog from 'posthog-js';

export type ConsentChoice = 'pending' | 'accepted' | 'declined';

const POSTHOG_PROJECT_TOKEN = 'phc_s68t9vWmeGcrWkx4NkLQaEiVZ9sMBxv8GjQBbAcix2Sf';
export const CONSENT_CHANGE_EVENT = 'glimmervoid:consent-change';
const CONSENT_CHOICE_BY_STATUS = { pending: 'pending', granted: 'accepted', denied: 'declined' } as const;

export const isAnalyticsEnabled = import.meta.env.PROD;

export function initAnalytics(): void {
  if (!isAnalyticsEnabled) return;
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-08-30',
    cookieless_mode: 'on_reject',
    opt_out_capturing_by_default: true,
    capture_dead_clicks: true,
    capture_heatmaps: true,
  });
}

export function consentChoice(): ConsentChoice {
  if (!isAnalyticsEnabled) return 'pending';
  return CONSENT_CHOICE_BY_STATUS[posthog.get_explicit_consent_status()];
}

export function acceptAnalytics(): void {
  if (!isAnalyticsEnabled) return;
  posthog.opt_in_capturing();
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
}

export function declineAnalytics(): void {
  if (!isAnalyticsEnabled) return;
  posthog.opt_out_capturing();
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
}
