import type { YourDay } from '#shared/contracts/your-day.ts';
import { localDayKey, twoUnitDurationText } from '#shared/display-text.ts';
import { isHintCardShown, showHintCard } from './feature-hint.ts';
import { claimKey, claimNotification } from './notify-dedupe-core.ts';
import { attentionTally } from './session-card/card-registry.ts';
import { requestUsageReport, subscribeUsage, usageSnapshot } from './usage/usage-store.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LIVE_TIP_GAP_MS = 3 * HOUR_MS;
const MORNING_START_HOUR = 4;
const CHECK_INTERVAL_MS = MINUTE_MS;
const REPORT_REFRESH_MS = 30 * MINUTE_MS;

let openUsageView: () => void = () => {};
let lastReportRequestAt = 0;

function minutesText(ms: number) {
  return twoUnitDurationText(Math.round(ms / MINUTE_MS) * 60, { smallestUnit: 'm', dropsZeroRemainder: true });
}

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function claim(category: string, now: number, ttlMs: number) {
  try {
    return claimNotification(localStorage, claimKey('your-day', category), now, ttlMs);
  } catch {
    return true;
  }
}

function liveTipText(waitingCount: number, stretchMs: number) {
  return `${waitingCount} sessions are waiting and it has been ${minutesText(stretchMs)} since a break. They will keep. Step away for 15 minutes.`;
}

function tryMorningTip(yourDay: YourDay, now: number) {
  const topInsight = yourDay.insights[0];
  if (!topInsight || new Date(now).getHours() < MORNING_START_HOUR) return false;
  if (!claim(`morning-${localDayKey(now)}`, now, DAY_MS)) return false;
  showHintCard({ text: `Morning. ${topInsight.text}`, ariaLabel: 'Your day tip', onOpen: openUsageView, onDismiss: () => {} });
  return true;
}

function tryLiveTip(yourDay: YourDay, now: number) {
  const stretchStartedAt = yourDay.currentStretchStartedAt;
  if (stretchStartedAt === null) return;
  const waitingCount = attentionTally.counts.waitingCount;
  const stretchMs = now - stretchStartedAt;
  if (waitingCount <= yourDay.usual.peakWaiting || stretchMs <= yourDay.usual.stretchMs) return;
  const silencedKey = claimKey('your-day', `live-silenced-${localDayKey(now)}`);
  if (readStorage(silencedKey)) return;
  if (!claim('live', now, LIVE_TIP_GAP_MS)) return;
  showHintCard({
    text: liveTipText(waitingCount, stretchMs),
    ariaLabel: 'Your day tip',
    onOpen: openUsageView,
    onDismiss: () => writeStorage(silencedKey, String(now)),
  });
}

function isReportFresh(now: number) {
  const reportTs = Number(usageSnapshot().report?.ts);
  return Number.isFinite(reportTs) && now - reportTs < REPORT_REFRESH_MS;
}

function requestReportOnce(now: number) {
  if (now - lastReportRequestAt < REPORT_REFRESH_MS) return;
  lastReportRequestAt = now;
  requestUsageReport();
}

function checkYourDayTips() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (!isReportFresh(now)) {
    requestReportOnce(now);
    return;
  }
  const yourDay = usageSnapshot().report?.yourDay;
  if (!yourDay || isHintCardShown()) return;
  if (tryMorningTip(yourDay, now)) return;
  tryLiveTip(yourDay, now);
}

export function startYourDayTips({ openUsage }: { openUsage: () => void }) {
  openUsageView = openUsage;
  subscribeUsage((change) => {
    if (change === 'report') checkYourDayTips();
  });
  document.addEventListener('visibilitychange', checkYourDayTips);
  setInterval(checkYourDayTips, CHECK_INTERVAL_MS);
}
