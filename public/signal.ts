import { el, externalLink } from './dom-helpers.ts';
import { createPrStatusIcon } from './github/pr-status-icon.ts';
import { rankSignals, signalsSignature } from './signal-core.ts';
import type { RankedSignals, Signal } from './signal-core.ts';

interface SignalOptions {
  className?: string;
  linkUrl?: string;
  onActivate?: () => void;
}

export interface ActivatableSignal extends Signal, SignalOptions {}

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

function createSignalOverflow(ranked: RankedSignals<Signal>): HTMLElement | null {
  if (ranked.overflowCount === 0) return null;
  const overflow = el('span', 'signal-overflow', `+${ranked.overflowCount}`);
  overflow.title = ranked.overflowHoverText;
  return overflow;
}

export function paintSignalLine<Line extends ActivatableSignal>(slot: HTMLElement, signals: readonly Line[], buildSignal: (signal: Line) => HTMLElement = (signal) => createSignal(signal, signal)): void {
  const signature = signalsSignature(signals);
  if (slot.dataset.signalSignature === signature) return;
  slot.dataset.signalSignature = signature;
  const ranked = rankSignals(signals);
  const signalElements = ranked.visible.map(buildSignal);
  const overflow = createSignalOverflow(ranked);
  if (overflow) signalElements.push(overflow);
  slot.hidden = signalElements.length === 0;
  slot.replaceChildren(...signalElements);
}
