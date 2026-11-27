import type { YourDay } from '#shared/contracts/your-day.ts';
import { clock } from '#shared/clock.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { isHintCardShown, showHintCard } from './feature-hint.ts';
import { getString, localStorageBackend, setString } from './local-store.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { attentionTally } from './session-card/card-registry.ts';
import { subscribeUsage, usageSnapshot } from './usage/usage-store.ts';
import { yourDayRecapLabel, yourDaySessionWord } from '#shared/your-day-text.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LIVE_TIP_GAP_MS = 3 * HOUR_MS;
const MORNING_START_HOUR = 4;

let openUsageView: () => void = () => {};
let nextCheckTimer: ReturnType<typeof setTimeout> | null = null;

function minutesText(ms: number) {
  return twoUnitDurationText(Math.round(ms / MINUTE_MS) * 60, { smallestUnit: 'm', dropsZeroRemainder: true });
}

function claim(category: string, now: number, ttlMs: number) {
  try {
    return claimNotification(localStorageBackend, claimKey('your-day', category), now, ttlMs);
  } catch {
    return true;
  }
}

function liveTipDetail(usual: YourDay['usual']) {
  return `That is past your usual ${minutesText(usual.stretchMs)} run and ${Math.round(usual.peakWaiting)} waiting. Agents keep their place while you are away, so 15 minutes off costs them nothing.`;
}

function tryDailyTip(yourDay: YourDay, now: number) {
  const topInsight = yourDay.insights[0];
  const hour = clock.hourOf(now);
  if (!topInsight || hour < MORNING_START_HOUR) return false;
  if (!claim(`morning-${clock.dayKeyOf(now)}`, now, DAY_MS)) return false;
  const { sessionCount, activeMs, longestStretchMs } = yourDay.yesterday;
  showHintCard({
    eyebrow: yourDayRecapLabel(yourDay, now),
    facts: [
      { value: String(sessionCount), label: yourDaySessionWord(sessionCount) },
      { value: minutesText(activeMs), label: 'active' },
      { value: minutesText(longestStretchMs), label: 'longest run' },
    ],
    title: topInsight.title,
    detail: topInsight.detail,
    ariaLabel: 'Your day',
    openLabel: 'Open usage',
    onOpen: openUsageView,
    onDismiss: () => {},
  });
  return true;
}

function ongoingStretchStartOf(yourDay: YourDay, now: number): number | null {
  if (yourDay.currentStretchEndsAt === null || now >= yourDay.currentStretchEndsAt) return null;
  return yourDay.currentStretchStartedAt;
}

function tryLiveTip(yourDay: YourDay, now: number) {
  const stretchStartedAt = ongoingStretchStartOf(yourDay, now);
  if (stretchStartedAt === null) return;
  const waitingCount = attentionTally.counts.waitingCount;
  const stretchMs = now - stretchStartedAt;
  if (waitingCount <= yourDay.usual.peakWaiting || stretchMs <= yourDay.usual.stretchMs) return;
  const silencedKey = claimKey('your-day', `live-silenced-${clock.dayKeyOf(now)}`);
  if (getString(silencedKey)) return;
  if (!claim('live', now, LIVE_TIP_GAP_MS)) return;
  showHintCard({
    eyebrow: 'Right now',
    title: `${minutesText(stretchMs)} without a break, ${waitingCount} sessions waiting`,
    detail: liveTipDetail(yourDay.usual),
    ariaLabel: 'Your day',
    openLabel: 'Open usage',
    onOpen: openUsageView,
    onDismiss: () => setString(silencedKey, String(now)),
  });
}

function nextMorningStartAt(now: number) {
  const morningToday = clock.startOfDay(now) + MORNING_START_HOUR * HOUR_MS;
  return now < morningToday ? morningToday : clock.startOfDay(now, -1) + MORNING_START_HOUR * HOUR_MS;
}

function nextTipDeadlineOf(yourDay: YourDay, now: number) {
  const stretchStartedAt = ongoingStretchStartOf(yourDay, now);
  const stretchDeadlines = stretchStartedAt === null || yourDay.currentStretchEndsAt === null ? [] : [stretchStartedAt + yourDay.usual.stretchMs + 1, yourDay.currentStretchEndsAt];
  return Math.min(nextMorningStartAt(now), ...stretchDeadlines.filter((deadline) => deadline > now));
}

function scheduleNextTipCheck(yourDay: YourDay | null, now: number) {
  if (nextCheckTimer !== null) clearTimeout(nextCheckTimer);
  nextCheckTimer = null;
  if (!yourDay) return;
  nextCheckTimer = setTimeout(checkYourDayTips, nextTipDeadlineOf(yourDay, now) - now);
}

function checkYourDayTips() {
  const now = clock.nowMs();
  const yourDay = usageSnapshot().sessions?.yourDay ?? null;
  scheduleNextTipCheck(yourDay, now);
  if (document.visibilityState !== 'visible' || !yourDay || isHintCardShown()) return;
  if (tryDailyTip(yourDay, now)) return;
  tryLiveTip(yourDay, now);
}

export function startYourDayTips({ openUsage }: { openUsage: () => void }) {
  openUsageView = openUsage;
  subscribeUsage((change) => {
    if (change === 'sessions') checkYourDayTips();
  });
  document.addEventListener('visibilitychange', checkYourDayTips);
  checkYourDayTips();
}
