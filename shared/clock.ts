type Moment = number | Date;
type ClockStyle = 'hour-minute' | 'hour-minute-second';

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface Clock {
  nowMs(): number;
  now(): Date;
  timezone(): string;
  partsOf(moment: Moment, inTimezone?: string): WallClockParts;
  dayKeyOf(moment: Moment, inTimezone?: string): string;
  hourOf(moment: Moment): number;
  startOfDay(ms: number, daysAgo?: number): number;
  format(moment: Moment, style: ClockStyle): string;
}

interface ClockOptions {
  timezone: () => string;
  nowMs?: () => number;
}

const MS_PER_SECOND = 1000;
const partsFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isKnownTimezone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (partsFormatterByTimezone.has(candidate)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

function systemTimezone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function partsFormatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = partsFormatterByTimezone.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  partsFormatterByTimezone.set(timezone, formatter);
  return formatter;
}

function wallClockPartsIn(timezone: string, moment: Moment): WallClockParts {
  const parts: WallClockParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of partsFormatterFor(timezone).formatToParts(moment)) {
    if (part.type in parts) parts[part.type as keyof WallClockParts] = Number(part.value);
  }
  return parts;
}

function offsetMsIn(timezone: string, ms: number): number {
  const parts = wallClockPartsIn(timezone, ms);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND;
}

function createClock(options: ClockOptions): Clock {
  const readNowMs = options.nowMs ?? (() => Date.now());

  function timezone(): string {
    const configured = options.timezone();
    if (isKnownTimezone(configured)) return configured;
    return systemTimezone();
  }

  function zoneOrOperator(inTimezone: string | undefined): string {
    if (isKnownTimezone(inTimezone)) return inTimezone;
    return timezone();
  }

  function partsOf(moment: Moment, inTimezone?: string): WallClockParts {
    return wallClockPartsIn(zoneOrOperator(inTimezone), moment);
  }

  function dayKeyOf(moment: Moment, inTimezone?: string): string {
    const parts = partsOf(moment, inTimezone);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function startOfDay(ms: number, daysAgo = 0): number {
    const zone = timezone();
    const parts = wallClockPartsIn(zone, ms);
    const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day - daysAgo);
    const firstGuess = midnightAsUtc - offsetMsIn(zone, midnightAsUtc);
    return midnightAsUtc - offsetMsIn(zone, firstGuess);
  }

  function format(moment: Moment, style: ClockStyle): string {
    const parts = partsOf(moment);
    const hourMinute = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
    if (style === 'hour-minute') return hourMinute;
    return `${hourMinute}:${pad2(parts.second)}`;
  }

  return {
    nowMs: readNowMs,
    now: () => new Date(readNowMs()),
    timezone,
    partsOf,
    dayKeyOf,
    hourOf: (moment) => partsOf(moment).hour,
    startOfDay,
    format,
  };
}

let operatorTimezoneSource: () => string | null | undefined = () => null;

function setOperatorTimezoneSource(source: () => string | null | undefined): void {
  operatorTimezoneSource = source;
}

const clock: Clock = createClock({ timezone: () => operatorTimezoneSource() ?? systemTimezone() });

export { clock, isKnownTimezone, setOperatorTimezoneSource, systemTimezone };
export type { Clock };
