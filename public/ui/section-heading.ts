import { el } from '../dom-helpers.ts';

type SectionHeadingLevel = 2 | 3 | 4 | 'none';
type SectionHeadingTone = 'muted' | 'strong' | 'waiting';
type SectionHeadingCount = number | string | null;

type SectionHeadingOptions = {
  title: string;
  level: SectionHeadingLevel;
  count?: SectionHeadingCount;
  tone?: SectionHeadingTone;
  hint?: string | null;
  actions?: readonly HTMLElement[];
};

export type SectionHeading = {
  readonly element: HTMLDivElement;
  setCount(count: SectionHeadingCount): void;
};

const HEADING_TAGS = { 2: 'h2', 3: 'h3', 4: 'h4', none: 'div' } as const;

export function sectionHeading({ title, level, count = null, tone = 'muted', hint = null, actions = [] }: SectionHeadingOptions): SectionHeading {
  const element = el('div', 'ui-section-heading');
  element.dataset.tone = tone;
  const titleElement = el(HEADING_TAGS[level], 'ui-section-heading-title ui-label', title);
  const countElement = el('span', 'ui-section-heading-count');
  element.append(titleElement, countElement);
  if (hint) element.append(el('span', 'ui-section-heading-hint', hint));
  if (actions.length > 0) {
    const actionsElement = el('div', 'ui-section-heading-actions');
    actionsElement.append(...actions);
    element.append(actionsElement);
  }
  const setCount = (nextCount: SectionHeadingCount) => {
    const text = nextCount === null ? '' : String(nextCount);
    if (countElement.textContent !== text) countElement.textContent = text;
    countElement.hidden = text === '';
  };
  setCount(count);
  return { element, setCount };
}
