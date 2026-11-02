import { el } from '../dom-helpers.ts';
import { mergeSession, onReviewChange, reviewOf, watchReviewSurface } from './review-store.ts';

export interface ReviewBar {
  element: HTMLElement;
  showSession: (sessionId: string | null) => void;
}

export function createReviewBar({ onOpenChanges }: { onOpenChanges: () => void }): ReviewBar {
  const element = el('div', 'review-bar');
  const status = el('span', 'review-bar-status');
  status.setAttribute('role', 'status');
  const changesButton = el('button', 'review-bar-button', 'Changes');
  changesButton.type = 'button';
  changesButton.addEventListener('click', onOpenChanges);
  const mergeButton = el('button', 'review-bar-button review-bar-merge', 'Merge');
  mergeButton.type = 'button';
  element.append(status, changesButton, mergeButton);
  let sessionId: string | null = null;

  mergeButton.addEventListener('click', () => {
    if (sessionId) mergeSession(sessionId);
  });

  function paint() {
    const review = sessionId ? reviewOf(sessionId) : null;
    element.hidden = review === null;
    if (!review) return;
    status.textContent = review.notice ?? review.sentence;
    mergeButton.hidden = !review.isMergeShown;
    mergeButton.disabled = !review.isMergeEnabled;
    mergeButton.title = review.mergeTitle;
  }

  onReviewChange((changedSessionId) => {
    if (changedSessionId === sessionId) paint();
  });
  watchReviewSurface(element);
  element.hidden = true;

  return {
    element,
    showSession: (nextSessionId) => {
      if (nextSessionId === sessionId) return;
      sessionId = nextSessionId;
      paint();
    },
  };
}
