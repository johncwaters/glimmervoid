import { playToneSequence } from './alert-sound.ts';
import { el, setStyleProperties } from './dom-helpers.ts';
import { mergeCelebrationSound } from './merge-celebration/celebration-sound-core.ts';
import { confettiPieceStyleProperties, confettiScaleFor } from './merge-celebration/confetti-core.ts';
import { MERGE_CELEBRATION_SCENES, type MergeCelebrationScene } from './merge-celebration/scenes.ts';
import { isSoundEnabled } from './ui-prefs.ts';

const CONFETTI_PIECE_COUNT = 48;
const CELEBRATION_DURATION_MS = 7000;

const MAX_QUEUED_CELEBRATIONS = 20;

interface QueuedCelebration { message: string; scene: MergeCelebrationScene }
interface CelebrationTrayElements { tray: HTMLElement; button: HTMLButtonElement; count: HTMLElement }

let activeCelebration: HTMLElement | null = null;
const queuedCelebrations: QueuedCelebration[] = [];
let celebrationTray: CelebrationTrayElements | null = null;
let isPlayingQueuedCelebrations = false;
let playThroughPosition = 0;

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

function playCelebrationSound(positionInPlayThrough: number): void {
  if (!isSoundEnabled()) return;
  try {
    playToneSequence(mergeCelebrationSound(positionInPlayThrough));
  } catch {
  }
}

function playCelebration(message: string, scene: MergeCelebrationScene, positionInPlayThrough: number): void {
  activeCelebration?.remove();
  playCelebrationSound(positionInPlayThrough);
  const overlay = el('div', 'merge-celebration');
  overlay.setAttribute('role', 'status');
  const card = el('div', 'merge-celebration-card');
  const stage = el('div', 'merge-celebration-stage');
  const title = createTitle(scene.title);
  stage.append(title, el('p', 'merge-celebration-message', message), createSceneSlot(scene));
  const burst = el('div', 'merge-confetti');
  burst.style.setProperty('--confetti-scale', String(confettiScaleFor(positionInPlayThrough)));
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

function trayStateFor(hasQueuedCelebrations: boolean): 'playing' | 'queued' | 'empty' {
  if (isPlayingQueuedCelebrations) return 'playing';
  if (hasQueuedCelebrations) return 'queued';
  return 'empty';
}

function renderCelebrationTray(): void {
  if (!celebrationTray) return;
  const hasQueuedCelebrations = queuedCelebrations.length > 0;
  celebrationTray.tray.dataset.state = trayStateFor(hasQueuedCelebrations);
  celebrationTray.count.textContent = hasQueuedCelebrations ? String(queuedCelebrations.length) : '';
  celebrationTray.button.disabled = isPlayingQueuedCelebrations || !hasQueuedCelebrations;
}

function playNextQueuedCelebration(): void {
  const nextCelebration = queuedCelebrations.shift();
  isPlayingQueuedCelebrations = nextCelebration !== undefined;
  renderCelebrationTray();
  if (!nextCelebration) return;
  playCelebration(nextCelebration.message, nextCelebration.scene, playThroughPosition);
  playThroughPosition += 1;
  window.setTimeout(playNextQueuedCelebration, CELEBRATION_DURATION_MS);
}

export function mountCelebrationTray(tray: HTMLElement, button: HTMLButtonElement, count: HTMLElement): void {
  celebrationTray = { tray, button, count };
  button.addEventListener('click', () => {
    playThroughPosition = 0;
    playNextQueuedCelebration();
  });
  renderCelebrationTray();
}

export function queueMergeCelebration(message: string, scene: MergeCelebrationScene = pickScene()): void {
  queuedCelebrations.push({ message, scene });
  if (queuedCelebrations.length > MAX_QUEUED_CELEBRATIONS) queuedCelebrations.shift();
  renderCelebrationTray();
}
