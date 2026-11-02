import { el, externalLink } from './dom-helpers.ts';
import { createPrStatusIcon } from './github/pr-status-icon.ts';
import { rankSignals, signalsSignature } from './signal-core.ts';
import type { RankedSignals, Signal } from './signal-core.ts';

interface SignalOptions {
  className?: string;
  linkUrl?: string;
  ariaLabel?: string;
  onActivate?: () => void;
}

export interface ActivatableSignal extends Signal, SignalOptions {}

export function createSignal(signal: Signal, { className = '', linkUrl, ariaLabel, onActivate }: SignalOptions = {}): HTMLElement {
  const signalClassName = `signal ${className}`.trim();
  const signalElement = linkUrl ? externalLink(signalClassName, '', linkUrl, signal.hoverText) : el('span', signalClassName);
  signalElement.title = signal.hoverText;
  if (ariaLabel) signalElement.setAttribute('aria-label', ariaLabel);
  if (signal.look) {
    signalElement.dataset.tone = signal.look.tone;
    signalElement.append(createPrStatusIcon(signal.look.icon, signal.look.tone));
  }
  signalElement.append(el('span', 'signal-text', signal.text));
  if (onActivate) makeSignalActivatable(signalElement, onActivate, !linkUrl);
  return signalElement;
}

function makeSignalActivatable(signalElement: HTMLElement, onActivate: () => void, needsKeyboardStop: boolean): void {
  signalElement.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onActivate();
  });
  if (needsKeyboardStop) {
    signalElement.tabIndex = 0;
    signalElement.setAttribute('role', 'button');
  }
  signalElement.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.stopPropagation();
    event.preventDefault();
    onActivate();
  });
}

function removeKeyboardStop(signalElement: HTMLElement): void {
  signalElement.removeAttribute('tabindex');
  signalElement.removeAttribute('role');
}

function removeNestedKeyboardStops(slot: HTMLElement, signalElements: readonly HTMLElement[]): void {
  if (!slot.closest('button, a[href]')) return;
  for (const signalElement of signalElements) {
    removeKeyboardStop(signalElement);
    for (const descendant of signalElement.querySelectorAll<HTMLElement>('[role="button"]')) removeKeyboardStop(descendant);
  }
}

function createSignalOverflow(ranked: RankedSignals<Signal>, onRevealOverflow: (() => void) | undefined): HTMLElement | null {
  if (ranked.overflowCount === 0) return null;
  const overflow = el('span', 'signal-overflow', `+${ranked.overflowCount}`);
  overflow.title = ranked.overflowHoverText;
  if (onRevealOverflow) makeSignalActivatable(overflow, onRevealOverflow, true);
  return overflow;
}

interface SignalLineOptions {
  visibleCount?: number;
  variant?: string;
  onRevealOverflow?: () => void;
}

export function paintSignalLine<Line extends ActivatableSignal>(
  slot: HTMLElement,
  signals: readonly Line[],
  buildSignal: (signal: Line) => HTMLElement = (signal) => createSignal(signal, signal),
  { visibleCount, variant = '', onRevealOverflow }: SignalLineOptions = {},
): void {
  const signature = `${variant}\n${signalsSignature(signals)}`;
  if (slot.dataset.signalSignature === signature) return;
  slot.dataset.signalSignature = signature;
  const ranked = rankSignals(signals, visibleCount);
  const signalElements = ranked.visible.map(buildSignal);
  const overflow = createSignalOverflow(ranked, onRevealOverflow);
  if (overflow) signalElements.push(overflow);
  removeNestedKeyboardStops(slot, signalElements);
  slot.hidden = signalElements.length === 0;
  slot.replaceChildren(...signalElements);
}
