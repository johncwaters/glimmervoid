import { el } from '../dom-helpers.ts';

export type MeterTone = 'accent' | 'muted' | 'waiting' | 'failed';
type MeterThickness = 'hair' | 'thin' | 'default' | 'thick';

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
  const element = el('span', 'ui-meter');
  element.dataset.thickness = options.thickness ?? 'default';
  element.append(el('span', 'ui-meter-fill'));
  const label = options.label;
  if (label !== undefined) {
    element.setAttribute('role', 'meter');
    element.setAttribute('aria-label', label);
    element.setAttribute('aria-valuemin', '0');
    element.setAttribute('aria-valuemax', '100');
  }
  if (label === undefined) element.setAttribute('aria-hidden', 'true');

  const setValue = (value: number, valueText?: string) => {
    const fraction = clampFraction(value);
    element.style.setProperty('--meter-value', String(fraction));
    if (label === undefined) return;
    element.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    if (valueText) element.setAttribute('aria-valuetext', valueText);
    if (!valueText) element.removeAttribute('aria-valuetext');
  };
  const setTone = (tone: MeterTone) => {
    element.dataset.tone = tone;
  };

  setTone(options.tone ?? 'accent');
  setValue(options.value, options.valueText);
  return { element, setValue, setTone };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
