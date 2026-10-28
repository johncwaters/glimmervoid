import { playToneSequence } from '../alert-sound.ts';
import { el, setStyleProperties } from '../dom-helpers.ts';
import type { MergeCelebrationText } from '../github/my-prs-view-core.ts';
import { isSoundEnabled } from '../ui-prefs.ts';
import { mergeCelebrationSound } from './celebration-sound-core.ts';
import { confettiPieceStyleProperties, confettiScaleFor } from './confetti-core.ts';
import { MERGE_CELEBRATION_SCENES, type MergeCelebrationScene } from './scenes.ts';

const CONFETTI_PIECE_COUNT = 48;
export const CELEBRATION_DURATION_MS = 5600;

let activeCelebration: HTMLElement | null = null;

function createConfettiPiece(pieceIndex: number): HTMLElement {
  const piece = el('span', 'merge-confetti-piece');
  const arc = el('span', 'merge-confetti-arc');
  arc.append(el('span', 'merge-confetti-paper'));
  piece.append(arc);
  setStyleProperties(piece, confettiPieceStyleProperties(pieceIndex));
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

function exposeTitleLayout(stage: HTMLElement, title: HTMLElement, sceneSlot: HTMLElement): void {
  const firstLetter = title.firstElementChild;
  const lastLetter = title.lastElementChild;
  if (!(firstLetter instanceof HTMLElement) || !(lastLetter instanceof HTMLElement)) return;
  stage.style.setProperty('--celebration-title-width', `${lastLetter.offsetLeft + lastLetter.offsetWidth - firstLetter.offsetLeft}px`);
  stage.style.setProperty('--celebration-title-center-y', `${title.offsetTop + title.offsetHeight / 2 - sceneSlot.offsetTop}px`);
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

function playCelebrationSound(positionInPlayThrough: number): void {
  if (!isSoundEnabled()) return;
  try {
    playToneSequence(mergeCelebrationSound(positionInPlayThrough));
  } catch {
  }
}

function createDetailList(detailLines: readonly string[]): HTMLElement {
  const detailList = el('ul', 'merge-celebration-details');
  for (const detailLine of detailLines) detailList.append(el('li', 'merge-celebration-detail', detailLine));
  return detailList;
}

export function playCelebration(text: MergeCelebrationText, positionInPlayThrough: number): void {
  const scene = pickScene();
  activeCelebration?.remove();
  playCelebrationSound(positionInPlayThrough);
  const overlay = el('div', 'merge-celebration');
  overlay.setAttribute('role', 'status');
  const card = el('div', 'merge-celebration-card');
  const stage = el('div', 'merge-celebration-stage');
  const title = createTitle(scene.title);
  const sceneSlot = createSceneSlot(scene);
  stage.append(title, el('p', 'merge-celebration-message', text.message), createDetailList(text.detailLines), sceneSlot);
  const burst = el('div', 'merge-confetti');
  burst.style.setProperty('--confetti-scale', String(confettiScaleFor(positionInPlayThrough)));
  for (let index = 0; index < CONFETTI_PIECE_COUNT; index += 1) burst.append(createConfettiPiece(index));
  card.append(burst, stage);
  overlay.append(card);
  document.body.append(overlay);
  exposeTitleLayout(stage, title, sceneSlot);
  activeCelebration = overlay;
  window.setTimeout(() => {
    overlay.remove();
    if (activeCelebration === overlay) activeCelebration = null;
  }, CELEBRATION_DURATION_MS);
}
