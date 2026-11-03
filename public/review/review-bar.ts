import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { mergeSession, onReviewChange, reviewOf, syncWatch, watchReviewSurface } from './review-store.ts';

export interface ReviewBar {
  element: HTMLElement;
  showSession: (sessionId: string | null) => void;
}

export function createReviewBar({ onOpenChanges }: { onOpenChanges: () => void }): ReviewBar {
  const element = el('div', 'review-bar');
  const status = el('span', 'review-bar-status');
  status.setAttribute('role', 'status');
  const changesButton = button({ variant: 'quiet', size: 'small', label: 'Changes', action: 'open-changes', onClick: onOpenChanges });
  const mergeButton = button({ variant: 'primary', size: 'small', label: 'Merge', action: 'merge-session' });
  element.append(status, changesButton, mergeButton);
  let sessionId: string | null = null;

  mergeButton.addEventListener('click', () => {
    if (sessionId) mergeSession(sessionId);
  });

  function paint() {
    const review = sessionId ? reviewOf(sessionId) : null;
    const wasSlotHeld = element.hasAttribute('data-slot-held');
    element.toggleAttribute('data-slot-held', review === null);
    if (wasSlotHeld !== (review === null)) syncWatch();
    if (!review) return;
    const statusText = review.notice ?? review.sentence;
    status.textContent = statusText;
    status.title = statusText;
    mergeButton.toggleAttribute('data-slot-held', review.isWorkspace || !review.isMergeShown);
    mergeButton.disabled = !review.isMergeEnabled;
    mergeButton.title = review.mergeTitle;
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
