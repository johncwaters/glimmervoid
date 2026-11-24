import { clock } from '#shared/clock.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon, createSvgIcon, createSvgShape, TROPHY_ICON_PATH } from '../svg-dom.ts';
import { ACTING_PHASE_GLYPHS, WARGAMES_GLYPH_PATHS } from './wargames-glyphs.ts';
import { deriveTurnTrack, TRACK_PHASES } from './turn-track-core.ts';
import type { PhaseDeadline, TrackPhase, TurnTrackInput, TurnTrackView } from './turn-track-core.ts';
import { SEAT_COLORS } from './wargames-map.ts';
import './turn-track.css';

const CLOCK_TICK_MS = 1000;
const RING_SIZE = 32;
const RING_RADIUS = 14;

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

function buildParts(element: HTMLElement): TurnTrackParts {
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
  visual.append(pipStrip, turnCount, phaseStrip, ringSlot, seatStrip);
  element.append(summary, visual);
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

function render(element: HTMLElement, parts: TurnTrackParts, view: TurnTrackView): void {
  element.dataset.mode = view.mode;
  parts.summary.textContent = view.spokenSummary;
  syncPips(parts.pipStrip, view);
  parts.turnCount.textContent = view.turnText;
  for (const [phase, glyph] of parts.phaseGlyphs) {
    glyph.dataset.state = phase === view.activePhase ? 'active' : 'idle';
  }
  syncClock(parts, view);
  syncSeatDots(parts.seatStrip, view);
}

export function createTurnTrack(): TurnTrack {
  const element = el('div', 'wg-track');
  const parts = buildParts(element);
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
    render(element, parts, view);
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
