import { button } from '../ui/button.ts';

type FollowMode = 'following' | 'escaped';
type FollowSignal = 'scroll-up' | 'wheel-up' | 'select-text' | 'reach-bottom' | 'jump-to-latest';

const BOTTOM_THRESHOLD_PX = 70;

const NEXT_MODE_BY_SIGNAL: Record<FollowSignal, FollowMode> = {
  'scroll-up': 'escaped',
  'wheel-up': 'escaped',
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
  const jumpButton = button({ variant: 'secondary', textCase: 'sentence', label: 'Jump to latest', hidden: true });

  const scrollToBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
    lastScrollTop = scroller.scrollTop;
    lastClientHeight = scroller.clientHeight;
  };
  const receive = (signal: FollowSignal) => {
    mode = NEXT_MODE_BY_SIGNAL[signal];
    jumpButton.hidden = mode === 'following';
  };

  scroller.addEventListener('wheel', (event) => {
    if (event.deltaY < 0) receive('wheel-up');
  }, { passive: true });
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
    if (scrolledUp && distance > 1) {
      receive('scroll-up');
      return;
    }
    if (distance <= BOTTOM_THRESHOLD_PX) receive('reach-bottom');
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
    if (mode === 'following') scrollToBottom();
  });
  followObserver.observe(content, { box: 'border-box' });
  followObserver.observe(scroller);
  return { jumpButton, followLatest };
}
