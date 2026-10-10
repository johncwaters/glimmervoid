import { el } from './dom-helpers.ts';

const CONFETTI_PIECE_COUNT = 48;
const CONFETTI_COLORS = ['var(--accent)', 'var(--state-running)', 'var(--state-idle)', 'var(--state-waiting)', 'var(--state-failed)'];
const PIN_ROW_SIZES = [1, 2, 3, 4];
const PIN_ROW_SPACING_PX = 9;
const PIN_DEPTH_SPACING_PX = 5;
const CELEBRATION_DURATION_MS = 7000;

let activeCelebration: HTMLElement | null = null;

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function createConfettiPiece(index: number): HTMLElement {
  const piece = el('span', 'merge-confetti-piece');
  piece.style.setProperty('--confetti-x', `${randomBetween(-260, 260)}px`);
  piece.style.setProperty('--confetti-rise', `${-randomBetween(40, 140)}px`);
  piece.style.setProperty('--confetti-spin', `${randomBetween(-540, 540)}deg`);
  piece.style.setProperty('--confetti-delay', `${randomBetween(0, 160)}ms`);
  piece.style.background = CONFETTI_COLORS[index % CONFETTI_COLORS.length];
  return piece;
}

function createPin(rowIndex: number, slotIndex: number, rowSize: number): HTMLElement {
  const pin = el('span', 'merge-strike-pin');
  const depthOffsetPx = (slotIndex - (rowSize - 1) / 2) * PIN_DEPTH_SPACING_PX;
  pin.style.setProperty('--pin-left', `${rowIndex * PIN_ROW_SPACING_PX + depthOffsetPx * 0.6}px`);
  pin.style.setProperty('--pin-lift', `${-Math.abs(depthOffsetPx) * 0.4}px`);
  pin.style.setProperty('--pin-fly-x', `${randomBetween(30, 110)}px`);
  pin.style.setProperty('--pin-fly-y', `${-randomBetween(18, 60)}px`);
  pin.style.setProperty('--pin-spin', `${randomBetween(120, 540) * (Math.random() < 0.5 ? -1 : 1)}deg`);
  pin.style.setProperty('--pin-delay', `${rowIndex * 40}ms`);
  pin.style.zIndex = String(10 - rowIndex);
  return pin;
}

function createLane(): HTMLElement {
  const lane = el('div', 'merge-strike-lane');
  const rack = el('div', 'merge-strike-rack');
  PIN_ROW_SIZES.forEach((rowSize, rowIndex) => {
    for (let slotIndex = 0; slotIndex < rowSize; slotIndex += 1) rack.append(createPin(rowIndex, slotIndex, rowSize));
  });
  lane.append(rack, el('span', 'merge-strike-ball'));
  return lane;
}

function createTitle(): HTMLElement {
  const title = el('p', 'merge-strike-title');
  title.setAttribute('aria-hidden', 'true');
  Array.from('STRIKE!').forEach((letter, letterIndex) => {
    const letterElement = el('span', 'merge-strike-letter', letter);
    letterElement.style.setProperty('--letter-delay', `${letterIndex * 45}ms`);
    title.append(letterElement);
  });
  return title;
}

export function celebrateMerge(message: string): void {
  activeCelebration?.remove();
  const overlay = el('div', 'merge-celebration');
  overlay.setAttribute('role', 'status');
  const card = el('div', 'merge-strike-card');
  const burst = el('div', 'merge-confetti');
  for (let index = 0; index < CONFETTI_PIECE_COUNT; index += 1) burst.append(createConfettiPiece(index));
  card.append(createLane(), createTitle(), el('p', 'merge-celebration-message', message), burst);
  overlay.append(card);
  document.body.append(overlay);
  activeCelebration = overlay;
  window.setTimeout(() => {
    overlay.remove();
    if (activeCelebration === overlay) activeCelebration = null;
  }, CELEBRATION_DURATION_MS);
}
