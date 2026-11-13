import { adoptElement, releaseElement } from './dom-helpers.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { container, sessionUIs } from './session-card/card-registry.ts';
import { uiState } from './ui-state-core.ts';

type CardSlot = 'terminal' | 'shell';

const BORROW_ACTION_BY_SLOT = { terminal: 'borrowCard', shell: 'borrowShellCard' } as const;
const OTHER_SLOT: Readonly<Record<CardSlot, CardSlot>> = { terminal: 'shell', shell: 'terminal' };

export function getBorrowedCardId(slot: CardSlot = 'terminal') {
  const snapshot = uiState.snapshot();
  return slot === 'terminal' ? snapshot.borrowedCardId : snapshot.borrowedShellCardId;
}

const runOnReleaseBySlot = new Map<CardSlot, () => void>();

export function borrowCard(ui: SessionUi | null | undefined, sessionId: string, slotEl: HTMLElement | null | undefined, { slot = 'terminal', className, onRelease }: { slot?: CardSlot; className?: string; onRelease?: () => void } = {}) {
  if (!ui?.card || !slotEl) return;
  const borrowedId = getBorrowedCardId(slot);
  if (borrowedId && borrowedId !== sessionId) releaseCard(slot);
  if (getBorrowedCardId(OTHER_SLOT[slot]) === sessionId) releaseCard(OTHER_SLOT[slot]);

  const card = ui.card;
  if (card._cardHostClass && card._cardHostClass !== className) card.classList.remove(card._cardHostClass);
  card._cardHostClass = className || '';
  if (className) card.classList.add(className);

  adoptElement(card, slotEl);
  if (onRelease) runOnReleaseBySlot.set(slot, onRelease);
  if (!onRelease) runOnReleaseBySlot.delete(slot);
  uiState.dispatch(BORROW_ACTION_BY_SLOT[slot], sessionId);

  ui._ensureTerminalReady?.();
  ui._setBorrowed?.(true);
  ui._ensureTerminalReady?.();
}

export function releaseCard(slot: CardSlot = 'terminal') {
  const releasedId = getBorrowedCardId(slot);
  const releaseHook = runOnReleaseBySlot.get(slot);
  runOnReleaseBySlot.delete(slot);
  releaseHook?.();
  uiState.dispatch(BORROW_ACTION_BY_SLOT[slot], null);
  if (!releasedId) return null;

  const ui = sessionUIs.get(releasedId);

  ui?._ensureTerminalReady?.();
  ui?._setBorrowed?.(false);
  ui?._setActiveViewer?.(false);
  const card = ui?.card;
  if (!card) return releasedId;

  if (card._cardHostClass) card.classList.remove(card._cardHostClass);
  delete card._cardHostClass;
  releaseElement(card, container);
  return releasedId;
}
