import type { OutlineIconButton } from './ui/button.ts';
import { isSoundEnabled, setSoundEnabled } from './ui-prefs.ts';

let muteToggle: OutlineIconButton<'off'> | null = null;
const soundEnabledListeners = new Set<(enabled: boolean) => void>();

function syncMuteButton(): void {
  muteToggle?.setState(isSoundEnabled() ? 'idle' : 'off');
}

export function applySoundEnabled(enabled: boolean): void {
  setSoundEnabled(enabled);
  syncMuteButton();
  for (const listener of soundEnabledListeners) listener(enabled);
}

export function onSoundEnabledChange(listener: (enabled: boolean) => void): void {
  soundEnabledListeners.add(listener);
}

export function mountMuteButton(toggle: OutlineIconButton<'off'>): void {
  muteToggle = toggle;
  syncMuteButton();
  toggle.element.addEventListener('click', () => applySoundEnabled(!isSoundEnabled()));
}
