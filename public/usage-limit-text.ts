import { clock } from '#shared/clock.ts';

export function resetClockText(resetsAtMs: number): string {
  const { hour, minute } = clock.partsOf(resetsAtMs);
  const meridiem = hour < 12 ? 'am' : 'pm';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  if (minute === 0) return `${twelveHour}${meridiem}`;
  return `${twelveHour}:${String(minute).padStart(2, '0')}${meridiem}`;
}
