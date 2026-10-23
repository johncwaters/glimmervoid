import { el } from './dom-helpers.ts';
import { shortcutChord, shortcutPlatformFor } from './shortcuts-core.ts';
import { getNextAttentionKeyCode } from './ui-prefs.ts';

export const SHORTCUT_PLATFORM = shortcutPlatformFor(navigator.userAgent);

const NEXT_ATTENTION_KEYS_CLASS = 'next-attention-keys';

let nextAttentionKeyCode = getNextAttentionKeyCode();

export function currentNextAttentionKeyCode() {
  return nextAttentionKeyCode;
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

export function buildNextAttentionKeys() {
  const keys = buildShortcutKeys(shortcutChord('next-attention', SHORTCUT_PLATFORM, nextAttentionKeyCode));
  keys.classList.add(NEXT_ATTENTION_KEYS_CLASS);
  return keys;
}

export function applyNextAttentionKeyCode(keyCode: string) {
  nextAttentionKeyCode = keyCode;
  const chord = shortcutChord('next-attention', SHORTCUT_PLATFORM, keyCode);
  for (const keys of document.querySelectorAll<HTMLElement>(`.${NEXT_ATTENTION_KEYS_CLASS}`)) {
    keys.replaceChildren();
    appendShortcutChord(keys, chord);
  }
}
