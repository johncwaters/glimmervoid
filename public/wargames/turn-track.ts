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
import { deriveTurnTrack, PHASE_NAMES, TRACK_PHASES } from './turn-track-core.ts';
import type { PhaseDeadline, TrackPhase, TurnTrackInput, TurnTrackView } from './turn-track-core.ts';
import { SEAT_COLORS } from './wargames-map.ts';
import './turn-track.css';

const CLOCK_TICK_MS = 1000;
const RING_SIZE = 32;
const RING_RADIUS = 14;

interface TurnTrackReplayActions {
  seekTurn(tick: number): void;
  seekPhase(phase: TrackPhase): void;
  stepTurn(direction: -1 | 1): void;
  togglePlay(): void;
  setSpeed(speed: ReplaySpeed): void;
  jumpToEnd(): void;
}

interface TransportParts {
  group: HTMLElement;
  rewind: HTMLButtonElement;
  stepBack: HTMLButtonElement;
  play: OutlineIconButton<'pressed'>;
  stepForward: HTMLButtonElement;
  jumpToEnd: HTMLButtonElement;
  speed: Segmented<`${ReplaySpeed}`>;
}

interface TurnTrackParts {
  summary: HTMLElement;
  turnCount: HTMLElement;
  pipStrip: HTMLElement;
  scrubber: HTMLInputElement | null;
  phases: Segmented<TrackPhase>;
  ringSlot: HTMLElement;
  ringArc: SVGElement;
  ringText: HTMLElement;
  endGlyphSlot: HTMLElement;
  modeTag: HTMLElement;
  seatStrip: HTMLElement;
  transport: TransportParts | null;
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

function trackIcon(pathData: string): SVGSVGElement {
  return createLineIcon(pathData, '1.5');
}

function buildScrubber(actions: TurnTrackReplayActions): HTMLInputElement {
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
  return scrubber;
}

function buildPhaseControl(actions: TurnTrackReplayActions | null): Segmented<TrackPhase> {
  const phases = segmented<TrackPhase>({
    label: 'Phase',
    size: 'small',
    options: TRACK_PHASES.map((phase) => ({ value: phase, label: PHASE_NAMES[phase], icon: trackIcon(ACTING_PHASE_GLYPHS[phase]) })),
    value: 'talk',
    onChange: (phase) => actions?.seekPhase(phase),
  });
  phases.element.classList.add('wg-track-phases');
  return phases;
}

function buildTransport(actions: TurnTrackReplayActions): TransportParts {
  const group = el('span', 'wg-track-transport');
  const rewind = button({ variant: 'quiet', size: 'small', label: 'Rewind', icon: trackIcon(REPLAY_GLYPH_PATHS.stepBack), onClick: () => actions.stepTurn(-1) });
  rewind.classList.add('wg-track-rewind');
  const stepBack = button({ variant: 'icon', size: 'small', label: 'Step back', icon: trackIcon(REPLAY_GLYPH_PATHS.stepBack), onClick: () => actions.stepTurn(-1) });
  const play = outlineIconButton({ label: 'Play', icon: trackIcon(REPLAY_GLYPH_PATHS.play), size: 'small', states: ['idle', 'pressed'], onClick: () => actions.togglePlay() });
  const stepForward = button({ variant: 'icon', size: 'small', label: 'Step forward', icon: trackIcon(REPLAY_GLYPH_PATHS.stepForward), onClick: () => actions.stepTurn(1) });
  const jumpToEnd = button({ variant: 'icon', size: 'small', label: 'Jump to latest', icon: trackIcon(REPLAY_GLYPH_PATHS.end), onClick: () => actions.jumpToEnd() });
  const speed = segmented<`${ReplaySpeed}`>({
    label: 'Speed',
    size: 'small',
    options: REPLAY_SPEEDS.map((value) => ({ value: `${value}` as const, label: `${value}x` })),
    value: '1',
    onChange: (value) => actions.setSpeed(Number(value) as ReplaySpeed),
  });
  const replayControls = el('span', 'wg-track-replay-controls');
  replayControls.append(stepBack, play.element, stepForward, jumpToEnd, speed.element);
  group.append(rewind, replayControls);
  return { group, rewind, stepBack, play, stepForward, jumpToEnd, speed };
}

function buildParts(element: HTMLElement, actions: TurnTrackReplayActions | null): TurnTrackParts {
  const summary = el('span', 'sr-only');
  const turnCount = el('span', 'wg-track-turn');
  turnCount.setAttribute('aria-hidden', 'true');
  const pipStrip = el('span', 'wg-track-pips');
  pipStrip.setAttribute('aria-hidden', 'true');
  const scrub = el('span', 'wg-track-scrub');
  const scrubber = actions ? buildScrubber(actions) : null;
  scrub.append(pipStrip);
  if (scrubber) scrub.append(scrubber);
  const phases = buildPhaseControl(actions);
  const ringSlot = el('span', 'wg-track-clock');
  ringSlot.setAttribute('aria-hidden', 'true');
  const { ring, arc } = buildRing();
  const ringText = el('span', 'wg-track-clock-text');
  const endGlyphSlot = el('span', 'wg-track-end');
  ringSlot.append(ring, ringText, endGlyphSlot);
  const tagSlot = el('span', 'wg-track-tag');
  const modeTag = tag({ text: '', tone: 'muted' });
  tagSlot.append(modeTag);
  const seatStrip = el('span', 'wg-track-seats');
  seatStrip.setAttribute('aria-hidden', 'true');
  const transport = actions ? buildTransport(actions) : null;
  element.append(summary, turnCount, scrub, phases.element, ringSlot, tagSlot, seatStrip);
  if (transport) element.append(transport.group);
  return { summary, turnCount, pipStrip, scrubber, phases, ringSlot, ringArc: arc, ringText, endGlyphSlot, modeTag, seatStrip, transport };
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
    const trophy = trackIcon(TROPHY_ICON_PATH);
    if (view.winnerSeatId) trophy.style.color = SEAT_COLORS[view.winnerSeatId];
    return trophy;
  }
  if (view.mode === 'aborted') return trackIcon(WARGAMES_GLYPH_PATHS.offline);
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

function syncScrubber(scrubber: HTMLInputElement, view: TurnTrackView, input: TurnTrackInput): void {
  scrubber.disabled = view.transport !== 'full';
  scrubber.max = String(input.maxTicks);
  scrubber.dataset.headTick = String(view.replay?.headTick ?? input.tick);
  scrubber.value = String(Math.max(1, input.tick));
  scrubber.setAttribute('aria-valuetext', `Turn ${input.tick} of ${view.replay?.headTick ?? input.maxTicks}`);
}

function syncTransport(transport: TransportParts, view: TurnTrackView, tick: number): void {
  const replay = view.replay;
  transport.rewind.disabled = view.transport !== 'rewind' || (tick <= 1 && view.activePhase === 'talk');
  transport.stepBack.disabled = replay === null || (tick <= 1 && view.activePhase === 'talk');
  transport.play.setState(replay?.isPlaying ? 'pressed' : 'idle');
  transport.stepForward.disabled = replay === null || replay.isAtHead;
  transport.jumpToEnd.disabled = replay === null || replay.isAtHead;
  transport.speed.setValue(`${replay?.speed ?? 1}`);
}

function render(element: HTMLElement, parts: TurnTrackParts, view: TurnTrackView, input: TurnTrackInput): void {
  element.dataset.mode = view.mode;
  element.dataset.transport = view.transport;
  parts.summary.textContent = view.spokenSummary;
  parts.turnCount.textContent = view.turnText;
  syncPips(parts.pipStrip, view);
  if (parts.scrubber) syncScrubber(parts.scrubber, view, input);
  if (view.activePhase) parts.phases.setValue(view.activePhase);
  parts.phases.element.inert = view.transport !== 'full';
  syncClock(parts, view);
  parts.modeTag.textContent = view.tag.text;
  parts.modeTag.dataset.tone = view.tag.tone;
  syncSeatDots(parts.seatStrip, view);
  if (parts.transport) syncTransport(parts.transport, view, input.tick);
}

export function createTurnTrack(replayActions: TurnTrackReplayActions | null = null): TurnTrack {
  const element = el('div', 'wg-track');
  const parts = buildParts(element, replayActions);
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
    render(element, parts, view, latestInput);
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
