import { Cron } from 'croner';

import { decideWake } from './child-channel-core.ts';
import type { SessionState } from '../../shared/states.ts';
import type { Wake, WakeKind, WakeSchedule, WakeView } from '../../shared/contracts/wakes.ts';

interface WakeLimits {
  maxPendingPerSession: number;
  maxHorizonMs: number;
  cronExpiryMs: number;
  minCronIntervalMs: number;
}

interface OperatorWakeFacts {
  isOperatorFlagged: boolean;
  wakesSinceOperatorInput: number;
  msSinceOperatorInput: number;
}

interface DueWakeFacts extends OperatorWakeFacts {
  nowMs: number;
  sessionState: SessionState;
  isDelivering: boolean;
}

type ParsedWhen = { ok: true; schedule: WakeSchedule; nextFireAt: number } | { ok: false; reason: string };
type DueWakeDecision = { kind: 'wait'; untilMs: number } | { kind: 'flag-operator' } | { kind: 'type-line' };

interface FireTimeFormat {
  dayKeyOf(ms: number): string;
  hourMinuteOf(ms: number): string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const WAKE_RECHECK_MS = 30 * MS_PER_SECOND;
const SELF_WAKE_CAP_NOTE = 'Stopped waking this session: it woke itself or was woken 10 times with no input from you. Type in the session to let wakes resume.';

const DEFAULT_WAKE_LIMITS: WakeLimits = Object.freeze({
  maxPendingPerSession: 10,
  maxHorizonMs: 7 * MS_PER_DAY,
  cronExpiryMs: 7 * MS_PER_DAY,
  minCronIntervalMs: MS_PER_MINUTE,
});

const DURATION_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const CLOCK_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:\d{2})?$/;
const CRON_FIELD_COUNT = 5;

function nextRunsOf(pattern: string, timezone: string, afterMs: number, count: number): number[] | null {
  try {
    return new Cron(pattern, { timezone }).nextRuns(count, new Date(afterMs)).map((run) => run.getTime());
  } catch {
    return null;
  }
}

function nextCronFireAt(pattern: string, timezone: string, afterMs: number): number | null {
  return nextRunsOf(pattern, timezone, afterMs, 1)?.[0] ?? null;
}

function isCalendarDateTime(fields: readonly number[]): boolean {
  const [year, month, day, hour, minute, second] = fields;
  const asWritten = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return asWritten.getUTCFullYear() === year && asWritten.getUTCMonth() === month - 1 && asWritten.getUTCDate() === day
    && asWritten.getUTCHours() === hour && asWritten.getUTCMinutes() === minute && asWritten.getUTCSeconds() === second;
}

function parseDurationMs(when: string): number | null {
  const match = DURATION_PATTERN.exec(when.replaceAll(' ', '').toLowerCase());
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return days * MS_PER_DAY + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND;
}

function parseInWhen(when: string, nowMs: number): ParsedWhen {
  const delayMs = parseDurationMs(when);
  if (delayMs === null || delayMs <= 0) return { ok: false, reason: 'in needs a duration such as 30s, 15m, 2h or 1h30m' };
  const fireAt = nowMs + delayMs;
  return { ok: true, schedule: { kind: 'in', fireAt }, nextFireAt: fireAt };
}

function parseAtWhen(when: string, nowMs: number, timezone: string): ParsedWhen {
  const clockTime = CLOCK_TIME_PATTERN.exec(when);
  const dateTime = DATE_TIME_PATTERN.exec(when);
  if (!clockTime && !dateTime) return { ok: false, reason: 'at needs a clock time HH:MM or an ISO date-time such as 2026-11-12T09:00' };
  if (dateTime && !isCalendarDateTime(dateTime.slice(1).map((part) => Number(part ?? 0)))) return { ok: false, reason: `${when} is not a real date and time` };
  const pattern = clockTime ? `${Number(clockTime[2])} ${Number(clockTime[1])} * * *` : when;
  const runs = nextRunsOf(pattern, timezone, nowMs, 1);
  if (runs === null) return { ok: false, reason: `${when} is not a real date and time` };
  const fireAt = runs[0];
  if (fireAt === undefined) return { ok: false, reason: `${when} has already passed` };
  return { ok: true, schedule: { kind: 'at', fireAt }, nextFireAt: fireAt };
}

function parseCronWhen(when: string, nowMs: number, timezone: string, limits: WakeLimits): ParsedWhen {
  const fields = when.split(/\s+/);
  const isNickname = fields.length === 1 && when.startsWith('@');
  const pattern = fields.join(' ');
  const runs = isNickname || fields.length === CRON_FIELD_COUNT ? nextRunsOf(pattern, timezone, nowMs, 2) : null;
  if (runs === null) return { ok: false, reason: 'cron needs a pattern of five fields such as "0 9 * * 1-5", quoted so the shell keeps it whole' };
  const [firstRun, secondRun] = runs;
  if (firstRun === undefined) return { ok: false, reason: `the cron pattern ${pattern} never fires again` };
  if (secondRun !== undefined && secondRun - firstRun < limits.minCronIntervalMs) return { ok: false, reason: `a cron wake fires at most once every ${describeDelay(limits.minCronIntervalMs)}` };
  return { ok: true, schedule: { kind: 'cron', pattern, timezone }, nextFireAt: firstRun };
}

function parseWakeWhen(kind: WakeKind, when: string, nowMs: number, timezone: string, limits: WakeLimits): ParsedWhen {
  if (kind === 'in') return parseInWhen(when, nowMs);
  if (kind === 'at') return parseAtWhen(when, nowMs, timezone);
  return parseCronWhen(when, nowMs, timezone, limits);
}

function admitWake(pendingInSession: readonly Wake[], candidate: Pick<Wake, 'schedule' | 'setAt' | 'nextFireAt'>, limits: WakeLimits): { ok: true } | { ok: false; reason: string } {
  if (pendingInSession.length >= limits.maxPendingPerSession) {
    const pendingIds = pendingInSession.map((wake) => wake.id).join(', ');
    return { ok: false, reason: `this session already holds ${limits.maxPendingPerSession} pending wakes (${pendingIds}); cancel one first` };
  }
  const horizonMs = candidate.schedule.kind === 'cron' ? limits.cronExpiryMs : limits.maxHorizonMs;
  if (candidate.nextFireAt - candidate.setAt > horizonMs) return { ok: false, reason: `a wake must first fire within ${describeDelay(horizonMs)}` };
  return { ok: true };
}

function decideDueWake(wake: Wake, facts: DueWakeFacts): DueWakeDecision {
  if (wake.nextFireAt > facts.nowMs) return { kind: 'wait', untilMs: wake.nextFireAt };
  const recheckAt = facts.nowMs + WAKE_RECHECK_MS;
  const decision = decideWake({
    recipientState: facts.sessionState,
    hasUnread: true,
    isWakePending: facts.isDelivering,
    isOperatorFlagged: facts.isOperatorFlagged,
    wakesSinceOperatorInput: facts.wakesSinceOperatorInput,
    msSinceOperatorInput: facts.msSinceOperatorInput,
  });
  if (decision.kind === 'none') return { kind: 'wait', untilMs: recheckAt };
  if (decision.kind === 'hold') return { kind: 'wait', untilMs: facts.nowMs + decision.retryInMs };
  if (decision.kind === 'flag-operator') return { kind: 'flag-operator' };
  return { kind: 'type-line' };
}

function afterFire(wake: Wake, nowMs: number, limits: WakeLimits): Wake {
  if (wake.schedule.kind !== 'cron') return { ...wake, status: 'fired' };
  const nextFireAt = nextCronFireAt(wake.schedule.pattern, wake.schedule.timezone, nowMs);
  if (nextFireAt === null || nextFireAt - wake.setAt > limits.cronExpiryMs) return { ...wake, status: 'fired' };
  return { ...wake, nextFireAt, status: 'pending' };
}

function afterDelivery(wake: Wake, isSubmitted: boolean, nowMs: number, limits: WakeLimits): Wake {
  if (isSubmitted || wake.schedule.kind === 'cron') return afterFire(wake, nowMs, limits);
  return { ...wake, status: 'failed' };
}

function describeDelay(delayMs: number): string {
  if (delayMs < MS_PER_MINUTE) return `${Math.max(1, Math.round(delayMs / MS_PER_SECOND))}s`;
  const totalMinutes = Math.round(delayMs / MS_PER_MINUTE);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function describeFireTime(fireAtMs: number, nowMs: number, format: FireTimeFormat): string {
  const fireDay = format.dayKeyOf(fireAtMs);
  const dayWord = fireDay === format.dayKeyOf(nowMs) ? 'today' : fireDay === format.dayKeyOf(nowMs + MS_PER_DAY) ? 'tomorrow' : fireDay;
  const delay = fireAtMs > nowMs ? `in ${describeDelay(fireAtMs - nowMs)}` : 'due now';
  return `${format.hourMinuteOf(fireAtMs)} ${dayWord} (${delay})`;
}

function viewOfWake(wake: Wake, nowMs: number, format: FireTimeFormat): WakeView {
  return {
    id: wake.id,
    kind: wake.schedule.kind,
    pattern: wake.schedule.kind === 'cron' ? wake.schedule.pattern : null,
    text: wake.text,
    nextFireAt: wake.nextFireAt,
    nextFire: describeFireTime(wake.nextFireAt, nowMs, format),
  };
}

function describeWakeLine(wake: Wake, formatTime: (ms: number) => string): string {
  const cronPart = wake.schedule.kind === 'cron' ? `, cron ${wake.schedule.pattern}` : '';
  return `Glimmervoid wake ${wake.id} (you set it at ${formatTime(wake.setAt)}${cronPart}): ${wake.text}`;
}

export { admitWake, afterDelivery, decideDueWake, describeWakeLine, parseWakeWhen, viewOfWake, DEFAULT_WAKE_LIMITS, SELF_WAKE_CAP_NOTE, WAKE_RECHECK_MS };
export type { OperatorWakeFacts, WakeLimits };
