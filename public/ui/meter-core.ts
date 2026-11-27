export type MeterTone = 'accent' | 'muted' | 'waiting' | 'failed';
export type MeterThickness = 'hair' | 'thin' | 'default' | 'thick';

type MeterDescriptorInput = {
  value: number;
  label?: string;
  valueText?: string;
  tone?: MeterTone;
  thickness?: MeterThickness;
};

type MeterValueState = {
  fraction: number;
  cssValue: string;
  ariaValueNow?: string;
  ariaValueText?: string;
};

type MeterDescriptor = MeterValueState & {
  className: 'ui-meter';
  fillClassName: 'ui-meter-fill';
  thickness: MeterThickness;
  tone: MeterTone;
  role?: 'meter';
  ariaLabel?: string;
  ariaValueMin?: '0';
  ariaValueMax?: '100';
  ariaHidden?: 'true';
};

export function clampMeterFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

export function meterValueState(value: number, label?: string, valueText?: string): MeterValueState {
  const fraction = clampMeterFraction(value);
  const cssValue = String(fraction);
  if (label === undefined) return { fraction, cssValue };
  return {
    fraction,
    cssValue,
    ariaValueNow: String(Math.round(fraction * 100)),
    ariaValueText: valueText || undefined,
  };
}

export function meterDescriptor(input: MeterDescriptorInput): MeterDescriptor {
  const valueState = meterValueState(input.value, input.label, input.valueText);
  if (input.label === undefined) {
    return {
      ...valueState,
      className: 'ui-meter',
      fillClassName: 'ui-meter-fill',
      thickness: input.thickness ?? 'default',
      tone: input.tone ?? 'accent',
      ariaHidden: 'true',
    };
  }
  return {
    ...valueState,
    className: 'ui-meter',
    fillClassName: 'ui-meter-fill',
    thickness: input.thickness ?? 'default',
    tone: input.tone ?? 'accent',
    role: 'meter',
    ariaLabel: input.label,
    ariaValueMin: '0',
    ariaValueMax: '100',
  };
}
