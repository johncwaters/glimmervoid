import { el } from '../dom-helpers.ts';
import { emptyStateDescriptor } from './empty-state-core.ts';
import type { EmptyStateVariant } from './empty-state-core.ts';

type EmptyStateOptions = {
  text: string | Node | readonly (string | Node)[];
  title?: string;
  actions?: readonly HTMLElement[];
  variant?: EmptyStateVariant;
};

export function emptyState({ text, title, actions = [], variant = 'inline' }: EmptyStateOptions): HTMLElement {
  const textParts = typeof text === 'string' || text instanceof Node ? [text] : text;
  const descriptor = emptyStateDescriptor({
    hasTitle: Boolean(title),
    hasActions: actions.length > 0,
    variant,
  });
  const element = el(descriptor.rootTag, descriptor.className);
  element.dataset.variant = descriptor.variant;
  if (descriptor.isTextOnly) {
    element.append(...textParts);
    return element;
  }
  if (title) element.append(el('p', descriptor.titleClassName, title));
  const textElement = el('p', descriptor.textClassName);
  textElement.append(...textParts);
  element.append(textElement);
  if (actions.length > 0) {
    const actionsElement = el('div', descriptor.actionsClassName);
    actionsElement.append(...actions);
    element.append(actionsElement);
  }
  return element;
}
