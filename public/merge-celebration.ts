import { el } from './dom-helpers.ts';
import { confettiPieceStyleProperties } from './merge-celebration/confetti-core.ts';
import { MERGE_CELEBRATION_SCENES, type MergeCelebrationScene } from './merge-celebration/scenes.ts';

const CONFETTI_PIECE_COUNT = 48;
const CELEBRATION_DURATION_MS = 7000;

let activeCelebration: HTMLElement | null = null;

function createConfettiPiece(pieceIndex: number): HTMLElement {
  const piece = el('span', 'merge-confetti-piece');
  const arc = el('span', 'merge-confetti-arc');
  arc.append(el('span', 'merge-confetti-paper'));
  piece.append(arc);
  for (const [propertyName, value] of confettiPieceStyleProperties(pieceIndex)) piece.style.setProperty(propertyName, value);
  return piece;
}

function createTitle(titleText: string): HTMLElement {
  const title = el('p', 'merge-celebration-title');
  title.setAttribute('aria-hidden', 'true');
  Array.from(titleText).forEach((letter, letterIndex) => {
    const letterElement = el('span', 'merge-celebration-letter', letter);
    letterElement.style.setProperty('--letter-delay', `${letterIndex * 45}ms`);
    title.append(letterElement);
  });
  return title;
}

function exposeTitleLayout(stage: HTMLElement, title: HTMLElement): void {
  const firstLetter = title.firstElementChild;
  const lastLetter = title.lastElementChild;
  if (!(firstLetter instanceof HTMLElement) || !(lastLetter instanceof HTMLElement)) return;
  stage.style.setProperty('--celebration-title-width', `${lastLetter.offsetLeft + lastLetter.offsetWidth - firstLetter.offsetLeft}px`);
  stage.style.setProperty('--celebration-title-center-y', `${title.offsetTop + title.offsetHeight / 2}px`);
}

function createSceneSlot(scene: MergeCelebrationScene): HTMLElement {
  const slot = el('div', 'merge-celebration-scene');
  slot.setAttribute('aria-hidden', 'true');
  slot.append(scene.buildScene());
  return slot;
}

function pickScene(): MergeCelebrationScene {
  return MERGE_CELEBRATION_SCENES[Math.floor(Math.random() * MERGE_CELEBRATION_SCENES.length)];
}

export function celebrateMerge(message: string, scene: MergeCelebrationScene = pickScene()): void {
  activeCelebration?.remove();
  const overlay = el('div', 'merge-celebration');
  overlay.setAttribute('role', 'status');
  const card = el('div', 'merge-celebration-card');
  const stage = el('div', 'merge-celebration-stage');
  const title = createTitle(scene.title);
  stage.append(title, el('p', 'merge-celebration-message', message), createSceneSlot(scene));
  const burst = el('div', 'merge-confetti');
  for (let index = 0; index < CONFETTI_PIECE_COUNT; index += 1) burst.append(createConfettiPiece(index));
  card.append(burst, stage);
  overlay.append(card);
  document.body.append(overlay);
  exposeTitleLayout(stage, title);
  activeCelebration = overlay;
  window.setTimeout(() => {
    overlay.remove();
    if (activeCelebration === overlay) activeCelebration = null;
  }, CELEBRATION_DURATION_MS);
}
