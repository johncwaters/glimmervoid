import { el, query } from './dom-helpers.ts';
import type { AttentionCounts } from './focus-view/attention-core.ts';
import { attentionSummaryText, hasAnyAttention, jumpTargetCount } from './focus-view/attention-core.ts';

const NO_ATTENTION: AttentionCounts = { waitingCount: 0, finishedCount: 0, failedCount: 0 };

export function buildAttentionBanner(jumpAffordance: HTMLElement) {
  const banner = el('div', 'attention-banner');
  banner.setAttribute('role', 'status');
  jumpAffordance.classList.add('attention-banner-jump');
  banner.append(el('span', 'attention-banner-count'), jumpAffordance);
  paintAttentionBanner(banner, NO_ATTENTION);
  return banner;
}

export function paintAttentionBanner(banner: HTMLElement, counts: AttentionCounts) {
  query(banner, '.attention-banner-count').textContent = attentionSummaryText(counts);
  banner.toggleAttribute('data-empty', !hasAnyAttention(counts));
  banner.toggleAttribute('data-jumpable', jumpTargetCount(counts) > 0);
}
