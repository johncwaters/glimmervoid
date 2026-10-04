import { el } from './dom-helpers.ts';
import type { ShortcutContext } from './shortcuts-core.ts';
import { shortcutPlatformFor } from './shortcuts-core.ts';

export const SHORTCUT_PLATFORM = shortcutPlatformFor(navigator.userAgent);

let readShortcutContext = (): ShortcutContext => ({ isCalmAvailable: false, isCalmViewActive: false });

export function setShortcutContextProvider(provideShortcutContext: () => ShortcutContext) {
  readShortcutContext = provideShortcutContext;
}

export function currentShortcutContext() {
  return readShortcutContext();
}

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
