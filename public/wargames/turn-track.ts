import { clock } from '#shared/clock.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon, createSvgIcon, createSvgShape, TROPHY_ICON_PATH } from '../svg-dom.ts';
import { button, outlineIconButton } from '../ui/button.ts';
import type { OutlineIconButton } from '../ui/button.ts';
import { segmented } from '../ui/segmented.ts';
import type { Segmented } from '../ui/segmented.ts';
import { tag } from '../ui/tag.ts';
import { REPLAY_SPEEDS } from './replay-core.ts';
import type { ReplaySpeed } from './replay-core.ts';
import { ACTING_PHASE_GLYPHS, REPLAY_GLYPH_PATHS, WARGAMES_GLYPH_PATHS } from './wargames-glyphs.ts';
import { deriveTurnTrack, TRACK_PHASES } from './turn-track-core.ts';
import type { PhaseDeadline, TrackPhase, TurnTrackInput, TurnTrackView } from './turn-track-core.ts';
import { SEAT_COLORS } from './wargames-map.ts';
import './turn-track.css';

const CLOCK_TICK_MS = 1000;
const RING_SIZE = 32;
const RING_RADIUS = 14;

const PHASE_BUTTON_NAMES: Readonly<Record<TrackPhase, string>> = Object.freeze({
  talk: 'Talk phase',
  contracts: 'Negotiate phase',
  orders: 'Orders phase',
  resolving: 'Resolved turn',
});

interface TurnTrackReplayActions {
  seekTurn(tick: number): void;
  seekPhase(phase: TrackPhase): void;
  stepTurn(direction: -1 | 1): void;
  togglePlay(): void;
  setSpeed(speed: ReplaySpeed): void;
  jumpToEnd(): void;
}

interface ReplayParts {
  group: HTMLElement;
  scrubber: HTMLInputElement;
  phaseButtons: ReadonlyMap<TrackPhase, OutlineIconButton<'pressed'>>;
  stepBack: HTMLButtonElement;
  play: OutlineIconButton<'pressed'>;
  stepForward: HTMLButtonElement;
  jumpToEnd: HTMLButtonElement;
  speed: Segmented<`${ReplaySpeed}`>;
  replayTag: HTMLElement;
  endTag: HTMLElement;
}

interface TurnTrackParts {
  summary: HTMLElement;
  pipStrip: HTMLElement;
  turnCount: HTMLElement;
  phaseGlyphs: ReadonlyMap<TrackPhase, SVGSVGElement>;
  ringSlot: HTMLElement;
  ringArc: SVGElement;
  ringText: HTMLElement;
  endGlyphSlot: HTMLElement;
  seatStrip: HTMLElement;
}

export interface TurnTrack {
  readonly element: HTMLElement;
  update(input: TurnTrackInput, deadline: PhaseDeadline | null): void;
}

function buildRing(): { ring: SVGSVGElement; arc: SVGElement } {
  const ring = createSvgIcon(RING_SIZE, RING_SIZE);
  ring.classList.add('wg-track-ring');
  const center = String(RING_SIZE / 2);
  const circleAttributes = { cx: center, cy: center, r: String(RING_RADIUS), fill: 'none', pathLength: '100' };
  const track = createSvgShape('circle', { ...circleAttributes, class: 'wg-track-ring-track' });
  const arc = createSvgShape('circle', { ...circleAttributes, class: 'wg-track-ring-arc', 'stroke-dasharray': '100' });
  ring.append(track, arc);
  return { ring, arc };
}

function replayIcon(pathData: string): SVGSVGElement {
  return createLineIcon(pathData, '1.5');
}

function buildReplayParts(actions: TurnTrackReplayActions): ReplayParts {
  const group = el('span', 'wg-track-replay');
  const scrubber = el('input', 'wg-track-scrubber') as HTMLInputElement;
  scrubber.type = 'range';
  scrubber.min = '1';
  scrubber.step = '1';
  scrubber.setAttribute('aria-label', 'Turn');
  scrubber.addEventListener('input', () => {
    const headTick = Number(scrubber.dataset.headTick ?? scrubber.max);
    const tick = Math.min(Number(scrubber.value), headTick);
    if (String(tick) !== scrubber.value) scrubber.value = String(tick);
    actions.seekTurn(tick);
  });
  const phaseStrip = el('span', 'wg-track-phase-buttons');
  const phaseButtons = new Map<TrackPhase, OutlineIconButton<'pressed'>>();
  for (const phase of TRACK_PHASES) {
    const phaseButton = outlineIconButton({
      label: PHASE_BUTTON_NAMES[phase],
      icon: replayIcon(ACTING_PHASE_GLYPHS[phase]),
      size: 'small',
      states: ['idle', 'pressed'],
      onClick: () => actions.seekPhase(phase),
    });
    phaseButtons.set(phase, phaseButton);
    phaseStrip.append(phaseButton.element);
  }
  const stepBack = button({ variant: 'icon', size: 'small', label: 'Step back', icon: replayIcon(REPLAY_GLYPH_PATHS.stepBack), onClick: () => actions.stepTurn(-1) });
  const play = outlineIconButton({ label: 'Play', icon: replayIcon(REPLAY_GLYPH_PATHS.play), size: 'small', states: ['idle', 'pressed'], onClick: () => actions.togglePlay() });
  const stepForward = button({ variant: 'icon', size: 'small', label: 'Step forward', icon: replayIcon(REPLAY_GLYPH_PATHS.stepForward), onClick: () => actions.stepTurn(1) });
  const jumpToEnd = button({ variant: 'icon', size: 'small', label: 'Jump to end', icon: replayIcon(REPLAY_GLYPH_PATHS.end), onClick: () => actions.jumpToEnd() });
  const speed = segmented<`${ReplaySpeed}`>({
    label: 'Speed',
    size: 'small',
    options: REPLAY_SPEEDS.map((value) => ({ value: `${value}` as const, label: `${value}x` })),
    value: '1',
    onChange: (value) => actions.setSpeed(Number(value) as ReplaySpeed),
  });
  const replayTag = tag({ text: 'Replay', tone: 'muted' });
  const endTag = tag({ text: 'End', tone: 'neutral' });
  group.append(phaseStrip, stepBack, play.element, stepForward, jumpToEnd, speed.element, replayTag, endTag);
  return { group, scrubber, phaseButtons, stepBack, play, stepForward, jumpToEnd, speed, replayTag, endTag };
}

function syncReplay(parts: ReplayParts, view: TurnTrackView, maxTicks: number, tick: number): void {
  const replay = view.replay;
  parts.group.hidden = replay === null;
  parts.scrubber.hidden = replay === null;
  if (replay === null) return;
  parts.scrubber.max = String(maxTicks);
  parts.scrubber.dataset.headTick = String(replay.headTick);
  parts.scrubber.value = String(Math.max(1, tick));
  parts.scrubber.setAttribute('aria-valuetext', `Turn ${tick} of ${replay.headTick}`);
  for (const [phase, phaseButton] of parts.phaseButtons) {
    phaseButton.setState(phase === view.activePhase ? 'pressed' : 'idle');
  }
  parts.play.setState(replay.isPlaying ? 'pressed' : 'idle');
  parts.stepBack.disabled = tick <= 1 && view.activePhase === 'talk';
  parts.stepForward.disabled = replay.isAtHead;
  parts.jumpToEnd.disabled = replay.isAtHead;
  parts.speed.setValue(`${replay.speed}`);
  parts.replayTag.hidden = replay.isAtHead;
  parts.endTag.hidden = !(replay.isAtHead && (view.mode === 'finished' || view.mode === 'aborted'));
}

function buildParts(element: HTMLElement, replayParts: ReplayParts | null): TurnTrackParts {
  const summary = el('span', 'sr-only');
  const visual = el('span', 'wg-track-visual');
  visual.setAttribute('aria-hidden', 'true');
  const pipStrip = el('span', 'wg-track-pips');
  const turnCount = el('span', 'wg-track-turn');
  const phaseStrip = el('span', 'wg-track-phases');
  const phaseGlyphs = new Map<TrackPhase, SVGSVGElement>();
  for (const phase of TRACK_PHASES) {
    const glyph = createLineIcon(ACTING_PHASE_GLYPHS[phase], '1.5');
    glyph.classList.add('wg-track-phase');
    phaseGlyphs.set(phase, glyph);
    phaseStrip.append(glyph);
  }
  const ringSlot = el('span', 'wg-track-clock');
  const { ring, arc } = buildRing();
  const ringText = el('span', 'wg-track-clock-text');
  const endGlyphSlot = el('span', 'wg-track-end');
  ringSlot.append(ring, ringText, endGlyphSlot);
  const seatStrip = el('span', 'wg-track-seats');
  const scrub = el('span', 'wg-track-scrub');
  scrub.append(visual);
  if (replayParts) scrub.append(replayParts.scrubber);
  visual.append(pipStrip, turnCount, phaseStrip, ringSlot, seatStrip);
  element.append(summary, scrub);
  if (replayParts) element.append(replayParts.group);
  return { summary, pipStrip, turnCount, phaseGlyphs, ringSlot, ringArc: arc, ringText, endGlyphSlot, seatStrip };
}

function syncPips(pipStrip: HTMLElement, view: TurnTrackView): void {
  while (pipStrip.children.length > view.pips.length) pipStrip.lastElementChild?.remove();
  while (pipStrip.children.length < view.pips.length) pipStrip.append(el('span', 'wg-track-pip'));
  view.pips.forEach((pipState, turnIndex) => {
    const pip = pipStrip.children[turnIndex];
    if (pip instanceof HTMLElement && pip.dataset.state !== pipState) pip.dataset.state = pipState;
  });
}

function syncSeatDots(seatStrip: HTMLElement, view: TurnTrackView): void {
  const shownSeatIds = Array.from(seatStrip.children, (dot) => (dot instanceof HTMLElement ? dot.dataset.seat : undefined));
  const matchSeatIds = view.seatDots.map((dot) => dot.seatId);
  if (shownSeatIds.join() !== matchSeatIds.join()) {
    seatStrip.replaceChildren(...view.seatDots.map(({ seatId }) => {
      const dot = el('span', 'wg-track-seat');
      dot.dataset.seat = seatId;
      dot.style.setProperty('--seat-color', SEAT_COLORS[seatId]);
      return dot;
    }));
  }
  view.seatDots.forEach(({ state }, seatIndex) => {
    const dot = seatStrip.children[seatIndex];
    if (dot instanceof HTMLElement) dot.dataset.state = state;
  });
}

function endGlyphOf(view: TurnTrackView): SVGSVGElement | null {
  if (view.mode === 'finished') {
    const trophy = createLineIcon(TROPHY_ICON_PATH, '1.5');
    if (view.winnerSeatId) trophy.style.color = SEAT_COLORS[view.winnerSeatId];
    return trophy;
  }
  if (view.mode === 'aborted') return createLineIcon(WARGAMES_GLYPH_PATHS.offline, '1.5');
  return null;
}

function syncClock(parts: TurnTrackParts, view: TurnTrackView): void {
  const endGlyph = endGlyphOf(view);
  const ringState = endGlyph ? 'ended' : view.clock ? view.clock.tone : 'idle';
  parts.ringSlot.dataset.state = ringState;
  if (endGlyph) {
    parts.endGlyphSlot.replaceChildren(endGlyph);
    parts.ringText.textContent = '';
    return;
  }
  parts.endGlyphSlot.replaceChildren();
  const remainingFraction = view.clock ? view.clock.remainingFraction : 0;
  parts.ringArc.setAttribute('stroke-dashoffset', String(100 * (1 - remainingFraction)));
  parts.ringText.textContent = view.clock ? String(view.clock.secondsLeft) : '';
}

function render(element: HTMLElement, parts: TurnTrackParts, view: TurnTrackView, input: TurnTrackInput, replayParts: ReplayParts | null): void {
  element.dataset.mode = view.mode;
  parts.summary.textContent = view.spokenSummary;
  syncPips(parts.pipStrip, view);
  parts.turnCount.textContent = view.turnText;
  for (const [phase, glyph] of parts.phaseGlyphs) {
    glyph.dataset.state = phase === view.activePhase ? 'active' : 'idle';
  }
  syncClock(parts, view);
  syncSeatDots(parts.seatStrip, view);
  element.dataset.replay = view.replay === null ? 'off' : 'on';
  if (replayParts) syncReplay(replayParts, view, input.maxTicks, input.tick);
}

export function createTurnTrack(replayActions: TurnTrackReplayActions | null = null): TurnTrack {
  const element = el('div', 'wg-track');
  const replayParts = replayActions ? buildReplayParts(replayActions) : null;
  const parts = buildParts(element, replayParts);
  let latestInput: TurnTrackInput | null = null;
  let latestDeadline: PhaseDeadline | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;

  function stopClock(): void {
    if (clockTimer === null) return;
    clearInterval(clockTimer);
    clockTimer = null;
  }

  function redraw(): TurnTrackView | null {
    if (latestInput === null) return null;
    const view = deriveTurnTrack(latestInput, latestDeadline, clock.nowMs());
    render(element, parts, view, latestInput, replayParts);
    return view;
  }

  function onClockTick(): void {
    if (!element.isConnected) {
      stopClock();
      return;
    }
    const view = redraw();
    if (view?.clock?.secondsLeft === 0) stopClock();
  }

  return {
    element,
    update(input, deadline) {
      latestInput = input;
      latestDeadline = deadline;
      const view = redraw();
      const isCounting = view !== null && view.clock !== null && view.clock.secondsLeft > 0;
      if (!isCounting) {
        stopClock();
        return;
      }
      if (clockTimer === null) clockTimer = setInterval(onClockTick, CLOCK_TICK_MS);
    },
  };
}
