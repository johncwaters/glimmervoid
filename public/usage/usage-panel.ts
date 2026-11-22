import './usage-panel.css';
import { clock } from '#shared/clock.ts';
import { el, isPanelHidden } from '../dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from '../poll-ago.ts';
import { button } from '../ui/button.ts';
import { emptyState } from '../ui/empty-state.ts';
import type { ViewModule, ViewRefreshReason } from '../view-registry-core.ts';
import {
  reportUsageAction,
  requestUsageReport,
  setUsageLookingProbe,
  subscribeUsage,
  usageRefreshStatus,
  usageSnapshot,
} from './usage-store.ts';
import type { UsageChange } from './usage-store.ts';
import { clampPct } from './usage-panel-parts.ts';
import {
  NO_VALUE,
  coverageRows,
  formatPercent,
  isUsageUnavailable,
  limitCards,
  noLocalLimitsNote,
  projectionLineText,
  resetClockText,
} from './usage-view-core.ts';
import type { LimitCardView } from './usage-view-core.ts';
import { usageErrorLine } from './usage-store-core.ts';

let rootEl: HTMLElement | null = null;
let refreshButtonEl: HTMLButtonElement | null = null;
let refreshStatusEl: HTMLElement | null = null;
let scanAgeEl: HTMLElement | null = null;
const ticker = createPollAgoTicker(() => rootEl);

function paintScanAge(): void {
  if (!scanAgeEl?.isConnected) return;
  const ts = usageSnapshot().report?.ts;
  ticker.track(scanAgeEl, typeof ts === 'number' && ts > 0 ? ts : null, (stamp) => (typeof stamp === 'number' && stamp > 0 ? `Scanned ${formatAgo(stamp)}` : ''));
}

function paintRefreshStatus(): void {
  const status = usageRefreshStatus();
  if (refreshButtonEl?.isConnected) refreshButtonEl.disabled = status.isPending;
  if (!refreshStatusEl?.isConnected) return;
  refreshStatusEl.textContent = status.text;
  refreshStatusEl.dataset.state = status.hasFailure ? 'error' : (status.isPending ? 'pending' : 'idle');
}

function buildHeader(): HTMLElement {
  const header = el('header', 'usage-header');
  const titleGroup = el('div', 'usage-header-title');
  titleGroup.append(el('h1', 'usage-title', 'Usage'));
  scanAgeEl = el('span', 'usage-scan-age');
  paintScanAge();
  titleGroup.append(scanAgeEl);

  const controls = el('div', 'usage-header-controls');
  refreshStatusEl = el('span', 'usage-refresh-status');
  refreshButtonEl = button({
    variant: 'secondary',
    label: 'Refresh',
    action: 'refresh-usage',
    onClick: () => {
      reportUsageAction('refresh');
      requestUsageReport({ force: true });
    },
  });
  paintRefreshStatus();
  controls.append(refreshStatusEl, refreshButtonEl);
  header.append(titleGroup, controls);
  return header;
}

function buildPaceBar(usedPct: number, projectedPct: number | null, elapsedPct: number | null): HTMLElement {
  const bar = el('div', 'usage-pace-bar');
  const usedWidth = clampPct(usedPct);
  const usedFill = el('span', 'usage-pace-used');
  usedFill.style.width = `${usedWidth}%`;
  bar.append(usedFill);
  if (projectedPct !== null && projectedPct > usedPct) {
    const projectedEnd = clampPct(projectedPct);
    const projectedFill = el('span', 'usage-pace-projected');
    projectedFill.style.left = `${usedWidth}%`;
    projectedFill.style.width = `${Math.max(0, projectedEnd - usedWidth)}%`;
    bar.append(projectedFill);
  }
  if (elapsedPct !== null) {
    const tick = el('span', 'usage-pace-tick');
    tick.style.left = `${clampPct(elapsedPct)}%`;
    bar.append(tick);
  }
  return bar;
}

function buildLimitCard(card: LimitCardView, now: number): HTMLElement {
  const cardEl = el('article', 'usage-limit-card');
  if (card.tone !== 'ok') cardEl.dataset.tone = card.tone;

  const head = el('div', 'usage-limit-head');
  head.append(el('span', 'usage-limit-agent', card.vendorLabel));
  if (card.accountId) head.append(el('span', 'usage-limit-account', card.accountId));

  const hero = el('div', 'usage-limit-hero');
  hero.append(
    el('span', 'usage-limit-pct usage-num', formatPercent(card.binding.usedPct)),
    el('span', 'usage-limit-window', `of ${card.binding.label}`),
  );

  const bar = buildPaceBar(card.binding.usedPct, card.binding.projectedPct, card.binding.elapsedPct);
  const projection = el('p', 'usage-limit-projection', projectionLineText(card.binding, now));

  cardEl.append(head, hero, bar, projection);

  if (card.other) {
    const secondary = el('div', 'usage-limit-secondary');
    const secondaryBar = el('div', 'usage-pace-bar usage-pace-bar-thin');
    const secondaryFill = el('span', 'usage-pace-used');
    secondaryFill.style.width = `${clampPct(card.other.usedPct)}%`;
    secondaryBar.append(secondaryFill);
    const resetText = resetClockText(card.other.resetsAtMs, now);
    secondary.append(
      el('span', 'usage-limit-secondary-label', card.other.shortLabel),
      secondaryBar,
      el('span', 'usage-num', formatPercent(card.other.usedPct)),
      el('span', 'usage-limit-secondary-reset', resetText ? `resets ${resetText}` : ''),
    );
    cardEl.append(secondary);
  }

  if (card.reportedAtMs !== null) {
    const sourceEl = el('div', 'usage-limit-source');
    if (card.isStale) sourceEl.dataset.stale = 'true';
    const prefix = card.isStale ? 'Last reported' : 'Reported';
    ticker.track(sourceEl, card.reportedAtMs, (stamp) => `${prefix} ${formatAgo(stamp)}`);
    cardEl.append(sourceEl);
  }
  return cardEl;
}

function buildSectionHeading(title: string, note: string): HTMLElement {
  const heading = el('h2', 'usage-section-heading');
  heading.append(el('span', 'usage-eyebrow', title));
  if (note) heading.append(el('span', 'usage-section-note', note));
  return heading;
}

function buildLimitsSection(now: number): HTMLElement {
  const snapshot = usageSnapshot();
  const section = el('section', 'usage-section');
  section.append(buildSectionHeading('Limits', 'reported by each agent, projected at the current pace'));

  const cards = limitCards(snapshot.planLimitsByVendor, snapshot.accountPlanLimits, now);
  if (cards.length > 0) {
    const grid = el('div', 'usage-limits-grid');
    for (const card of cards) grid.append(buildLimitCard(card, now));
    section.append(grid);
  }
  if (cards.length === 0) {
    section.append(el('p', 'usage-note', 'No agent has reported plan limits yet. Limits appear automatically after a Claude Code, Codex or Kimi Code turn.'));
  }

  const missingLimitsNote = noLocalLimitsNote(snapshot.report?.coverage);
  if (missingLimitsNote) section.append(el('p', 'usage-note', missingLimitsNote));
  return section;
}

function buildCoverageSection(): HTMLElement {
  const snapshot = usageSnapshot();
  const section = el('section', 'usage-section');
  section.append(buildSectionHeading('Coverage', 'what this tab can read'));

  const rows = coverageRows(snapshot.report);
  const wrap = el('div', 'usage-table-scroll');
  const table = el('table', 'usage-table usage-coverage-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['Agent', 'Transcripts', 'Last entry', 'Limits', 'Cost']) {
    const th = el('th', null, label);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const lastEntryCell = el('td', row.lastEntryMs !== null ? null : 'usage-muted', row.lastEntryMs !== null ? null : NO_VALUE);
    if (row.lastEntryMs !== null) {
      ticker.track(lastEntryCell, row.lastEntryMs, (stamp) => formatAgo(stamp));
    }
    tr.append(
      el('td', 'usage-coverage-agent', row.vendorLabel),
      el('td', row.hasFiles ? 'usage-coverage-ok' : 'usage-muted', row.filesText),
      lastEntryCell,
      el('td', row.hasLimits ? null : 'usage-muted', row.limitSourceText),
      el('td', null, row.costSourceText),
    );
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function renderUsagePanel({ force = false }: { force?: boolean } = {}): void {
  if (!rootEl) return;
  if (!force && isPanelHidden(rootEl)) return;
  const scroller = rootEl.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  ticker.reset();
  refreshButtonEl = null;
  refreshStatusEl = null;
  scanAgeEl = null;
  rootEl.textContent = '';

  const snapshot = usageSnapshot();
  const now = clock.nowMs();
  rootEl.append(buildHeader());

  if (snapshot.report && isUsageUnavailable(snapshot.report)) {
    rootEl.append(emptyState({
      title: 'Usage unavailable',
      text: usageErrorLine(snapshot.report),
    }));
    if (scroller) scroller.scrollTop = scrollTop;
    return;
  }

  if (snapshot.report?.warning) {
    rootEl.append(el('div', 'usage-warning', snapshot.report.warning));
  }

  rootEl.append(buildLimitsSection(now));
  if (snapshot.report?.coverage) {
    rootEl.append(buildCoverageSection());
  }
  if (!snapshot.report) {
    rootEl.append(emptyState({
      title: 'Scanning local transcripts',
      text: 'Usage figures appear once the first scan pass completes.',
    }));
  }

  if (scroller) scroller.scrollTop = scrollTop;
}

function applyUsageChange(change: UsageChange): void {
  if (change === 'refresh-status') {
    paintRefreshStatus();
    return;
  }
  renderUsagePanel();
}

function mountUsageView(parent: HTMLElement): void {
  if (rootEl) return;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  rootEl = root;
  setUsageLookingProbe(() => !isPanelHidden(rootEl));
  subscribeUsage(applyUsageChange);
  ticker.ensure();
  renderUsagePanel({ force: true });
}

function refreshUsageView(reason: ViewRefreshReason): void {
  if (reason === 'shown') renderUsagePanel({ force: true });
  requestUsageReport();
}

const view: ViewModule<HTMLElement> = { mount: mountUsageView, refresh: refreshUsageView };

export { view };
