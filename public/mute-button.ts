import { isSoundEnabled, setSoundEnabled } from './ui-prefs.ts';

let muteButton: HTMLButtonElement | null = null;

function syncMuteButton(): void {
  muteButton?.setAttribute('aria-pressed', String(!isSoundEnabled()));
}

export function applySoundEnabled(enabled: boolean): void {
  setSoundEnabled(enabled);
  syncMuteButton();
}

export function mountMuteButton(button: HTMLButtonElement): void {
  muteButton = button;
  syncMuteButton();
  button.addEventListener('click', () => applySoundEnabled(!isSoundEnabled()));
}
