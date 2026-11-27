import { el } from '../dom-helpers.ts';
import { meterDescriptor, meterValueState } from './meter-core.ts';
import type { MeterThickness, MeterTone } from './meter-core.ts';

export type { MeterTone };

type MeterOptions = {
  value: number;
  label?: string;
  valueText?: string;
  tone?: MeterTone;
  thickness?: MeterThickness;
};

type Meter = {
  readonly element: HTMLSpanElement;
  setValue(value: number, valueText?: string): void;
  setTone(tone: MeterTone): void;
};

export function meter(options: MeterOptions): Meter {
  const descriptor = meterDescriptor(options);
  const element = el('span', descriptor.className);
  element.dataset.thickness = descriptor.thickness;
  element.append(el('span', descriptor.fillClassName));
  const label = options.label;
  if (descriptor.role) {
    element.setAttribute('role', descriptor.role);
    element.setAttribute('aria-label', descriptor.ariaLabel ?? '');
    element.setAttribute('aria-valuemin', descriptor.ariaValueMin ?? '0');
    element.setAttribute('aria-valuemax', descriptor.ariaValueMax ?? '100');
  }
  if (descriptor.ariaHidden) element.setAttribute('aria-hidden', descriptor.ariaHidden);

  const setValue = (value: number, valueText?: string) => {
    const state = meterValueState(value, label, valueText);
    element.style.setProperty('--meter-value', state.cssValue);
    if (label === undefined) return;
    if (state.ariaValueNow !== undefined) element.setAttribute('aria-valuenow', state.ariaValueNow);
    if (state.ariaValueText) element.setAttribute('aria-valuetext', state.ariaValueText);
    if (!state.ariaValueText) element.removeAttribute('aria-valuetext');
  };
  const setTone = (tone: MeterTone) => {
    element.dataset.tone = tone;
  };

  setTone(descriptor.tone);
  setValue(options.value, options.valueText);
  return { element, setValue, setTone };
}
