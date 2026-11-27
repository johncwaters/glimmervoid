import { el } from '../dom-helpers.ts';
import { tagDescriptor } from './tag-core.ts';
import type { TagShape, TagTone } from './tag-core.ts';

type TagOptions = {
  text: string;
  tone?: TagTone;
  shape?: TagShape;
};

export function tag(options: TagOptions): HTMLSpanElement {
  const descriptor = tagDescriptor(options);
  const element = el('span', descriptor.className, descriptor.text);
  element.dataset.tone = descriptor.tone;
  element.dataset.shape = descriptor.shape;
  return element;
}
