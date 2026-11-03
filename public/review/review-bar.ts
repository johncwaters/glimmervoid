import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { onReviewChange, reviewOf, syncWatch, watchReviewSurface } from './review-store.ts';

export interface ReviewBar {
  element: HTMLElement;
  showSession: (sessionId: string | null) => void;
}

export function createReviewBar({ onOpenChanges }: { onOpenChanges: () => void }): ReviewBar {
  const element = el('div', 'review-bar');
  const changesButton = button({ variant: 'quiet', size: 'small', label: 'Changes', action: 'open-changes', onClick: onOpenChanges });
  element.append(changesButton);
  let sessionId: string | null = null;

  function paint() {
    const review = sessionId ? reviewOf(sessionId) : null;
    const wasSlotHeld = element.hasAttribute('data-slot-held');
    element.toggleAttribute('data-slot-held', review === null);
    if (wasSlotHeld !== (review === null)) syncWatch();
  }

  onReviewChange((changedSessionId) => {
    if (changedSessionId === sessionId) paint();
  });
  watchReviewSurface(element);
  element.toggleAttribute('data-slot-held', true);

  return {
    element,
    showSession: (nextSessionId) => {
      if (nextSessionId === sessionId) return;
      sessionId = nextSessionId;
      paint();
    },
  };
}
