import { el } from '../dom-helpers.ts';

type DisclosureMarker = 'chevron' | 'plus';

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
  const element = el('details', 'ui-disclosure');
  element.dataset.marker = options.marker ?? 'plus';
  const summary = el('summary', 'ui-disclosure-summary');
  const marker = el('span', 'ui-disclosure-marker');
  marker.setAttribute('aria-hidden', 'true');
  summary.append(marker, ...contentNodes(options.summary));
  const body = el('div', 'ui-disclosure-body');
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
  element.open = options.open ?? false;
  if (element.open) fillPendingBody();
  element.addEventListener('toggle', () => {
    if (element.open) fillPendingBody();
    onToggle?.(element.open);
  });
  return { element, summary, body };
}

export function detailsBlock(text: string): HTMLDetailsElement {
  return disclosure({ summary: 'Show details', body: el('pre', 'ui-details-block-text', text) }).element;
}

function contentNodes(content: DisclosureContent): (Node | string)[] {
  if (typeof content === 'string' || content instanceof Node) return [content];
  return [...content];
}
