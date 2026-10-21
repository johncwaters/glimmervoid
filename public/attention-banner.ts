import { STATE_ICONS } from '#shared/state-icons.ts';
import type { SessionState } from '#shared/states.ts';
import { STATES } from '#shared/states.ts';
import { el, query } from './dom-helpers.ts';
import type { AttentionCounts } from './focus-view/attention-core.ts';
import { attentionSummaryText, hasAnyAttention, jumpTargetCount } from './focus-view/attention-core.ts';
import { paintStatusIcon } from './status-icon.ts';

const NO_ATTENTION: AttentionCounts = { waitingCount: 0, finishedCount: 0, failedCount: 0 };

const ATTENTION_CHIP_KINDS = [
  { state: STATES.FAILED, countKey: 'failedCount' },
  { state: STATES.WAITING, countKey: 'waitingCount' },
  { state: STATES.COMPLETE, countKey: 'finishedCount' },
] as const;

const ALL_CLEAR_LINES = [
  'NI.',
  'THIS QUEUE IS DECEASED',
  'AND NOW, NOTHING AT ALL',
  'TOUCH GRASS, BRIEFLY',
  'GO STRETCH',
  'THE AGENTS ARE COPING',
  'MORALE IS ADEQUATE',
  'REQUIESCAT',
  'STANDARDS ARE BEING MET',
  'THE AGENTS WANT SPACE',
  'NO CAUSE FOR ALARM',
  'KINDLY GO AWAY',
  'THEY COPE WITHOUT YOU',
  'PRESS HARDER, PERHAPS',
  'OH, WELL DONE',
  'THAT DID NOTHING. AGAIN.',
  'WELL. YOU TRIED.',
  'SUBJECT PRESSED BUTTON',
  'THE BUTTON WORKS. YOU?',
  'WE HAVE NO PROBLEMS',
  'THE LAWYERS SAY RELAX',
  'BRING A TOWEL',
];

const ALL_CLEAR_LINE_HOLD_MS = 2500;
const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';
const PRESS_MS = 260;
const POP_MS = 280;
const CHIP_ENTER_MS = 200;
const CHIP_LEAVE_MS = 200;
const CHIP_SLIDE_MS = 260;
const KEYCAP_TRAVEL_PX = 3;

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

interface BannerMotion {
  previousCounts: AttentionCounts;
  lastAllClearLine: string | null;
  allClearLineTimer: number | null;
  pressAnimations: Animation[];
}

const motionByBanner = new WeakMap<HTMLElement, BannerMotion>();

function motionOf(banner: HTMLElement) {
  const existing = motionByBanner.get(banner);
  if (existing) return existing;
  const created: BannerMotion = { previousCounts: NO_ATTENTION, lastAllClearLine: null, allClearLineTimer: null, pressAnimations: [] };
  motionByBanner.set(banner, created);
  return created;
}

function canAnimate(element: HTMLElement) {
  return !document.hidden && typeof element.animate === 'function' && element.getClientRects().length > 0;
}

function prefersReducedMotion() {
  return reducedMotion?.matches ?? false;
}

function eased(frames: Keyframe[]) {
  return frames.map((frame) => ({ easing: EASE_OUT_EXPO, ...frame }));
}

function buildAttentionChip(state: SessionState) {
  const chip = el('span', 'attention-chip');
  chip.dataset.state = state;
  chip.setAttribute('aria-hidden', 'true');
  const icon = el('span', 'attention-chip-icon');
  paintStatusIcon(icon, STATE_ICONS[state]);
  chip.append(icon, el('span', 'attention-chip-count'));
  return chip;
}

export function buildAttentionBanner(jumpAffordance: HTMLElement) {
  const banner = el('div', 'attention-banner');
  banner.setAttribute('role', 'status');
  jumpAffordance.classList.add('attention-banner-jump');
  const chips = el('span', 'attention-banner-chips');
  chips.append(...ATTENTION_CHIP_KINDS.map((kind) => buildAttentionChip(kind.state)));
  const allClearLine = el('span', 'attention-banner-line');
  allClearLine.setAttribute('aria-hidden', 'true');
  const statusRow = el('div', 'attention-banner-status');
  statusRow.append(chips, el('span', 'attention-banner-count'), allClearLine);
  const jumpRow = el('div', 'attention-banner-jump-row');
  jumpRow.append(el('span', 'attention-banner-jump-caption', 'Next session'), jumpAffordance);
  banner.append(statusRow, jumpRow);
  paintAttentionBanner(banner, NO_ATTENTION);
  return banner;
}

export function paintAttentionBanner(banner: HTMLElement, counts: AttentionCounts) {
  const motion = motionOf(banner);
  const shouldAnimate = canAnimate(banner);
  query(banner, '.attention-banner-count').textContent = attentionSummaryText(counts);
  for (const kind of ATTENTION_CHIP_KINDS) {
    const chip = query(banner, `.attention-chip[data-state="${kind.state}"]`);
    const count = counts[kind.countKey];
    const previousCount = motion.previousCounts[kind.countKey];
    chip.title = attentionSummaryText({ ...NO_ATTENTION, [kind.countKey]: count });
    if (count === 0) {
      paintChipLeaving(banner, chip, previousCount > 0 && shouldAnimate);
      continue;
    }
    cancelChipLeave(chip);
    chip.hidden = false;
    query(chip, '.attention-chip-count').textContent = String(count);
    if (!shouldAnimate || count === previousCount) continue;
    if (previousCount === 0) {
      animateChipEnter(chip);
      continue;
    }
    animateChipPop(chip);
  }
  const isJumpable = jumpTargetCount(counts) > 0;
  banner.toggleAttribute('data-empty', !hasAnyAttention(counts));
  banner.toggleAttribute('data-jumpable', isJumpable);
  const jumpAffordance = query(banner, '.attention-banner-jump');
  if (jumpAffordance instanceof HTMLButtonElement) jumpAffordance.disabled = !isJumpable;
  if (hasAnyAttention(counts)) endAllClearLine(banner, motion);
  motion.previousCounts = counts;
}

function paintChipLeaving(banner: HTMLElement, chip: HTMLElement, shouldAnimate: boolean) {
  if (chip.hidden || chip.hasAttribute('data-leaving')) return;
  if (!shouldAnimate) {
    chip.hidden = true;
    return;
  }
  chip.toggleAttribute('data-leaving', true);
  const frames = prefersReducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : eased([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }]);
  const leave = chip.animate(frames, { duration: CHIP_LEAVE_MS, fill: 'forwards' });
  leave.onfinish = () => {
    if (!chip.hasAttribute('data-leaving')) return;
    slideFollowingChips(banner, () => {
      chip.toggleAttribute('data-leaving', false);
      chip.hidden = true;
      leave.cancel();
    });
  };
}

function cancelChipLeave(chip: HTMLElement) {
  if (!chip.hasAttribute('data-leaving')) return;
  chip.toggleAttribute('data-leaving', false);
  for (const animation of chip.getAnimations()) animation.cancel();
}

function slideFollowingChips(banner: HTMLElement, removeLeavingChip: () => void) {
  const stayingChips = [...banner.querySelectorAll<HTMLElement>('.attention-chip:not([hidden]):not([data-leaving])')];
  const leftBeforeByChip = new Map(stayingChips.map((chip) => [chip, chip.getBoundingClientRect().left]));
  removeLeavingChip();
  if (prefersReducedMotion() || !canAnimate(banner)) return;
  for (const chip of stayingChips) {
    const shiftPx = (leftBeforeByChip.get(chip) ?? 0) - chip.getBoundingClientRect().left;
    if (shiftPx === 0) continue;
    chip.animate(eased([{ transform: `translateX(${shiftPx}px)` }, { transform: 'none' }]), { duration: CHIP_SLIDE_MS });
  }
}

function animateChipEnter(chip: HTMLElement) {
  const frames = prefersReducedMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : eased([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }]);
  chip.animate(frames, { duration: CHIP_ENTER_MS });
}

function animateChipPop(chip: HTMLElement) {
  if (prefersReducedMotion()) {
    chip.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: POP_MS, easing: EASE_OUT_EXPO });
    return;
  }
  chip.animate(eased([{ transform: 'none' }, { transform: 'scale(1.14)', offset: 0.35 }, { transform: 'none' }]), { duration: POP_MS });
  query(chip, '.attention-chip-count').animate(eased([{ transform: 'translateY(-60%)', opacity: 0 }, { transform: 'none', opacity: 1 }]), { duration: POP_MS });
}

export function pressAttentionBanner(banner: HTMLElement) {
  const motion = motionOf(banner);
  if (banner.hasAttribute('data-empty')) showAllClearLine(banner, motion);
  for (const animation of motion.pressAnimations) animation.cancel();
  motion.pressAnimations = [];
  if (!canAnimate(banner)) return;
  const pressTiming = { duration: PRESS_MS };
  motion.pressAnimations.push(banner.animate(eased([{ opacity: 0 }, { opacity: 0.07, offset: 0.3 }, { opacity: 0 }]), { ...pressTiming, pseudoElement: '::after' }));
  if (prefersReducedMotion()) return;
  motion.pressAnimations.push(banner.animate(eased([{ transform: 'none' }, { transform: 'scale(0.97) translateY(1px)', offset: 0.3 }, { transform: 'none' }]), pressTiming));
  for (const keycap of banner.querySelectorAll<HTMLElement>('.attention-banner-jump .kbd')) {
    motion.pressAnimations.push(
      keycap.animate(eased([{ transform: 'none' }, { transform: `translateY(${KEYCAP_TRAVEL_PX}px)`, offset: 0.3 }, { transform: 'none' }]), pressTiming),
      keycap.animate(eased([{ transform: 'none' }, { transform: `translateY(-${KEYCAP_TRAVEL_PX}px)`, offset: 0.3 }, { transform: 'none' }]), { ...pressTiming, pseudoElement: '::after' }),
    );
  }
}

function pickAllClearLine(previousLine: string | null) {
  const candidates = ALL_CLEAR_LINES.filter((line) => line !== previousLine);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? ALL_CLEAR_LINES[0];
}

function showAllClearLine(banner: HTMLElement, motion: BannerMotion) {
  const line = pickAllClearLine(motion.lastAllClearLine);
  motion.lastAllClearLine = line;
  query(banner, '.attention-banner-line').textContent = line;
  banner.toggleAttribute('data-all-clear-line', true);
  if (motion.allClearLineTimer !== null) window.clearTimeout(motion.allClearLineTimer);
  motion.allClearLineTimer = window.setTimeout(() => endAllClearLine(banner, motion), ALL_CLEAR_LINE_HOLD_MS);
}

function endAllClearLine(banner: HTMLElement, motion: BannerMotion) {
  if (motion.allClearLineTimer !== null) window.clearTimeout(motion.allClearLineTimer);
  motion.allClearLineTimer = null;
  banner.toggleAttribute('data-all-clear-line', false);
}
