import { createEffect, createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { meterDescriptor } from './meter-core.ts';
import type { MeterThickness, MeterTone } from './meter-core.ts';

type MeterProps = {
  value: number;
  label?: string;
  valueText?: string;
  tone?: MeterTone;
  thickness?: MeterThickness;
};

function syncOptionalAttribute(element: HTMLElement, name: string, value: string | undefined): void {
  if (value !== undefined) {
    element.setAttribute(name, value);
    return;
  }
  element.removeAttribute(name);
}

function applyMeterDom(element: HTMLSpanElement | null, current: ReturnType<typeof meterDescriptor>): void {
  if (!element) return;
  element.style.setProperty('--meter-value', current.cssValue);
  syncOptionalAttribute(element, 'role', current.role);
  syncOptionalAttribute(element, 'aria-label', current.ariaLabel);
  syncOptionalAttribute(element, 'aria-valuemin', current.ariaValueMin);
  syncOptionalAttribute(element, 'aria-valuemax', current.ariaValueMax);
  syncOptionalAttribute(element, 'aria-valuenow', current.ariaValueNow);
  syncOptionalAttribute(element, 'aria-valuetext', current.ariaValueText);
  syncOptionalAttribute(element, 'aria-hidden', current.ariaHidden);
}

export function Meter(props: MeterProps): JSX.Element {
  const [rootElement, setRootElement] = createSignal<HTMLSpanElement | null>(null);
  const descriptor = createMemo(() => meterDescriptor({
    value: props.value,
    label: props.label,
    valueText: props.valueText,
    tone: props.tone,
    thickness: props.thickness,
  }));

  createEffect(
    () => ({ element: rootElement(), current: descriptor() }),
    ({ element, current }) => applyMeterDom(element, current),
  );

  return (
    <span
      ref={(element) => {
        setRootElement(element);
        applyMeterDom(element, descriptor());
      }}
      class={descriptor().className}
      data-thickness={descriptor().thickness}
      data-tone={descriptor().tone}
    >
      <span class={descriptor().fillClassName} />
    </span>
  );
}
