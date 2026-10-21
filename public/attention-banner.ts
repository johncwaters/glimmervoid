import { STATE_ICONS } from '#shared/state-icons.ts';
import type { SessionState } from '#shared/states.ts';
import { STATES } from '#shared/states.ts';
import { el, query } from './dom-helpers.ts';
import type { AttentionCounts } from './focus-view/attention-core.ts';
import { attentionSummaryText, hasAnyAttention, jumpTargetCount } from './focus-view/attention-core.ts';
import { paintStatusIcon } from './status-icon.ts';

const NO_ATTENTION: AttentionCounts = { waitingCount: 0, finishedCount: 0, failedCount: 0 };

const ATTENTION_CHIP_KINDS = [
  { state: STATES.FAILED, countKey: 'failedCount' },
  { state: STATES.WAITING, countKey: 'waitingCount' },
  { state: STATES.COMPLETE, countKey: 'finishedCount' },
] as const;

function buildAttentionChip(state: SessionState) {
  const chip = el('span', 'attention-chip');
  chip.dataset.state = state;
  chip.setAttribute('aria-hidden', 'true');
  const icon = el('span', 'attention-chip-icon');
  paintStatusIcon(icon, STATE_ICONS[state]);
  chip.append(icon, el('span', 'attention-chip-count'));
  return chip;
}

export function buildAttentionBanner(jumpAffordance: HTMLElement) {
  const banner = el('div', 'attention-banner');
  banner.setAttribute('role', 'status');
  jumpAffordance.classList.add('attention-banner-jump');
  const chips = el('span', 'attention-banner-chips');
  chips.append(...ATTENTION_CHIP_KINDS.map((kind) => buildAttentionChip(kind.state)));
  const statusRow = el('div', 'attention-banner-status');
  statusRow.append(chips, el('span', 'attention-banner-count'));
  const jumpRow = el('div', 'attention-banner-jump-row');
  jumpRow.append(el('span', 'attention-banner-jump-caption', 'Next session'), jumpAffordance);
  banner.append(statusRow, jumpRow);
  paintAttentionBanner(banner, NO_ATTENTION);
  return banner;
}

export function paintAttentionBanner(banner: HTMLElement, counts: AttentionCounts) {
  query(banner, '.attention-banner-count').textContent = attentionSummaryText(counts);
  for (const kind of ATTENTION_CHIP_KINDS) {
    const chip = query(banner, `.attention-chip[data-state="${kind.state}"]`);
    const count = counts[kind.countKey];
    chip.hidden = count === 0;
    chip.title = attentionSummaryText({ ...NO_ATTENTION, [kind.countKey]: count });
    query(chip, '.attention-chip-count').textContent = String(count);
  }
  const isJumpable = jumpTargetCount(counts) > 0;
  banner.toggleAttribute('data-empty', !hasAnyAttention(counts));
  banner.toggleAttribute('data-jumpable', isJumpable);
  const jumpAffordance = query(banner, '.attention-banner-jump');
  if (jumpAffordance instanceof HTMLButtonElement) jumpAffordance.disabled = !isJumpable;
}
