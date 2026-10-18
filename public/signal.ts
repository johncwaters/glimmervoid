import { el, externalLink } from './dom-helpers.ts';
import { createPrStatusIcon } from './github/pr-status-icon.ts';
import type { RankedSignals, Signal } from './signal-core.ts';

interface SignalOptions {
  className?: string;
  linkUrl?: string;
  onActivate?: () => void;
}

export function createSignal(signal: Signal, { className = '', linkUrl, onActivate }: SignalOptions = {}): HTMLElement {
  const signalClassName = `signal ${className}`.trim();
  const signalElement = linkUrl ? externalLink(signalClassName, '', linkUrl, signal.hoverText) : el('span', signalClassName);
  signalElement.title = signal.hoverText;
  if (signal.look) {
    signalElement.dataset.tone = signal.look.tone;
    signalElement.append(createPrStatusIcon(signal.look.icon, signal.look.tone));
  }
  signalElement.append(signal.text);
  if (onActivate) {
    signalElement.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.defaultPrevented) return;
      event.preventDefault();
      onActivate();
    });
  }
  return signalElement;
}

export function createSignalOverflow(ranked: RankedSignals<Signal>): HTMLElement | null {
  if (ranked.overflowCount === 0) return null;
  const overflow = el('span', 'signal-overflow', `+${ranked.overflowCount}`);
  overflow.title = ranked.overflowHoverText;
  return overflow;
}
