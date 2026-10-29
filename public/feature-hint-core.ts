import type { FeatureHint, HintFeature } from '#shared/contracts/feature-hints.ts';
import { OPTIONAL_FEATURE_SURFACES } from './feature-surfaces-core.ts';

const PITCH_BY_FEATURE: Record<HintFeature, (distinctTargetCount: number) => string> = {
  teamReview: (count) => `${count} pull requests reviewed this week, and Reviews has not been open lately? It lines up every PR waiting on you.`,
  issues: (count) => `${count} issues touched this week. The Issues tab keeps them in one list and starts a session on any of them.`,
  usage: () => 'Keeping an eye on tokens? The Usage tab tracks spend per session and warns before a limit hits.',
  posthog: () => 'Hunting errors again? Radar watches PostHog error tracking and can investigate an issue for you.',
  benchmarks: () => 'Comparing agents by hand? Bench runs the same review cases across agent setups side by side.',
};

const OFF_SUFFIX = ' It is off right now, so Show me takes you to its switch in Settings.';

export function featureHintMessage(hint: Pick<FeatureHint, 'feature' | 'distinctTargetCount'>, isFeatureEnabled: boolean): string {
  const pitch = PITCH_BY_FEATURE[hint.feature](hint.distinctTargetCount);
  return isFeatureEnabled ? pitch : `${pitch}${OFF_SUFFIX}`;
}

export function featureSettingTarget(feature: HintFeature): { sectionId: string; settingId: string } | null {
  const surface = OPTIONAL_FEATURE_SURFACES.find((optionalSurface) => optionalSurface.rule === feature);
  return surface ? { sectionId: surface.sectionId, settingId: surface.settingId } : null;
}
