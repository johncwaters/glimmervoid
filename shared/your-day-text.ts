import { clock, shiftDayKey } from './clock.ts';
import type { YourDay } from './contracts/your-day.ts';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function yourDayRecapLabel(yourDay: YourDay, now: number): string {
  const yesterdayKey = shiftDayKey(clock.dayKeyOf(now), -1) ?? '';
  if (yourDay.yesterday.day === yesterdayKey) return 'Yesterday';
  const [, month, day] = yourDay.yesterday.day.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

export function yourDaySessionWord(sessionCount: number): string {
  return sessionCount === 1 ? 'session' : 'sessions';
}
