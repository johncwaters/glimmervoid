import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';
import { BOARD_DECK_BYTES_MESSAGE, BOARD_DECK_KEY_MESSAGE, BOARD_DECK_KEYS, BOARD_DECK_READY_MESSAGE, BOARD_PAGE_ARROW_MESSAGE, BOARD_PAGE_ESCAPE_MESSAGE } from '#shared/contracts/whiteboard.ts';

type DeckKey = (typeof BOARD_DECK_KEYS)[number];
type DeckFrameState = 'loading' | 'shown' | 'unreadable';

const UNREADABLE_TEXT = 'This deck could not be read.';
const COUNTER_GAP_PX = 44;
const SLIDE_STEP_BY_KEY: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -1, PageDown: 1 };
const EDGE_ARROW_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight']);
const PASSED_UP_ARROW_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown']);
const DECK_STYLE = `
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font: 13px system-ui, sans-serif; }
body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
#deck-stage { flex: none; box-shadow: 0 4px 24px rgb(0 0 0 / 0.35); background: #fff; }
#deck-counter, #deck-unreadable { margin: 0; padding: 4px 10px; border-radius: 999px; background: rgb(20 18 32 / 0.85); color: #f4f2fb; font-variant-numeric: tabular-nums; }
[hidden] { display: none !important; }
`;

const deckKeys: ReadonlySet<string> = new Set(BOARD_DECK_KEYS);
let deckFrameState: DeckFrameState = 'loading';
let viewer: PptxViewer | null = null;

const style = document.createElement('style');
style.textContent = DECK_STYLE;
const stage = document.createElement('main');
stage.id = 'deck-stage';
const counter = document.createElement('p');
counter.id = 'deck-counter';
counter.setAttribute('aria-live', 'polite');
counter.hidden = true;
const unreadable = document.createElement('p');
unreadable.id = 'deck-unreadable';
unreadable.textContent = UNREADABLE_TEXT;
unreadable.hidden = true;
document.head.append(style);
document.body.append(stage, counter, unreadable);

function isDeckKey(key: string): key is DeckKey {
  return deckKeys.has(key);
}

function fitStage(shownViewer: PptxViewer): void {
  const slideAspect = shownViewer.slideWidth / shownViewer.slideHeight;
  const fittedWidthPx = Math.min(window.innerWidth, (window.innerHeight - COUNTER_GAP_PX) * slideAspect);
  stage.style.width = `${Math.max(1, Math.floor(fittedWidthPx))}px`;
}

function showCounter(shownViewer: PptxViewer): void {
  counter.textContent = `${shownViewer.currentSlideIndex + 1} / ${shownViewer.slideCount}`;
  counter.hidden = false;
}

function showUnreadable(): void {
  deckFrameState = 'unreadable';
  stage.hidden = true;
  counter.hidden = true;
  unreadable.hidden = false;
}

async function showDeck(deckBytes: ArrayBuffer): Promise<void> {
  if (deckFrameState !== 'loading') return;
  try {
    const openedViewer = await PptxViewer.open(deckBytes, stage, { zipLimits: RECOMMENDED_ZIP_LIMITS, externalMedia: 'block', fitMode: 'contain', renderMode: 'slide' });
    if (openedViewer.slideCount === 0) {
      openedViewer.destroy();
      showUnreadable();
      return;
    }
    viewer = openedViewer;
    deckFrameState = 'shown';
    fitStage(openedViewer);
    showCounter(openedViewer);
  } catch {
    showUnreadable();
  }
}

function slideIndexAfter(shownViewer: PptxViewer, key: DeckKey): number {
  if (key === 'Home') return 0;
  if (key === 'End') return shownViewer.slideCount - 1;
  return shownViewer.currentSlideIndex + (SLIDE_STEP_BY_KEY[key] ?? 0);
}

function passArrowUp(key: string): void {
  window.parent.postMessage({ type: BOARD_PAGE_ARROW_MESSAGE, key }, '*');
}

function moveSlide(key: DeckKey): void {
  const shownViewer = viewer;
  const targetIndex = shownViewer ? slideIndexAfter(shownViewer, key) : -1;
  if (!shownViewer || targetIndex < 0 || targetIndex >= shownViewer.slideCount) {
    if (EDGE_ARROW_KEYS.has(key)) passArrowUp(key);
    return;
  }
  if (targetIndex === shownViewer.currentSlideIndex) return;
  void shownViewer.goToSlide(targetIndex).then(() => showCounter(shownViewer));
}

function pressKey(key: string): boolean {
  if (key === 'Escape') {
    window.parent.postMessage(BOARD_PAGE_ESCAPE_MESSAGE, '*');
    return true;
  }
  if (PASSED_UP_ARROW_KEYS.has(key)) {
    passArrowUp(key);
    return true;
  }
  if (!isDeckKey(key)) return false;
  moveSlide(key);
  return true;
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message: unknown = event.data;
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === BOARD_DECK_BYTES_MESSAGE && 'bytes' in message && message.bytes instanceof ArrayBuffer) {
    void showDeck(message.bytes);
    return;
  }
  if (message.type === BOARD_DECK_KEY_MESSAGE && 'key' in message && typeof message.key === 'string') pressKey(message.key);
});

window.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (pressKey(event.key)) event.preventDefault();
});

window.addEventListener('resize', () => {
  if (viewer) fitStage(viewer);
});

window.parent.postMessage({ type: BOARD_DECK_READY_MESSAGE }, '*');
