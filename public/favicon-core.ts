import { BRAND_ACCENT, BRAND_INK, brandMarkMarkup } from '#shared/brand-mark.ts';
import type { AttentionCounts } from './focus-view/attention-core.ts';

type FaviconVariant = 'idle' | 'failed' | 'waiting';

const FAVICON_STROKE_WIDTH = 14;

const MARK_COLORS_BY_VARIANT: Readonly<Record<FaviconVariant, { frame: string; light: string }>> = Object.freeze({
  idle: { frame: BRAND_INK, light: BRAND_ACCENT },
  failed: { frame: '#ef4444', light: '#ef4444' },
  waiting: { frame: '#f59e0b', light: '#f59e0b' },
});

export function decideFaviconVariant({ waitingCount, failedCount }: AttentionCounts): FaviconVariant {
  if (waitingCount > 0) return 'waiting';
  if (failedCount > 0) return 'failed';
  return 'idle';
}

export function renderFaviconSvg(variant: FaviconVariant) {
  const mark = brandMarkMarkup({ ...MARK_COLORS_BY_VARIANT[variant], strokeWidth: FAVICON_STROKE_WIDTH });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Glimmervoid</title><rect width="32" height="32" rx="6" fill="#0a0810"/><rect x="1" y="1" width="30" height="30" rx="5" fill="none" stroke="#2a2440" stroke-width="1"/><g transform="translate(2.4 2.4) scale(0.272)">${mark}</g></svg>`;
}
