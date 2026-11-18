import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';

type FollowMode = 'following' | 'escaped';
type FollowSignal = 'scroll-up' | 'select-text' | 'reach-bottom' | 'jump-to-latest';

const BOTTOM_THRESHOLD_PX = 70;
const JUMP_ICON_PATH = 'M8 3v10M3.5 8.5L8 13l4.5-4.5';

const NEXT_MODE_BY_SIGNAL: Record<FollowSignal, FollowMode> = {
  'scroll-up': 'escaped',
  'select-text': 'escaped',
  'reach-bottom': 'following',
  'jump-to-latest': 'following',
};

interface StickToBottom {
  jumpButton: HTMLButtonElement;
  followLatest(): void;
}

function distanceFromBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

function hasSelectionInside(scroller: HTMLElement): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return scroller.contains(selection.getRangeAt(0).commonAncestorContainer);
}

export function stickToBottom(scroller: HTMLElement, content: HTMLElement): StickToBottom {
  let mode: FollowMode = 'following';
  let lastScrollTop = scroller.scrollTop;
  let lastClientHeight = scroller.clientHeight;
  const jumpButton = button({ variant: 'floating-icon', label: 'Jump to latest', icon: createLineIcon(JUMP_ICON_PATH, '1.8'), hidden: true });

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
    lastScrollTop = scroller.scrollTop;
    lastClientHeight = scroller.clientHeight;
    if (hasResized && mode === 'following') {
      scrollToBottom();
      return;
    }
    const distance = distanceFromBottom(scroller);
    if (distance <= BOTTOM_THRESHOLD_PX) {
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
  const followObserver = new ResizeObserver(() => {
    if (mode === 'following') {
      scrollToBottom();
      return;
    }
    if (scroller.scrollTop !== lastScrollTop) scroller.scrollTop = lastScrollTop;
  });
  followObserver.observe(content, { box: 'border-box' });
  followObserver.observe(scroller);
  return { jumpButton, followLatest };
}
