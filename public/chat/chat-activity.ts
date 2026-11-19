import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX, type BrandMarkSide } from '#shared/brand-mark.ts';
import { BADGE_LABELS, STATES, type SessionState } from '#shared/states.ts';
import { STATUS_LEGEND } from '../status-legend-core.ts';
import { el } from '../dom-helpers.ts';
import { createSvgShape } from '../svg-dom.ts';
import { type ActivityBeat, BUSY_BEAT, type ChatPhase, verbChoicesFor } from './chat-activity-core.ts';

interface ChatActivity {
  element: HTMLElement;
  setPhase(phase: ChatPhase): void;
  beat(beats: readonly ActivityBeat[]): void;
}

const INWARD_BY_SIDE: Record<BrandMarkSide, { dx: number; dy: number }> = {
  top: { dx: 0, dy: 1 },
  right: { dx: -1, dy: 0 },
  bottom: { dx: 0, dy: -1 },
  left: { dx: 1, dy: 0 },
};
const SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const CLAMP_PX = 7;
const DIAL_CLAMP_PX = 8;
const CLAMP_MS = 480;
const LIGHT_THUMP_MS = 420;
const DIAL_SPIN_MS = 1100;
const TYPE_STEP_MS = 28;
const STARTING_LABEL = BADGE_LABELS[STATES.STARTING];
const STARTING_MEANING = legendMeaningOf(STATES.STARTING);
const READY_MEANING = legendMeaningOf(STATES.IDLE);
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function prefersReducedMotion(): boolean {
  return reducedMotionQuery?.matches ?? false;
}

function legendMeaningOf(state: SessionState): string {
  return STATUS_LEGEND.find((entry) => entry.state === state && !entry.awaitingBackgroundTasks)?.meaning ?? '';
}

function pickedVerb(beat: ActivityBeat): string {
  const choices = verbChoicesFor(beat);
  return choices[Math.floor(Math.random() * choices.length)] ?? '';
}

function beatKey(beat: ActivityBeat): string {
  if (beat.glimmervoidTool !== null) return `glimmervoid:${beat.glimmervoidTool}`;
  return beat.workKind === 'working' ? `working:${beat.toolName}` : beat.workKind;
}

export function createChatActivity(): ChatActivity {
  const element = el('div', 'chat-activity');
  element.toggleAttribute('data-idle', true);
  element.setAttribute('role', 'status');
  const mark = createSvgShape('svg', { class: 'chat-activity-mark', viewBox: BRAND_MARK_VIEWBOX, 'aria-hidden': 'true' });
  const bracketBySide = new Map<BrandMarkSide, SVGElement>();
  for (const { side, d } of BRAND_MARK_BRACKETS) {
    const bracket = createSvgShape('path', { class: 'chat-activity-bracket', d, 'data-side': side });
    bracketBySide.set(side, bracket);
    mark.append(bracket);
  }
  const light = createSvgShape('path', { class: 'chat-activity-light', d: BRAND_MARK_LIGHT });
  mark.append(light);
  const verb = el('span', 'chat-activity-verb');
  const detail = el('span', 'chat-activity-detail');
  element.append(mark, verb, detail);
  let shownBeatKey = '';
  let shownPhase: ChatPhase = 'quiet';
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;

  const showVerb = (phrase: string) => {
    clearInterval(typingTimer);
    element.setAttribute('aria-label', phrase);
    if (prefersReducedMotion()) {
      verb.textContent = phrase;
      return;
    }
    let shownCount = 0;
    verb.textContent = '';
    typingTimer = setInterval(() => {
      shownCount += 1;
      verb.textContent = phrase.slice(0, shownCount);
      if (shownCount >= phrase.length) clearInterval(typingTimer);
    }, TYPE_STEP_MS);
  };

  const clampBrackets = (clampPx: number, keyframeOffset: number, durationMs: number, holdUntil: number | null) => {
    for (const [side, bracket] of bracketBySide) {
      const { dx, dy } = INWARD_BY_SIDE[side];
      const clamped = { transform: `translate(${dx * clampPx}px, ${dy * clampPx}px)`, offset: keyframeOffset };
      const hold = holdUntil === null ? [] : [{ transform: 'none', offset: holdUntil }];
      bracket.animate([{ transform: 'none' }, ...hold, clamped, { transform: 'none' }], { duration: durationMs, easing: SETTLE_EASING });
    }
  };

  const playBeat = () => {
    clampBrackets(CLAMP_PX, 0.3, CLAMP_MS, null);
    light.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.45)', offset: 0.3 }, { transform: 'scale(1)' }], { duration: LIGHT_THUMP_MS, easing: SETTLE_EASING });
  };

  const playDialSpin = () => {
    mark.animate([
      { transform: 'rotate(0deg)', easing: 'cubic-bezier(0.6, 0, 1, 1)' },
      { transform: 'rotate(250deg)', offset: 0.36, easing: 'linear' },
      { transform: 'rotate(610deg)', offset: 0.64, easing: 'cubic-bezier(0, 0, 0.4, 1)' },
      { transform: 'rotate(720deg)' },
    ], { duration: DIAL_SPIN_MS });
    clampBrackets(DIAL_CLAMP_PX, 0.82, DIAL_SPIN_MS, 0.7);
    light.animate([
      { transform: 'scale(1)', filter: 'none' },
      { transform: 'scale(1)', offset: 0.72 },
      { transform: 'scale(1.8)', filter: 'drop-shadow(0 0 6px var(--accent))', offset: 0.84 },
      { transform: 'scale(1)', filter: 'none' },
    ], { duration: DIAL_SPIN_MS });
  };

  const show = (beat: ActivityBeat, hasGlimmervoidCall: boolean) => {
    element.dataset.workKind = beat.glimmervoidTool === null ? beat.workKind : 'glimmervoid';
    const key = beatKey(beat);
    if (key !== shownBeatKey) {
      shownBeatKey = key;
      showVerb(pickedVerb(beat));
    }
    if (prefersReducedMotion()) return;
    if (hasGlimmervoidCall) {
      playDialSpin();
      return;
    }
    playBeat();
  };

  const showStarting = () => {
    element.toggleAttribute('data-idle', false);
    delete element.dataset.workKind;
    shownBeatKey = '';
    clearInterval(typingTimer);
    detail.textContent = STARTING_MEANING;
    verb.textContent = STARTING_LABEL;
    element.setAttribute('aria-label', `${STARTING_LABEL}. ${STARTING_MEANING}`);
  };

  const showWorking = (wasStarting: boolean) => {
    element.toggleAttribute('data-idle', false);
    if (!wasStarting) {
      show(BUSY_BEAT, false);
      return;
    }
    element.dataset.workKind = BUSY_BEAT.workKind;
    shownBeatKey = beatKey(BUSY_BEAT);
    showVerb(pickedVerb(BUSY_BEAT));
    if (!prefersReducedMotion()) playDialSpin();
  };

  const showQuiet = (hasJustBecomeReady: boolean) => {
    clearInterval(typingTimer);
    shownBeatKey = '';
    if (!hasJustBecomeReady || prefersReducedMotion()) {
      element.toggleAttribute('data-idle', true);
      return;
    }
    delete element.dataset.workKind;
    showVerb(READY_MEANING);
    playDialSpin();
    readyTimer = setTimeout(() => element.toggleAttribute('data-idle', true), DIAL_SPIN_MS);
  };

  return {
    element,
    setPhase: (phase) => {
      if (phase === shownPhase) return;
      const wasStarting = shownPhase === 'starting';
      shownPhase = phase;
      clearTimeout(readyTimer);
      element.dataset.phase = phase;
      detail.textContent = '';
      element.removeAttribute('aria-label');
      if (phase === 'starting') {
        showStarting();
        return;
      }
      if (phase === 'working') {
        showWorking(wasStarting);
        return;
      }
      showQuiet(wasStarting && phase === 'quiet');
    },
    beat: (beats) => {
      const shownBeat = beats.at(-1);
      if (shownPhase !== 'working' || shownBeat === undefined) return;
      show(shownBeat, beats.some((beat) => beat.glimmervoidTool !== null));
    },
  };
}
