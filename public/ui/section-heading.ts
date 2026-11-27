import { el } from '../dom-helpers.ts';
import { sectionHeadingCountState, sectionHeadingDescriptor } from './section-heading-core.ts';
import type { SectionHeadingCount, SectionHeadingLevel, SectionHeadingTone } from './section-heading-core.ts';

type SectionHeadingOptions = {
  title: string;
  level: SectionHeadingLevel;
  count?: SectionHeadingCount;
  tone?: SectionHeadingTone;
  hint?: string | null;
  actions?: readonly HTMLElement[];
};

type SectionHeading = {
  readonly element: HTMLDivElement;
  setCount(count: SectionHeadingCount): void;
};

export function sectionHeading({ title, level, count = null, tone = 'muted', hint = null, actions = [] }: SectionHeadingOptions): SectionHeading {
  const descriptor = sectionHeadingDescriptor({ level, count, tone });
  const element = el('div', descriptor.className);
  element.dataset.tone = descriptor.tone;
  const titleElement = el(descriptor.titleTag, descriptor.titleClassName, title);
  const countElement = el('span', descriptor.countClassName);
  element.append(titleElement, countElement);
  if (hint) element.append(el('span', descriptor.hintClassName, hint));
  if (actions.length > 0) {
    const actionsElement = el('div', descriptor.actionsClassName);
    actionsElement.append(...actions);
    element.append(actionsElement);
  }
  const setCount = (nextCount: SectionHeadingCount) => {
    const state = sectionHeadingCountState(nextCount);
    if (countElement.textContent !== state.text) countElement.textContent = state.text;
    countElement.hidden = state.hidden;
  };
  setCount(count);
  return { element, setCount };
}
