import { el } from './dom-helpers.ts';

const CONFETTI_PIECE_COUNT = 48;
const CONFETTI_COLORS = ['var(--accent)', 'var(--state-running)', 'var(--state-idle)', 'var(--state-waiting)', 'var(--state-failed)'];
const CELEBRATION_DURATION_MS = 2600;

let activeCelebration: HTMLElement | null = null;

function createConfettiPiece(index: number): HTMLElement {
  const piece = el('span', 'merge-confetti-piece');
  const horizontalTravelPx = Math.round((Math.random() - 0.5) * 520);
  const riseHeightPx = Math.round(180 + Math.random() * 220);
  piece.style.setProperty('--confetti-x', `${horizontalTravelPx}px`);
  piece.style.setProperty('--confetti-rise', `${-riseHeightPx}px`);
  piece.style.setProperty('--confetti-spin', `${Math.round((Math.random() - 0.5) * 1080)}deg`);
  piece.style.setProperty('--confetti-delay', `${Math.round(Math.random() * 160)}ms`);
  piece.style.background = CONFETTI_COLORS[index % CONFETTI_COLORS.length];
  return piece;
}

export function celebrateMerge(message: string): void {
  activeCelebration?.remove();
  const overlay = el('div', 'merge-celebration');
  overlay.setAttribute('role', 'status');
  const burst = el('div', 'merge-confetti');
  for (let index = 0; index < CONFETTI_PIECE_COUNT; index += 1) burst.append(createConfettiPiece(index));
  overlay.append(burst, el('p', 'merge-celebration-message', message));
  document.body.append(overlay);
  activeCelebration = overlay;
  window.setTimeout(() => {
    overlay.remove();
    if (activeCelebration === overlay) activeCelebration = null;
  }, CELEBRATION_DURATION_MS);
}
