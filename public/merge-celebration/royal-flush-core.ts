export const ROYAL_FLUSH_RANKS = ['10', 'J', 'Q', 'K', 'A'];
export const FLIP_DURATION_MS = 160;
const CARD_SPACING_PX = 19;
const CARD_TILT_STEP_DEGREES = 5;
const CARD_RESTING_BOTTOM_PX = 9;
const DEAL_LEAD_BEFORE_IMPACT_MS = 780;
const DEAL_STAGGER_MS = 70;
const FLIP_STAGGER_MS = 70;
const IMPACT_WAVE_STAGGER_MS = 35;

export function royalFlushCardLayout(cardIndex: number) {
  const lastCardIndex = ROYAL_FLUSH_RANKS.length - 1;
  const stepsFromCenter = cardIndex - lastCardIndex / 2;
  return {
    offsetPx: stepsFromCenter * CARD_SPACING_PX,
    titleSpreadFraction: stepsFromCenter / lastCardIndex,
    tiltDegrees: stepsFromCenter * CARD_TILT_STEP_DEGREES,
    bottomPx: CARD_RESTING_BOTTOM_PX - stepsFromCenter ** 2,
    dealLeadMs: DEAL_LEAD_BEFORE_IMPACT_MS - cardIndex * DEAL_STAGGER_MS,
    flipLeadMs: FLIP_DURATION_MS + (lastCardIndex - cardIndex) * FLIP_STAGGER_MS,
    waveDelayMs: cardIndex * IMPACT_WAVE_STAGGER_MS,
  };
}

type RoyalFlushCardLayout = ReturnType<typeof royalFlushCardLayout>;

export function royalFlushCardStyleProperties(layout: RoyalFlushCardLayout): Array<readonly [string, string]> {
  return [
    ['--card-offset', `${layout.offsetPx}px`],
    ['--card-title-spread', String(layout.titleSpreadFraction)],
    ['--card-tilt', `${layout.tiltDegrees}deg`],
    ['--card-bottom', `${layout.bottomPx}px`],
    ['--card-deal-lead-ms', `${layout.dealLeadMs}ms`],
    ['--card-flip-lead-ms', `${layout.flipLeadMs}ms`],
    ['--card-wave-delay-ms', `${layout.waveDelayMs}ms`],
  ];
}

export function royalFlushTableStyleProperties(): Array<readonly [string, string]> {
  return [['--card-flip-ms', `${FLIP_DURATION_MS}ms`]];
}
