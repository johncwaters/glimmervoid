import posthog from 'posthog-js';
import type { InstallPlatform } from './install-platform.ts';

export type ConsentChoice = 'pending' | 'accepted' | 'declined';
export type InstallLocation = 'hero' | 'install';
export type CopyOutcome = 'copied' | 'selected';
type SiteEvent =
  | { event: 'install_command_copied'; properties: { platform: InstallPlatform; location: InstallLocation; outcome: CopyOutcome } }
  | { event: 'install_platform_picked'; properties: { platform: InstallPlatform; detected_platform: InstallPlatform | 'unknown'; location: InstallLocation } }
  | { event: 'landing_section_viewed'; properties: { section: string; order: number } }
  | { event: 'easter_egg_found'; properties: { egg: 'animal_flight'; animal: string } };

const POSTHOG_PROJECT_TOKEN = 'phc_s68t9vWmeGcrWkx4NkLQaEiVZ9sMBxv8GjQBbAcix2Sf';
export const CONSENT_CHANGE_EVENT = 'glimmervoid:consent-change';
const CONSENT_CHOICE_BY_STATUS = { pending: 'pending', granted: 'accepted', denied: 'declined' } as const;
const INSTALL_ID_PARAM = 'gv';
const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let pendingInstallId: string | null = null;

export const isAnalyticsEnabled = import.meta.env.PROD;

export function initAnalytics(): void {
  keepInstallIdFromUrl();
  if (!isAnalyticsEnabled) return;
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-08-30',
    cookieless_mode: 'on_reject',
    opt_out_capturing_by_default: true,
    capture_dead_clicks: true,
    capture_heatmaps: true,
  });
  identifyInstallIfConsented();
  captureSectionViews();
}

function keepInstallIdFromUrl(): void {
  const url = new URL(window.location.href);
  const installId = url.searchParams.get(INSTALL_ID_PARAM);
  if (installId === null) return;
  url.searchParams.delete(INSTALL_ID_PARAM);
  history.replaceState(history.state, '', url.href);
  if (INSTALL_ID_PATTERN.test(installId)) pendingInstallId = installId.toLowerCase();
}

function identifyInstallIfConsented(): void {
  if (consentChoice() !== 'accepted') return;
  if (!pendingInstallId) return;
  posthog.identify(pendingInstallId);
  pendingInstallId = null;
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
  identifyInstallIfConsented();
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
}

export function declineAnalytics(): void {
  if (!isAnalyticsEnabled) return;
  posthog.opt_out_capturing();
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT));
}
