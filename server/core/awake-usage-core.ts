import type { AwakeUsage, AwakeUsageNotified } from '../../shared/contracts/watcher-link.ts';

const AWAKE_USAGE_THRESHOLDS = Object.freeze([75, 90, 100]);

type AwakeUsageAlert = { threshold: number; capMs: number; usedMs: number; usedHours: number; capHours: number; periodEndsAt: string };

function percentUsed(usage: AwakeUsage): number | null {
  if (usage.capMs === null) return null;
  return (usage.usedMs / usage.capMs) * 100;
}

function alreadyNotifiedThreshold(usage: AwakeUsage, notified: AwakeUsageNotified | null): number {
  if (notified === null || notified.periodStartAt !== usage.periodStartAt || notified.capMs !== usage.capMs) return 0;
  return notified.threshold;
}

function newlyCrossedAlert(usage: AwakeUsage, notified: AwakeUsageNotified | null, lookaheadMs: number): AwakeUsageAlert | null {
  const percent = percentUsed({ ...usage, usedMs: usage.capMs !== null && usage.usedMs + lookaheadMs >= usage.capMs ? usage.capMs : usage.usedMs });
  if (percent === null || usage.capMs === null) return null;
  const notifiedThreshold = alreadyNotifiedThreshold(usage, notified);
  const crossed = AWAKE_USAGE_THRESHOLDS.filter((threshold) => percent >= threshold && threshold > notifiedThreshold);
  const threshold = crossed.at(-1);
  if (threshold === undefined) return null;
  return { threshold, capMs: usage.capMs, usedMs: usage.usedMs, usedHours: usage.usedMs / 3_600_000, capHours: usage.capMs / 3_600_000, periodEndsAt: usage.periodEndsAt };
}

function notifiedAfter(usage: AwakeUsage, alert: AwakeUsageAlert): AwakeUsageNotified {
  return { periodStartAt: usage.periodStartAt, capMs: alert.capMs, threshold: alert.threshold };
}

function formattedHours(hours: number): string {
  return hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1);
}

function awakeUsageAlertText(alert: AwakeUsageAlert): string {
  if (alert.threshold >= 100 && alert.usedHours < alert.capHours) return `This host will use all ${formattedHours(alert.capHours)} of its awake hours for this month within ${Math.ceil((alert.capMs - alert.usedMs) / 60_000)} awake minutes, then stops and stays asleep until ${alert.periodEndsAt}.`;
  if (alert.threshold >= 100) return `This host has used all ${formattedHours(alert.capHours)} awake hours for this month. It stays asleep until ${alert.periodEndsAt}.`;
  return `This host has used ${alert.threshold}% of its awake hours this month (${formattedHours(alert.usedHours)} of ${formattedHours(alert.capHours)}). At 100% it stays asleep until ${alert.periodEndsAt}.`;
}

export { awakeUsageAlertText, newlyCrossedAlert, notifiedAfter };
