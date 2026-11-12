interface WakeTimeFormat {
  dayKeyOf(moment: number): string;
  shiftDayKey(dayKey: string, days: number): string | null;
  hourMinuteOf(moment: number): string;
  monthDayOf(moment: number): string;
}

export function describeWakeTime(nextFireAt: number, nowMs: number, format: WakeTimeFormat): string {
  const fireDay = format.dayKeyOf(nextFireAt);
  const today = format.dayKeyOf(nowMs);
  const time = format.hourMinuteOf(nextFireAt);
  if (fireDay === today) return time;
  if (fireDay === format.shiftDayKey(today, 1)) return `tomorrow ${time}`;
  return `${format.monthDayOf(nextFireAt)} ${time}`;
}
