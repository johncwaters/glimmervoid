export type SecondsRounding = 'floor' | 'round';

export type ElapsedUnitWording = 'compact' | 'abbreviated' | 'spelled';

export interface ElapsedTextOptions {
  rounding: SecondsRounding;
  wording: ElapsedUnitWording;
  suffix: string;
  justNowBelowSeconds: number;
}

export type ByteSizeLargestUnit = 'KB' | 'GB';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

const UNIT_WORDS: Record<ElapsedUnitWording, Record<'second' | 'minute' | 'hour' | 'day', (count: number) => string>> = {
  compact: {
    second: (count) => `${count}s`,
    minute: (count) => `${count}m`,
    hour: (count) => `${count}h`,
    day: (count) => `${count}d`,
  },
  abbreviated: {
    second: (count) => `${count} sec`,
    minute: (count) => `${count} min`,
    hour: (count) => `${count} hr`,
    day: (count) => `${count} ${count === 1 ? 'day' : 'days'}`,
  },
  spelled: {
    second: (count) => `${count} ${count === 1 ? 'second' : 'seconds'}`,
    minute: (count) => `${count} ${count === 1 ? 'minute' : 'minutes'}`,
    hour: (count) => `${count} ${count === 1 ? 'hour' : 'hours'}`,
    day: (count) => `${count} ${count === 1 ? 'day' : 'days'}`,
  },
};

export const COMPACT_FLOORED_AGO: ElapsedTextOptions = { rounding: 'floor', wording: 'compact', suffix: ' ago', justNowBelowSeconds: 0 };

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function wholeSeconds(elapsedMs: number, rounding: SecondsRounding): number {
  return Math.max(0, Math[rounding](elapsedMs / 1000));
}

function largestUnitText(totalSeconds: number, wording: ElapsedUnitWording): string {
  const words = UNIT_WORDS[wording];
  if (totalSeconds < SECONDS_PER_MINUTE) return words.second(totalSeconds);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (minutes < 60) return words.minute(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < HOURS_PER_DAY) return words.hour(hours);
  return words.day(Math.floor(hours / HOURS_PER_DAY));
}

export function elapsedText(elapsedMs: number, options: ElapsedTextOptions): string {
  const totalSeconds = wholeSeconds(elapsedMs, options.rounding);
  if (totalSeconds < options.justNowBelowSeconds) return 'just now';
  return `${largestUnitText(totalSeconds, options.wording)}${options.suffix}`;
}

export function twoUnitDurationText(totalSeconds: number, { smallestUnit, dropsZeroRemainder }: { smallestUnit: 's' | 'm'; dropsZeroRemainder: boolean }): string {
  const withRemainder = (lead: string, remainder: number, unit: string) => (dropsZeroRemainder && remainder === 0 ? lead : `${lead} ${remainder}${unit}`);
  if (smallestUnit === 's' && totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  if (smallestUnit === 's' && totalSeconds < SECONDS_PER_HOUR) return withRemainder(`${Math.floor(totalSeconds / SECONDS_PER_MINUTE)}m`, totalSeconds % SECONDS_PER_MINUTE, 's');
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return withRemainder(`${Math.floor(totalMinutes / 60)}h`, totalMinutes % 60, 'm');
}

export function clockDurationText(elapsedMs: number, { rounding, showsHours }: { rounding: SecondsRounding; showsHours: boolean }): string {
  const totalSeconds = wholeSeconds(elapsedMs, rounding);
  const seconds = pad2(totalSeconds % SECONDS_PER_MINUTE);
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  if (!showsHours || hours === 0) return `${totalMinutes}:${seconds}`;
  return `${hours}:${pad2(totalMinutes % 60)}:${seconds}`;
}

export function byteSizeText(byteCount: number, largestUnit: ByteSizeLargestUnit): string {
  if (byteCount < BYTES_PER_KB) return `${byteCount} B`;
  if (largestUnit === 'KB' || byteCount < BYTES_PER_MB) return `${(byteCount / BYTES_PER_KB).toFixed(1)} KB`;
  if (byteCount < BYTES_PER_GB) return `${(byteCount / BYTES_PER_MB).toFixed(1)} MB`;
  return `${(byteCount / BYTES_PER_GB).toFixed(2)} GB`;
}

export function localDayKey(moment: Date | number): string {
  const date = new Date(moment);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localHourMinuteText(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function localClockText(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
