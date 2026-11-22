import { meter } from '../ui/meter.ts';
import type { MeterTone } from '../ui/meter.ts';

function clampPct(pct: unknown) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function budgetMeterTone(tone: unknown): MeterTone {
  if (tone === 'crit' || tone === 'fail') return 'failed';
  if (tone === 'warn') return 'waiting';
  return 'accent';
}

function buildMeter(pct: unknown, tone: unknown, label: string) {
  return meter({ value: clampPct(pct) / 100, label, tone: budgetMeterTone(tone) }).element;
}

export { buildMeter, clampPct };
