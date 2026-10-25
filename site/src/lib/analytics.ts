import posthog from 'posthog-js';
import type { InstallPlatform } from './install-platform.ts';

export type ConsentChoice = 'pending' | 'accepted' | 'declined';
export type InstallLocation = 'hero' | 'install';
export type CopyOutcome = 'copied' | 'selected';
type SiteEvent =
  | { event: 'install_command_copied'; properties: { platform: InstallPlatform; location: InstallLocation; outcome: CopyOutcome } }
  | { event: 'install_platform_picked'; properties: { platform: InstallPlatform; detected_platform: InstallPlatform | 'unknown'; location: InstallLocation } }
  | { event: 'landing_section_viewed'; properties: { section: string; order: number } };

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
  captureSectionViews();
}

export function captureSiteEvent(siteEvent: SiteEvent): void {
  if (!isAnalyticsEnabled) return;
  posthog.capture(siteEvent.event, siteEvent.properties);
}

function captureSectionViews(): void {
  const sections = [...document.querySelectorAll<HTMLElement>('section[id]')];
  const sectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
      sectionObserver.unobserve(entry.target);
      captureSiteEvent({ event: 'landing_section_viewed', properties: { section: entry.target.id, order: sections.indexOf(entry.target) + 1 } });
    }
  }, { rootMargin: '0px 0px -40% 0px' });
  for (const section of sections) sectionObserver.observe(section);
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
