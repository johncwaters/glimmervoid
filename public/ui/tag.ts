import { el } from '../dom-helpers.ts';

type TagTone = 'muted' | 'neutral' | 'accent' | 'warning' | 'failed';
type TagShape = 'box' | 'pill';

type TagOptions = {
  text: string;
  tone?: TagTone;
  shape?: TagShape;
};

export function tag(options: TagOptions): HTMLSpanElement {
  const element = el('span', 'ui-tag', options.text);
  element.dataset.tone = options.tone ?? 'muted';
  element.dataset.shape = options.shape ?? 'box';
  return element;
}
