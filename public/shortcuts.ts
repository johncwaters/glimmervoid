import type { DashboardShortcutAction } from './shortcuts-core.ts';
import { shortcutChord, shortcutPlatformFor } from './shortcuts-core.ts';
import { getNextAttentionKeyCode } from './ui-prefs.ts';
import { keyChord, setKeyChordKeys } from './ui/keycap.ts';

type ClaimedKeyAction = Extract<DashboardShortcutAction, 'show-board-change' | 'shell-focus'>;

const keyClaimTestByAction = new Map<ClaimedKeyAction, () => boolean>();

export function setKeyClaimTest(action: ClaimedKeyAction, claimTest: () => boolean) {
  keyClaimTestByAction.set(action, claimTest);
}

export function canClaimTerminalKey(action: DashboardShortcutAction) {
  if (action !== 'show-board-change' && action !== 'shell-focus') return true;
  return keyClaimTestByAction.get(action)?.() ?? false;
}

export const SHORTCUT_PLATFORM = shortcutPlatformFor(navigator.userAgent);

const NEXT_ATTENTION_KEYS_CLASS = 'next-attention-keys';

let nextAttentionKeyCode = getNextAttentionKeyCode();

export function currentNextAttentionKeyCode() {
  return nextAttentionKeyCode;
}

export function buildShortcutKeys(chord: readonly string[]) {
  const keys = keyChord(chord);
  keys.classList.add('shortcut-keys');
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
    setKeyChordKeys(keys, chord);
  }
}
