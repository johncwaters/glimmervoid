import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX, type BrandMarkSide } from '#shared/brand-mark.ts';
import { BADGE_LABELS, STATES, type SessionState } from '#shared/states.ts';
import { STATUS_LEGEND } from '../status-legend-core.ts';
import { el } from '../dom-helpers.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { formatTokens } from '../usage/usage-store-core.ts';
import { clock } from '#shared/clock.ts';
import { createSvgShape } from '../svg-dom.ts';
import { type ActivityBeat, BUSY_BEAT, type ChatPhase, MONITORING_VERB, plainVerbFor, verbChoicesFor } from './chat-activity-core.ts';

interface ChatActivity {
  element: HTMLElement;
  setPhase(phase: ChatPhase): void;
  beat(beats: readonly ActivityBeat[]): void;
  narrate(reply: string | null, callLabel: string | null): void;
  showStats(openedAt: number | null, outputTokens: number | null): void;
  stopStats(): void;
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
const BEAT_SPIN_DEGREES = 90;
const TYPE_STEP_MS = 28;
const DETAIL_PAUSE_MS = 120;
const READY_LABEL = 'Ready';
const STARTING_LABEL = BADGE_LABELS[STATES.STARTING];
const STARTING_MEANING = legendMeaningOf(STATES.STARTING);
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

function prefersReducedMotion(): boolean {
  return reducedMotionQuery?.matches ?? false;
}

function legendMeaningOf(state: SessionState): string {
  return STATUS_LEGEND.find((entry) => entry.state === state && !entry.awaitingBackgroundTasks)?.meaning ?? '';
}

type ActivityVerbs = 'varied' | 'plain';

function randomVerbFor(beat: ActivityBeat): string {
  const choices = verbChoicesFor(beat);
  return choices[Math.floor(Math.random() * choices.length)] ?? '';
}

const VERB_PICKER_BY_STYLE: Record<ActivityVerbs, (beat: ActivityBeat) => string> = {
  varied: randomVerbFor,
  plain: plainVerbFor,
};

function beatKey(beat: ActivityBeat): string {
  if (beat.glimmervoidTool !== null) return `glimmervoid:${beat.glimmervoidTool}`;
  return beat.workKind === 'working' ? `working:${beat.toolName}` : beat.workKind;
}

const STATS_TICK_MS = 1000;
const MS_PER_SECOND = 1000;

function liveStatsText(elapsedMs: number, outputTokens: number | null): string {
  const elapsedText = twoUnitDurationText(Math.max(0, Math.floor(elapsedMs / MS_PER_SECOND)), { smallestUnit: 's', dropsZeroRemainder: false });
  return outputTokens === null || outputTokens === 0 ? elapsedText : `${elapsedText}, ${formatTokens(outputTokens)} tokens`;
}

export function createChatActivity(verbs: ActivityVerbs = 'varied'): ChatActivity {
  const pickedVerb = VERB_PICKER_BY_STYLE[verbs];
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
  const stats = el('span', 'chat-activity-stats');
  element.append(mark, verb, detail, stats);
  let statsOpenedAt: number | null = null;
  let statsTokens: number | null = null;
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  const stopStats = () => {
    statsOpenedAt = null;
    statsTokens = null;
    stats.textContent = '';
    clearInterval(statsTimer);
    statsTimer = undefined;
  };
  const paintStats = () => {
    if (statsOpenedAt === null || shownPhase !== 'working') {
      stopStats();
      return;
    }
    stats.textContent = liveStatsText(clock.nowMs() - statsOpenedAt, statsTokens);
    statsTimer ??= setInterval(paintStats, STATS_TICK_MS);
  };
  let shownBeatKey = '';
  let shownPhase: ChatPhase = 'quiet';
  let shownReply: string | null = null;
  let shownDetail = '';
  let isDetailWaitingOnVerb = false;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTyping = () => {
    isDetailWaitingOnVerb = false;
    clearInterval(typingTimer);
    clearTimeout(detailTimer);
    element.toggleAttribute('data-typing', false);
  };

  const typeInto = (target: HTMLElement, phrase: string, onTyped: () => void) => {
    let shownCount = 0;
    target.textContent = '';
    element.toggleAttribute('data-typing', true);
    typingTimer = setInterval(() => {
      shownCount += 1;
      target.textContent = phrase.slice(0, shownCount);
      if (shownCount < phrase.length) return;
      clearInterval(typingTimer);
      onTyped();
    }, TYPE_STEP_MS);
  };

  const typeDetail = () => {
    stopTyping();
    if (prefersReducedMotion() || shownDetail === '') {
      detail.textContent = shownDetail;
      return;
    }
    typeInto(detail, shownDetail, stopTyping);
  };

  const showVerb = (phrase: string) => {
    stopTyping();
    element.setAttribute('aria-label', phrase);
    detail.textContent = '';
    if (prefersReducedMotion()) {
      verb.textContent = phrase;
      detail.textContent = shownDetail;
      return;
    }
    isDetailWaitingOnVerb = true;
    typeInto(verb, phrase, () => {
      detailTimer = setTimeout(typeDetail, DETAIL_PAUSE_MS);
    });
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
    mark.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${BEAT_SPIN_DEGREES}deg)` }], { duration: CLAMP_MS, easing: SETTLE_EASING });
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
      { transform: 'scale(1)' },
      { transform: 'scale(1)', offset: 0.72 },
      { transform: 'scale(1.8)', offset: 0.84 },
      { transform: 'scale(1)' },
    ], { duration: DIAL_SPIN_MS });
  };

  const show = (beat: ActivityBeat) => {
    const key = beatKey(beat);
    if (key !== shownBeatKey && shownReply === null) {
      shownBeatKey = key;
      showVerb(pickedVerb(beat));
    }
    if (prefersReducedMotion()) return;
    playBeat();
  };

  const showStarting = () => {
    element.toggleAttribute('data-idle', false);
    shownBeatKey = '';
    stopTyping();
    detail.textContent = STARTING_MEANING;
    verb.textContent = STARTING_LABEL;
    element.setAttribute('aria-label', `${STARTING_LABEL}. ${STARTING_MEANING}`);
  };

  const showWorking = (wasStarting: boolean) => {
    element.toggleAttribute('data-idle', false);
    if (!wasStarting) {
      show(BUSY_BEAT);
      return;
    }
    shownBeatKey = beatKey(BUSY_BEAT);
    showVerb(pickedVerb(BUSY_BEAT));
    if (!prefersReducedMotion()) playDialSpin();
  };

  const showMonitoring = () => {
    element.toggleAttribute('data-idle', false);
    shownBeatKey = '';
    showVerb(MONITORING_VERB);
  };

  const showQuiet = (hasJustBecomeReady: boolean) => {
    stopTyping();
    shownBeatKey = '';
    if (!hasJustBecomeReady || prefersReducedMotion()) {
      element.toggleAttribute('data-idle', true);
      return;
    }
    showVerb(READY_LABEL);
    playDialSpin();
    readyTimer = setTimeout(() => element.toggleAttribute('data-idle', true), DIAL_SPIN_MS);
  };

  return {
    element,
    setPhase: (phase) => {
      if (phase === shownPhase) return;
      const wasStarting = shownPhase === 'starting';
      const wasBusy = wasStarting || shownPhase === 'working' || shownPhase === 'monitoring';
      shownPhase = phase;
      paintStats();
      clearTimeout(readyTimer);
      shownReply = null;
      element.dataset.phase = phase;
      shownDetail = '';
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
      if (phase === 'monitoring') {
        showMonitoring();
        return;
      }
      showQuiet(wasBusy && phase === 'quiet');
    },
    showStats: (openedAt, outputTokens) => {
      statsOpenedAt = openedAt;
      statsTokens = outputTokens;
      paintStats();
    },
    stopStats,
    beat: (beats) => {
      const shownBeat = beats.at(-1);
      if (shownPhase !== 'working' || shownBeat === undefined) return;
      show(shownBeat);
    },
    narrate: (reply, callLabel) => {
      if (shownPhase !== 'working') return;
      const nextDetail = callLabel ?? '';
      if (reply === shownReply) {
        if (nextDetail === shownDetail) return;
        shownDetail = nextDetail;
        if (isDetailWaitingOnVerb) return;
        typeDetail();
        return;
      }
      shownDetail = nextDetail;
      shownReply = reply;
      shownBeatKey = '';
      if (reply === null) {
        showVerb(pickedVerb(BUSY_BEAT));
        return;
      }
      showVerb(reply);
    },
  };
}
