import { el } from '../dom-helpers.ts';

type EmptyStateVariant = 'inline' | 'boxed' | 'centered';

type EmptyStateOptions = {
  text: string | Node | readonly (string | Node)[];
  title?: string;
  actions?: readonly HTMLElement[];
  variant?: EmptyStateVariant;
};

export function emptyState({ text, title, actions = [], variant = 'inline' }: EmptyStateOptions): HTMLElement {
  const textParts = typeof text === 'string' || text instanceof Node ? [text] : text;
  const isTextOnly = !title && actions.length === 0;
  const element = el(isTextOnly ? 'p' : 'div', 'ui-empty-state');
  element.dataset.variant = variant;
  if (isTextOnly) {
    element.append(...textParts);
    return element;
  }
  if (title) element.append(el('p', 'ui-empty-state-title', title));
  const textElement = el('p', 'ui-empty-state-text');
  textElement.append(...textParts);
  element.append(textElement);
  if (actions.length > 0) {
    const actionsElement = el('div', 'ui-empty-state-actions');
    actionsElement.append(...actions);
    element.append(actionsElement);
  }
  return element;
}
