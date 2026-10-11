import { isSoundEnabled, setSoundEnabled } from './ui-prefs.ts';

let muteButton: HTMLButtonElement | null = null;
const soundEnabledListeners = new Set<(enabled: boolean) => void>();

function syncMuteButton(): void {
  muteButton?.setAttribute('aria-pressed', String(!isSoundEnabled()));
}

export function applySoundEnabled(enabled: boolean): void {
  setSoundEnabled(enabled);
  syncMuteButton();
  for (const listener of soundEnabledListeners) listener(enabled);
}

export function onSoundEnabledChange(listener: (enabled: boolean) => void): void {
  soundEnabledListeners.add(listener);
}

export function mountMuteButton(button: HTMLButtonElement): void {
  muteButton = button;
  syncMuteButton();
  button.addEventListener('click', () => applySoundEnabled(!isSoundEnabled()));
}
