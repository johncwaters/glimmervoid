import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';

type FollowMode = 'following' | 'escaped';
type FollowSignal = 'scroll-up' | 'select-text' | 'reach-bottom' | 'jump-to-latest';

const BOTTOM_THRESHOLD_PX = 70;
const JUMP_ICON_PATH = 'M8 3v10M3.5 8.5L8 13l4.5-4.5';
const RECONNECT_SENTINEL_TAG = 'chat-reconnect-sentinel';

const restorePlaceBySentinel = new WeakMap<HTMLElement, () => void>();

const NEXT_MODE_BY_SIGNAL: Record<FollowSignal, FollowMode> = {
  'scroll-up': 'escaped',
  'select-text': 'escaped',
  'reach-bottom': 'following',
  'jump-to-latest': 'following',
};

interface StickToBottom {
  jumpButton: HTMLButtonElement;
  followLatest(): void;
  keepInPlace(anchor: HTMLElement, change: () => void): void;
  keepPlaceWhileLoading(anchor: HTMLElement, change: () => void): void;
}

function distanceFromBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

function hasSelectionInside(scroller: HTMLElement): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return scroller.contains(selection.getRangeAt(0).commonAncestorContainer);
}

function defineReconnectSentinel(): void {
  if (customElements.get(RECONNECT_SENTINEL_TAG)) return;
  customElements.define(RECONNECT_SENTINEL_TAG, class extends HTMLElement {
    connectedCallback() {
      restorePlaceBySentinel.get(this)?.();
    }
  });
}

function watchReconnects(scroller: HTMLElement, restorePlace: () => void): void {
  defineReconnectSentinel();
  const sentinel = document.createElement(RECONNECT_SENTINEL_TAG);
  sentinel.hidden = true;
  restorePlaceBySentinel.set(sentinel, restorePlace);
  scroller.append(sentinel);
}

export function stickToBottom(scroller: HTMLElement, content: HTMLElement): StickToBottom {
  let mode: FollowMode = 'following';
  let lastScrollTop = scroller.scrollTop;
  let lastClientHeight = scroller.clientHeight;
  const jumpButton = button({ variant: 'secondary', size: 'small', textCase: 'sentence', label: 'Latest', icon: createLineIcon(JUMP_ICON_PATH, '1.8'), hidden: true });
  jumpButton.setAttribute('aria-label', 'Jump to latest');

  const scrollToBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
    lastScrollTop = scroller.scrollTop;
    lastClientHeight = scroller.clientHeight;
  };
  const receive = (signal: FollowSignal) => {
    mode = NEXT_MODE_BY_SIGNAL[signal];
    jumpButton.hidden = mode === 'following';
  };

  scroller.addEventListener('scroll', () => {
    const hasResized = scroller.clientHeight !== lastClientHeight;
    const scrolledUp = scroller.scrollTop < lastScrollTop - 1;
    const scrolledDown = scroller.scrollTop > lastScrollTop + 1;
    lastScrollTop = scroller.scrollTop;
    lastClientHeight = scroller.clientHeight;
    if (hasResized && mode === 'following') {
      scrollToBottom();
      return;
    }
    const distance = distanceFromBottom(scroller);
    if (distance <= BOTTOM_THRESHOLD_PX && (mode === 'following' || scrolledDown || distance <= 1)) {
      receive('reach-bottom');
      return;
    }
    if (scrolledUp) receive('scroll-up');
  }, { passive: true });
  document.addEventListener('selectionchange', () => {
    if (mode === 'following' && hasSelectionInside(scroller)) receive('select-text');
  });
  const followLatest = () => {
    receive('jump-to-latest');
    scrollToBottom();
  };
  jumpButton.addEventListener('click', followLatest);
  const holdAnchor = (anchor: HTMLElement, change: () => void) => {
    const anchorTopBefore = anchor.getBoundingClientRect().top;
    change();
    scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTopBefore;
    lastScrollTop = scroller.scrollTop;
  };
  const keepInPlace = (anchor: HTMLElement, change: () => void) => {
    holdAnchor(anchor, change);
    receive(distanceFromBottom(scroller) <= 1 ? 'reach-bottom' : 'scroll-up');
  };
  const hasScrolledUpUnseen = () => scroller.scrollTop < lastScrollTop - 1 && distanceFromBottom(scroller) > BOTTOM_THRESHOLD_PX;
  const keepPlaceWhileLoading = (anchor: HTMLElement, change: () => void) => {
    if (hasScrolledUpUnseen()) receive('scroll-up');
    if (mode === 'escaped') {
      holdAnchor(anchor, change);
      return;
    }
    change();
    scrollToBottom();
  };
  const restorePlace = () => {
    if (mode === 'following') {
      scrollToBottom();
      return;
    }
    if (scroller.scrollTop !== lastScrollTop) scroller.scrollTop = lastScrollTop;
  };
  const followObserver = new ResizeObserver(restorePlace);
  followObserver.observe(content, { box: 'border-box' });
  followObserver.observe(scroller);
  watchReconnects(scroller, restorePlace);
  return { jumpButton, followLatest, keepInPlace, keepPlaceWhileLoading };
}
