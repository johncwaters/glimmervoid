import { el } from './dom-helpers.ts';
import { shortcutPlatformFor } from './shortcuts-core.ts';

export const SHORTCUT_PLATFORM = shortcutPlatformFor(navigator.userAgent);

export function appendShortcutChord(container: HTMLElement, chord: readonly string[]) {
  chord.forEach((caption, keyIndex) => {
    if (keyIndex > 0) container.appendChild(el('span', 'shortcut-sep', '+'));
    container.appendChild(el('kbd', 'kbd', caption));
  });
}

export function buildShortcutKeys(chord: readonly string[]) {
  const keys = el('span', 'shortcut-keys');
  appendShortcutChord(keys, chord);
  return keys;
}
