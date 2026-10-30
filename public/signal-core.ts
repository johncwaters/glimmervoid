import type { PrStatusIcon } from './github/pr-status-icon-core.ts';
import type { StateTone } from './state-tone-core.ts';

const VISIBLE_SIGNALS = 2;

export const SIGNAL_TIER = { needsYou: 1, broken: 2, askedOfYou: 3, waiting: 4, settled: 5 } as const;
type SignalTier = typeof SIGNAL_TIER[keyof typeof SIGNAL_TIER];

const TIER_BY_TONE: Readonly<Record<StateTone, SignalTier>> = {
  danger: SIGNAL_TIER.broken, warn: SIGNAL_TIER.askedOfYou, wait: SIGNAL_TIER.waiting, ok: SIGNAL_TIER.settled, muted: SIGNAL_TIER.settled,
};

interface SignalLook { icon: PrStatusIcon; tone: StateTone }

export interface Signal {
  key: string;
  text: string;
  hoverText: string;
  detailText?: string;
  stateText?: string;
  look: SignalLook | null;
  tier: SignalTier;
}

export interface RankedSignals<Ranked extends Signal> {
  visible: Ranked[];
  overflowCount: number;
  overflowHoverText: string;
}

export function tierForTone(tone: StateTone | undefined): SignalTier {
  return tone ? TIER_BY_TONE[tone] : SIGNAL_TIER.settled;
}

export function rankSignals<Ranked extends Signal>(signals: readonly Ranked[], visibleCount = VISIBLE_SIGNALS): RankedSignals<Ranked> {
  const ranked = [...signals].sort((left, right) => left.tier - right.tier);
  const hidden = ranked.slice(visibleCount);
  return {
    visible: ranked.slice(0, visibleCount),
    overflowCount: hidden.length,
    overflowHoverText: hidden.map((signal) => `${signal.text} ${signal.hoverText}`).join('\n'),
  };
}

export function signalsSignature(signals: readonly Signal[]): string {
  return signals.map((signal) => [signal.key, signal.text, signal.hoverText, signal.look?.icon, signal.look?.tone, signal.tier, signal.detailText, signal.stateText].join('|')).join('\n');
}
