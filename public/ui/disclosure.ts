import { el } from '../dom-helpers.ts';
import { detailsBlockDescriptor, disclosureDescriptor } from './disclosure-core.ts';
import type { DisclosureMarker } from './disclosure-core.ts';

type DisclosureContent = Node | string | readonly (Node | string)[];

type DisclosureOptions = {
  summary: DisclosureContent;
  body?: DisclosureContent | (() => DisclosureContent);
  open?: boolean;
  marker?: DisclosureMarker;
  onToggle?: (open: boolean) => void;
};

export type Disclosure = {
  readonly element: HTMLDetailsElement;
  readonly summary: HTMLElement;
  readonly body: HTMLDivElement;
};

export function disclosure(options: DisclosureOptions): Disclosure {
  const descriptor = disclosureDescriptor({ marker: options.marker, open: options.open });
  const element = el('details', descriptor.className);
  element.dataset.marker = descriptor.marker;
  const summary = el('summary', descriptor.summaryClassName);
  const marker = el('span', descriptor.markerClassName);
  marker.setAttribute('aria-hidden', 'true');
  summary.append(marker, ...contentNodes(options.summary));
  const body = el('div', descriptor.bodyClassName);
  element.append(summary, body);
  const { body: bodyContent, onToggle } = options;
  let renderPendingBody = typeof bodyContent === 'function' ? bodyContent : null;
  const fillPendingBody = () => {
    if (!renderPendingBody) return;
    const render = renderPendingBody;
    renderPendingBody = null;
    body.append(...contentNodes(render()));
  };
  if (bodyContent !== undefined && typeof bodyContent !== 'function') body.append(...contentNodes(bodyContent));
  element.open = descriptor.open;
  if (element.open) fillPendingBody();
  element.addEventListener('toggle', () => {
    if (element.open) fillPendingBody();
    onToggle?.(element.open);
  });
  return { element, summary, body };
}

export function detailsBlock(text: string): HTMLDetailsElement {
  const descriptor = detailsBlockDescriptor(text);
  return disclosure({ summary: descriptor.summary, body: el('pre', descriptor.bodyClassName, descriptor.text) }).element;
}

function contentNodes(content: DisclosureContent): (Node | string)[] {
  if (typeof content === 'string' || content instanceof Node) return [content];
  return [...content];
}
