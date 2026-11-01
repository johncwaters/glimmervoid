import { localDayKey } from '../../../shared/display-text.ts';
import type { YourDay, YourDayInsight } from '../../../shared/contracts/your-day.ts';
import { parseJsonRecord } from '../../core/json-core.ts';
import { startOfLocalDay } from './usage-aggregate-core.ts';

type ActivityKind = 'prompt' | 'turnEnd';

interface ActivityEvent {
  vendor: string;
  sessionId: string;
  ts: number;
  kind: ActivityKind;
}

interface ParsedActivity {
  sessionId: string | null;
  ts: number;
  kind: ActivityKind;
}

interface ReplySample {
  ts: number;
  waitingDepth: number;
  replyMs: number;
}

interface DayStats {
  day: string;
  sessionCount: number;
  activeMs: number;
  longestStretchMs: number;
  peakWaiting: number;
  peakJuggling: number;
  peakJugglingAt: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BREAK_MS = 15 * MINUTE_MS;
const BASELINE_DAYS = 14;
const MIN_ACTIVE_DAYS = 3;
const JUGGLING_WINDOW_MS = 30 * MINUTE_MS;
const MIN_SAMPLES_PER_SIDE = 3;
const MIN_SAMPLES_PER_WINDOW = 5;
const SHARP_WINDOW_HOURS = 3;
const MIN_DEVIATION = 1.2;
const MIN_LONG_STRETCH_MS = 90 * MINUTE_MS;
const MIN_JUGGLING_SESSIONS = 5;
const MAX_INSIGHTS = 3;
const LANE_OF_INTERACTIVE_SESSIONS = 'interactive';

function timestampOf(value: unknown): number | null {
  const parsedMs = Date.parse(String(value));
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

function isHumanPromptContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() !== '' && !content.startsWith('<local-command') && !content.startsWith('<task-notification');
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text');
}

function isFromOperator(record: Record<string, unknown>): boolean {
  if (record.entrypoint === 'sdk-cli') return false;
  const origin = record.origin as { kind?: unknown } | null | undefined;
  const turnOrigin = record.turnOrigin as { kind?: unknown } | string | null | undefined;
  const originKinds = [turnOrigin, origin?.kind, typeof turnOrigin === 'object' ? turnOrigin?.kind : undefined].filter((kind) => typeof kind === 'string');
  return originKinds.every((kind) => kind === 'human');
}

function parseClaudeActivityLine(line: string): ParsedActivity | null {
  if (!line.includes('"type":"user"') && !line.includes('"end_turn"')) return null;
  const record = parseJsonRecord(line);
  if (!record || record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true || !isFromOperator(record)) return null;
  const ts = timestampOf(record.timestamp);
  if (ts === null) return null;
  const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : null;
  if (!message) return null;
  const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null;
  if (record.type === 'assistant' && message.stop_reason === 'end_turn') return { sessionId, ts, kind: 'turnEnd' };
  if (record.type === 'user' && isHumanPromptContent(message.content)) return { sessionId, ts, kind: 'prompt' };
  return null;
}

function parseCodexActivityLine(line: string): ParsedActivity | null {
  if (!line.includes('"user_message"') && !line.includes('"task_complete"')) return null;
  const record = parseJsonRecord(line);
  if (record?.type !== 'event_msg') return null;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : null;
  const ts = timestampOf(record.timestamp);
  if (!payload || ts === null) return null;
  if (payload.type === 'user_message') return { sessionId: null, ts, kind: 'prompt' };
  if (payload.type === 'task_complete') return { sessionId: null, ts, kind: 'turnEnd' };
  return null;
}

function activityKey(event: ActivityEvent): string {
  return `${event.vendor}:${event.sessionId}:${event.ts}:${event.kind}`;
}

function isLaneSession(event: ActivityEvent, laneByKey: ReadonlyMap<string, string> | null): boolean {
  const lane = laneByKey?.get(`${event.vendor}:${event.sessionId}`);
  return lane !== undefined && lane !== LANE_OF_INTERACTIVE_SESSIONS;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hourText(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`;
}

function durationText(ms: number): string {
  const totalMinutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function ratioText(ratio: number): string {
  return `${ratio.toFixed(1)}x`;
}

function splitStretches(promptTimes: readonly number[]): Array<{ start: number; end: number }> {
  const stretches: Array<{ start: number; end: number }> = [];
  for (const ts of promptTimes) {
    const current = stretches.at(-1);
    if (current && ts - current.end <= BREAK_MS) {
      current.end = ts;
      continue;
    }
    stretches.push({ start: ts, end: ts });
  }
  return stretches;
}

function stretchStartAt(stretches: ReadonlyArray<{ start: number; end: number }>, ts: number): number | null {
  const containing = stretches.find((stretch) => stretch.start <= ts && ts <= stretch.end);
  return containing ? containing.start : null;
}

function collectReplySamples(events: readonly ActivityEvent[], stretches: ReadonlyArray<{ start: number; end: number }>): ReplySample[] {
  const waitingSinceBySession = new Map<string, number>();
  const samples: ReplySample[] = [];
  for (const event of events) {
    if (event.kind === 'turnEnd') {
      waitingSinceBySession.set(event.sessionId, event.ts);
      continue;
    }
    const stretchStart = stretchStartAt(stretches, event.ts) ?? event.ts;
    for (const [sessionId, since] of waitingSinceBySession) {
      if (since < stretchStart) waitingSinceBySession.delete(sessionId);
    }
    const waitingSince = waitingSinceBySession.get(event.sessionId);
    const waitingDepth = waitingSinceBySession.size;
    waitingSinceBySession.delete(event.sessionId);
    if (waitingSince === undefined) continue;
    samples.push({ ts: event.ts, waitingDepth, replyMs: event.ts - waitingSince });
  }
  return samples;
}

function peakJugglingOf(prompts: readonly ActivityEvent[]): { count: number; at: number } {
  let peak = { count: 0, at: 0 };
  let windowStartIndex = 0;
  const promptCountBySession = new Map<string, number>();
  for (const prompt of prompts) {
    promptCountBySession.set(prompt.sessionId, (promptCountBySession.get(prompt.sessionId) ?? 0) + 1);
    while (prompt.ts - prompts[windowStartIndex].ts > JUGGLING_WINDOW_MS) {
      const leaving = prompts[windowStartIndex];
      const remaining = (promptCountBySession.get(leaving.sessionId) ?? 1) - 1;
      if (remaining === 0) promptCountBySession.delete(leaving.sessionId);
      if (remaining > 0) promptCountBySession.set(leaving.sessionId, remaining);
      windowStartIndex += 1;
    }
    if (promptCountBySession.size > peak.count) peak = { count: promptCountBySession.size, at: prompt.ts };
  }
  return peak;
}

function dayStatsOf(day: string, dayEvents: readonly ActivityEvent[]): DayStats {
  const prompts = dayEvents.filter((event) => event.kind === 'prompt');
  const stretches = splitStretches(prompts.map((prompt) => prompt.ts));
  const longest = stretches.reduce((best, stretch) => (stretch.end - stretch.start > best.end - best.start ? stretch : best), stretches[0] ?? { start: 0, end: 0 });
  const replySamples = collectReplySamples(dayEvents, stretches);
  const juggling = peakJugglingOf(prompts);
  return {
    day,
    sessionCount: new Set(prompts.map((prompt) => prompt.sessionId)).size,
    activeMs: stretches.reduce((total, stretch) => total + stretch.end - stretch.start, 0),
    longestStretchMs: longest.end - longest.start,
    peakWaiting: replySamples.reduce((peak, sample) => Math.max(peak, sample.waitingDepth), 0),
    peakJuggling: juggling.count,
    peakJugglingAt: juggling.at,
  };
}

function waitingThresholdInsight(samples: readonly ReplySample[]): YourDayInsight | null {
  for (let threshold = 2; threshold <= 8; threshold += 1) {
    const calm = samples.filter((sample) => sample.waitingDepth <= threshold).map((sample) => sample.replyMs);
    const crowded = samples.filter((sample) => sample.waitingDepth > threshold).map((sample) => sample.replyMs);
    if (calm.length < MIN_SAMPLES_PER_SIDE || crowded.length < MIN_SAMPLES_PER_SIDE) continue;
    const slowdown = median(crowded) / Math.max(median(calm), 1);
    if (slowdown < 2) continue;
    return { kind: 'waitingThreshold', text: `Replies took ${ratioText(slowdown)} longer once more than ${threshold} sessions waited on you.`, deviation: slowdown };
  }
  return null;
}

function sharpestHoursInsight(samples: readonly ReplySample[]): YourDayInsight | null {
  const overallMedian = median(samples.map((sample) => sample.replyMs));
  let best: { startHour: number; medianMs: number } | null = null;
  for (let startHour = 0; startHour < 24; startHour += 1) {
    const inWindow = samples.filter((sample) => {
      const hour = new Date(sample.ts).getHours();
      return (hour - startHour + 24) % 24 < SHARP_WINDOW_HOURS;
    });
    if (inWindow.length < MIN_SAMPLES_PER_WINDOW) continue;
    const windowMedian = median(inWindow.map((sample) => sample.replyMs));
    if (!best || windowMedian < best.medianMs) best = { startHour, medianMs: windowMedian };
  }
  if (!best) return null;
  const quickness = overallMedian / Math.max(best.medianMs, 1);
  if (quickness < MIN_DEVIATION) return null;
  return { kind: 'sharpestHours', text: `You replied to agents fastest ${hourText(best.startHour)} to ${hourText(best.startHour + SHARP_WINDOW_HOURS)}, ${ratioText(quickness)} your usual pace.`, deviation: quickness };
}

function longestStretchInsight(yesterday: DayStats, usualStretchMs: number): YourDayInsight | null {
  if (yesterday.longestStretchMs < MIN_LONG_STRETCH_MS) return null;
  const deviation = yesterday.longestStretchMs / Math.max(usualStretchMs, MINUTE_MS);
  if (deviation < MIN_DEVIATION) return null;
  const comparedToUsual = usualStretchMs >= MINUTE_MS ? `, ${ratioText(deviation)} your usual` : '';
  return { kind: 'longestStretch', text: `Yesterday you went ${durationText(yesterday.longestStretchMs)} without a break${comparedToUsual}.`, deviation };
}

function jugglingInsight(yesterday: DayStats, usualJuggling: number): YourDayInsight | null {
  if (yesterday.peakJuggling < MIN_JUGGLING_SESSIONS) return null;
  const deviation = yesterday.peakJuggling / Math.max(usualJuggling, 1);
  if (deviation < MIN_DEVIATION) return null;
  const peakHour = new Date(yesterday.peakJugglingAt).getHours();
  return { kind: 'juggling', text: `Yesterday at ${hourText(peakHour)} you switched between ${yesterday.peakJuggling} sessions within ${JUGGLING_WINDOW_MS / MINUTE_MS}m.`, deviation };
}

function buildYourDay(events: readonly ActivityEvent[], { now, laneByKey = null }: { now: number; laneByKey?: ReadonlyMap<string, string> | null }): YourDay | null {
  const todayStart = startOfLocalDay(now);
  const windowStart = todayStart - BASELINE_DAYS * DAY_MS;
  const counted = events
    .filter((event) => event.ts >= windowStart && event.ts <= now && !isLaneSession(event, laneByKey))
    .sort((left, right) => left.ts - right.ts);
  const eventsByDay = new Map<string, ActivityEvent[]>();
  for (const event of counted) {
    const day = localDayKey(event.ts);
    const dayEvents = eventsByDay.get(day) ?? [];
    dayEvents.push(event);
    eventsByDay.set(day, dayEvents);
  }
  const today = localDayKey(now);
  const pastDays = [...eventsByDay.entries()]
    .filter(([day, dayEvents]) => day !== today && dayEvents.some((event) => event.kind === 'prompt'))
    .map(([day, dayEvents]) => dayStatsOf(day, dayEvents));
  const activeDayCount = pastDays.length + (eventsByDay.get(today)?.some((event) => event.kind === 'prompt') ? 1 : 0);
  const yesterday = pastDays.at(-1);
  if (!yesterday || activeDayCount < MIN_ACTIVE_DAYS) return null;
  const baselineDays = pastDays.length > 1 ? pastDays.slice(0, -1) : pastDays;
  const usualStretchMs = Math.round(median(baselineDays.map((day) => day.longestStretchMs)));
  const allPrompts = counted.filter((event) => event.kind === 'prompt').map((event) => event.ts);
  const allStretches = splitStretches(allPrompts);
  const replySamples = collectReplySamples(counted.filter((event) => event.ts < todayStart), allStretches);
  const insights = [
    waitingThresholdInsight(replySamples),
    sharpestHoursInsight(replySamples),
    longestStretchInsight(yesterday, usualStretchMs),
    jugglingInsight(yesterday, median(baselineDays.map((day) => day.peakJuggling))),
  ]
    .filter((insight): insight is YourDayInsight => insight !== null)
    .sort((left, right) => right.deviation - left.deviation)
    .slice(0, MAX_INSIGHTS);
  const latestStretch = allStretches.at(-1);
  const isStretchOngoing = latestStretch !== undefined && now - latestStretch.end <= BREAK_MS;
  return {
    yesterday: { day: yesterday.day, sessionCount: yesterday.sessionCount, activeMs: yesterday.activeMs },
    insights,
    usual: { peakWaiting: median(baselineDays.map((day) => day.peakWaiting)), stretchMs: usualStretchMs },
    currentStretchStartedAt: isStretchOngoing ? latestStretch.start : null,
    activeDayCount,
  };
}

function pruneActivity(eventsByKey: Map<string, ActivityEvent>, now: number): boolean {
  const oldestKept = startOfLocalDay(now) - BASELINE_DAYS * DAY_MS;
  let didPrune = false;
  for (const [key, event] of eventsByKey) {
    if (event.ts >= oldestKept) continue;
    eventsByKey.delete(key);
    didPrune = true;
  }
  return didPrune;
}

export { activityKey, buildYourDay, parseClaudeActivityLine, parseCodexActivityLine, pruneActivity };
export type { ActivityEvent, ParsedActivity };
