import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX, type BrandMarkSide } from '#shared/brand-mark.ts';
import { el } from '../dom-helpers.ts';
import { createSvgShape } from '../svg-dom.ts';
import { type ActivityBeat, THINKING_BEAT, verbChoicesFor } from './chat-activity-core.ts';

interface ChatActivity {
  element: HTMLElement;
  setRunning(isRunning: boolean): void;
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
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function prefersReducedMotion(): boolean {
  return reducedMotionQuery?.matches ?? false;
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
  element.hidden = true;
  element.setAttribute('role', 'status');
  const mark = createSvgShape('svg', { class: 'chat-activity-mark', viewBox: BRAND_MARK_VIEWBOX, 'aria-hidden': 'true' });
  const bracketBySide = new Map<BrandMarkSide, SVGElement>();
  for (const { side, d } of BRAND_MARK_BRACKETS) {
    const bracket = createSvgShape('path', { class: 'chat-activity-bracket', d });
    bracketBySide.set(side, bracket);
    mark.append(bracket);
  }
  const light = createSvgShape('path', { class: 'chat-activity-light', d: BRAND_MARK_LIGHT });
  mark.append(light);
  const verb = el('span', 'chat-activity-verb');
  element.append(mark, verb);
  let shownBeatKey = '';
  let typingTimer: ReturnType<typeof setInterval> | undefined;

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

  const show = (beat: ActivityBeat) => {
    element.dataset.workKind = beat.glimmervoidTool === null ? beat.workKind : 'glimmervoid';
    const key = beatKey(beat);
    if (key !== shownBeatKey) {
      shownBeatKey = key;
      showVerb(pickedVerb(beat));
    }
    if (prefersReducedMotion()) return;
    if (beat.glimmervoidTool !== null) {
      playDialSpin();
      return;
    }
    playBeat();
  };

  return {
    element,
    setRunning: (isRunning) => {
      if (element.hidden !== isRunning) return;
      element.hidden = !isRunning;
      if (!isRunning) {
        clearInterval(typingTimer);
        shownBeatKey = '';
        return;
      }
      show(THINKING_BEAT);
    },
    beat: (beats) => {
      const shownBeat = beats.findLast((beat) => beat.glimmervoidTool !== null) ?? beats.at(-1);
      if (element.hidden || shownBeat === undefined) return;
      show(shownBeat);
    },
  };
}
