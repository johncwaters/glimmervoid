import { el, query } from './dom-helpers.ts';
import { attentionSummaryText } from './focus-view/attention-core.ts';

type AttentionCounts = Parameters<typeof attentionSummaryText>[0];

export function buildAttentionBanner(onActivate: () => void, ...trailing: HTMLElement[]) {
  const banner = el('button', 'attention-banner');
  banner.type = 'button';
  banner.append(el('span', 'attention-banner-count'), ...trailing);
  banner.addEventListener('click', onActivate);
  paintAttentionBanner(banner, { waitingCount: 0, finishedCount: 0 });
  return banner;
}

export function paintAttentionBanner(banner: HTMLButtonElement, counts: AttentionCounts) {
  const hasAttention = counts.waitingCount + counts.finishedCount > 0;
  query(banner, '.attention-banner-count').textContent = attentionSummaryText(counts);
  banner.disabled = !hasAttention;
  banner.toggleAttribute('data-empty', !hasAttention);
  if (hasAttention) {
    banner.removeAttribute('aria-hidden');
    return;
  }
  banner.setAttribute('aria-hidden', 'true');
}
