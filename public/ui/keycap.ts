import { el } from '../dom-helpers.ts';

type KeycapTone = 'neutral' | 'accent';

export function keycap(text: string, { tone = 'neutral' }: { tone?: KeycapTone } = {}): HTMLElement {
  const cap = el('kbd', 'ui-keycap', text);
  if (tone !== 'neutral') cap.dataset.tone = tone;
  return cap;
}

export function keyChord(keys: readonly string[]): HTMLElement {
  const chord = el('span', 'ui-key-chord');
  setKeyChordKeys(chord, keys);
  return chord;
}

export function setKeyChordKeys(chord: HTMLElement, keys: readonly string[]): void {
  chord.replaceChildren(...keys.flatMap((key, keyIndex) => keyIndex === 0 ? [keycap(key)] : [el('span', 'ui-key-chord-sep', '+'), keycap(key)]));
}
