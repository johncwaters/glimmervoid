import type { StatusIcon } from '#shared/state-icons.ts';
import { STATE_ICONS, STATUS_ICON_SHAPES } from '#shared/state-icons.ts';
import { STATES } from '#shared/states.ts';
import type { AttentionCounts } from './focus-view/attention-core.ts';

type FaviconVariant = 'idle' | 'failed' | 'waiting';
type AttentionVariant = Exclude<FaviconVariant, 'idle'>;

const BRAND_COLOR = '#c084fc';

const STATUS_BY_VARIANT: Readonly<Record<AttentionVariant, { icon: StatusIcon; color: string }>> = Object.freeze({
  failed: { icon: STATE_ICONS[STATES.FAILED], color: '#ef4444' },
  waiting: { icon: STATE_ICONS[STATES.WAITING], color: '#f59e0b' },
});

export function decideFaviconVariant({ waitingCount, failedCount }: AttentionCounts): FaviconVariant {
  if (waitingCount > 0) return 'waiting';
  if (failedCount > 0) return 'failed';
  return 'idle';
}

function renderStatusIconMarkup(icon: StatusIcon): string {
  return STATUS_ICON_SHAPES[icon]
    .map(({ tag, attributes }) => `<${tag} ${Object.entries(attributes).map(([name, value]) => `${name}="${value}"`).join(' ')}/>`)
    .join('');
}

function renderFaviconMark(variant: FaviconVariant): string {
  if (variant === 'idle') return `<path d="M10 8 L22 16 L10 24Z" fill="${BRAND_COLOR}"/>`;
  const { icon, color } = STATUS_BY_VARIANT[variant];
  return `<g color="${color}" transform="translate(4 4) scale(1.5)">${renderStatusIconMarkup(icon)}</g>`;
}

export function renderFaviconSvg(variant: FaviconVariant) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0810"/><rect x="1" y="1" width="30" height="30" rx="5" fill="none" stroke="#2a2440" stroke-width="1"/>${renderFaviconMark(variant)}</svg>`;
}
