import type { FeatureHint, HintFeature } from '#shared/contracts/feature-hints.ts';
import { OPTIONAL_FEATURE_SURFACES } from './feature-surfaces-core.ts';

const PITCH_BY_FEATURE: Record<HintFeature, (distinctTargetCount: number) => string> = {
  teamReview: (count) => `${count} pull requests reviewed this week. Reviews lines up every PR waiting on you, and it is off right now.`,
  issues: (count) => `${count} issues touched this week. The Issues tab keeps them in one list and starts a session on any of them, and it is off right now.`,
  usage: () => 'Keeping an eye on tokens? Usage tracks spend per session and warns before a limit hits, and it is off right now.',
  posthog: () => 'Hunting errors again? Radar watches PostHog error tracking and can investigate an issue for you, and it is off right now.',
  benchmarks: () => 'Comparing agents by hand? Bench runs the same review cases across agent setups side by side, and it is off right now.',
};

export function featureHintMessage(hint: Pick<FeatureHint, 'feature' | 'distinctTargetCount'>): string {
  return `${PITCH_BY_FEATURE[hint.feature](hint.distinctTargetCount)} Show me takes you to its switch in Settings.`;
}

export function featureSettingTarget(feature: HintFeature): { sectionId: string; settingId: string } | null {
  const surface = OPTIONAL_FEATURE_SURFACES.find((optionalSurface) => optionalSurface.rule === feature);
  return surface ? { sectionId: surface.sectionId, settingId: surface.settingId } : null;
}
