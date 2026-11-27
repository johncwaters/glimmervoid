import { el } from '../dom-helpers.ts';
import { keyChordParts, keycapDescriptor } from './keycap-core.ts';
import type { KeycapTone } from './keycap-core.ts';

export function keycap(text: string, { tone = 'neutral' }: { tone?: KeycapTone } = {}): HTMLElement {
  const descriptor = keycapDescriptor(text, { tone });
  const cap = el('kbd', descriptor.className, descriptor.text);
  if (descriptor.tone) cap.dataset.tone = descriptor.tone;
  return cap;
}

export function keyChord(keys: readonly string[]): HTMLElement {
  const chord = el('span', 'ui-key-chord');
  setKeyChordKeys(chord, keys);
  return chord;
}

export function setKeyChordKeys(chord: HTMLElement, keys: readonly string[]): void {
  chord.replaceChildren(...keyChordParts(keys).map((part) => (
    part.kind === 'key' ? keycap(part.text) : el('span', part.className, part.text)
  )));
}
