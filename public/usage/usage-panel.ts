import './usage-panel.css';
import { clock } from '#shared/clock.ts';
import type { UsageBreakdownRow, UsageDailyVendorRow, UsageRangeRollup } from '#shared/contracts/usage-report.ts';
import { el, isPanelHidden } from '../dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from '../poll-ago.ts';
import { button } from '../ui/button.ts';
import { emptyState } from '../ui/empty-state.ts';
import { segmented } from '../ui/segmented.ts';
import type { ViewModule, ViewRefreshReason } from '../view-registry-core.ts';
import {
  reportUsageAction,
  requestUsageReport,
  setUsageLookingProbe,
  setUsageRange,
  subscribeUsage,
  usageRefreshStatus,
  usageSnapshot,
} from './usage-store.ts';
import type { UsageChange, UsageRangeKey } from './usage-store.ts';
import { buildMeter, clampPct } from './usage-panel-parts.ts';
import {
  NO_VALUE,
  coverageRows,
  formatPercent,
  isUsageUnavailable,
  laneLabelOf,
  limitCards,
  noLocalLimitsNote,
  projectionLineText,
  resetClockText,
  shortProjectLabel,
  spendDeltaText,
  vendorLabelOf,
} from './usage-view-core.ts';
import type { LimitCardView } from './usage-view-core.ts';
import {
  RANGE_OPTIONS,
  budgetRows,
  formatCount,
  formatTokens,
  formatUsd,
  usageErrorLine,
} from './usage-store-core.ts';
import type { UsageReport } from './usage-store-core.ts';

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

type BreakdownTab = 'agent' | 'model' | 'project' | 'lane';

const BREAKDOWN_OPTIONS: readonly { value: BreakdownTab; label: string }[] = Object.freeze([
  { value: 'agent', label: 'Agent' },
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
  { value: 'lane', label: 'Lane' },
]);

const BAR_MAX_HEIGHT_PX = 84;
const BAR_MIN_SEGMENT_PX = 2;

let activeBreakdown: BreakdownTab = 'agent';

function dayTotalCost(day: UsageDailyVendorRow): number {
  let sum = 0;
  for (const amount of Object.values(day.costByVendor)) sum += amount;
  return sum;
}

function activeVendorsInDaily(daily: readonly UsageDailyVendorRow[]): string[] {
  const totalsByVendor = new Map<string, number>();
  for (const day of daily) {
    for (const [vendor, amount] of Object.entries(day.costByVendor)) {
      if (amount > 0) totalsByVendor.set(vendor, (totalsByVendor.get(vendor) ?? 0) + amount);
    }
  }
  return Array.from(totalsByVendor.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([vendor]) => vendor);
}

function daySummaryLabel(day: UsageDailyVendorRow, vendors: readonly string[]): string {
  const total = dayTotalCost(day);
  if (total <= 0) return `${day.day}: $0.00`;
  const parts = vendors
    .filter((vendor) => (day.costByVendor[vendor] ?? 0) > 0)
    .map((vendor) => `${vendorLabelOf(vendor)} ${formatUsd(day.costByVendor[vendor])}`);
  const historyTag = day.source === 'history' ? ' (history)' : '';
  return `${day.day}${historyTag}: ${formatUsd(total)} (${parts.join(', ')})`;
}

function buildDailyChart(daily: readonly UsageDailyVendorRow[]): HTMLElement {
  const wrap = el('div', 'usage-chart-wrap');
  const vendors = activeVendorsInDaily(daily);
  const maxDayCost = Math.max(0, ...daily.map(dayTotalCost));
  const chart = el('div', 'usage-daily-chart');

  for (const day of daily) {
    const col = el('div', 'usage-daily-col');
    col.setAttribute('aria-label', daySummaryLabel(day, vendors));
    if (day.source === 'history') col.dataset.source = 'history';
    if (maxDayCost > 0) {
      for (const vendor of vendors) {
        const amount = day.costByVendor[vendor] ?? 0;
        if (amount <= 0) continue;
        const segment = el('span', 'usage-daily-seg');
        segment.dataset.vendor = vendor;
        const heightPx = Math.max(BAR_MIN_SEGMENT_PX, Math.round((amount / maxDayCost) * BAR_MAX_HEIGHT_PX));
        segment.style.height = `${heightPx}px`;
        col.append(segment);
      }
    }
    chart.append(col);
  }
  wrap.append(chart);

  if (vendors.length > 0) {
    const legend = el('div', 'usage-chart-legend');
    for (const vendor of vendors) {
      const item = el('span', 'usage-legend-item');
      const swatch = el('span', 'usage-legend-swatch');
      swatch.dataset.vendor = vendor;
      item.append(swatch, el('span', null, vendorLabelOf(vendor)));
      legend.append(item);
    }
    wrap.append(legend);
  }
  return wrap;
}

function buildBudgetsRow(report: UsageReport): HTMLElement | null {
  const rows = budgetRows(report);
  if (rows.length === 0) return null;
  const wrap = el('div', 'usage-budgets');
  for (const row of rows) {
    const item = el('div', 'usage-budget-item');
    const scopeLabel = row.scope === 'daily' ? 'Today' : (row.scope === 'monthly' ? 'This month' : row.scope);
    item.append(
      el('span', 'usage-budget-label', `${scopeLabel} ${formatUsd(row.spentUsd)} of ${formatUsd(row.budgetUsd)}`),
      buildMeter(row.pct, row.tone, `${scopeLabel} budget`),
    );
    wrap.append(item);
  }
  return wrap;
}

function breakdownLabel(tab: BreakdownTab, row: UsageBreakdownRow): string {
  if (tab === 'agent') return vendorLabelOf(row.label);
  if (tab === 'lane') return laneLabelOf(row.label);
  if (tab === 'project') return shortProjectLabel(row.label);
  return row.label;
}

function breakdownRowsFor(range: UsageRangeRollup, tab: BreakdownTab): UsageBreakdownRow[] {
  if (tab === 'agent') return range.byAgent;
  if (tab === 'model') return range.byModel;
  if (tab === 'project') return range.byProject;
  return range.byLane ?? [];
}

function buildBreakdownTable(range: UsageRangeRollup, tab: BreakdownTab): HTMLElement {
  const rows = breakdownRowsFor(range, tab);
  if (rows.length === 0) {
    return el('p', 'usage-note', 'No spend recorded in this range.');
  }
  const firstHeading = tab === 'agent' ? 'Agent' : (tab === 'model' ? 'Model' : (tab === 'project' ? 'Project' : 'Lane'));
  const wrap = el('div', 'usage-table-scroll');
  const table = el('table', 'usage-table');
  const head = el('thead');
  const headRow = el('tr');
  const columns: readonly { label: string; numeric?: boolean }[] = [
    { label: firstHeading },
    { label: 'Cost', numeric: true },
    { label: 'Share', numeric: true },
    { label: 'Input', numeric: true },
    { label: 'Output', numeric: true },
    { label: 'Cache hit', numeric: true },
    { label: 'Sessions', numeric: true },
  ];
  for (const column of columns) {
    const th = el('th', column.numeric ? 'usage-num' : null, column.label);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const sharePct = range.costUSD > 0 ? (row.costUSD / range.costUSD) * 100 : null;
    const nameCell = el('td', tab === 'model' ? 'usage-mono' : null, breakdownLabel(tab, row));
    tr.append(
      nameCell,
      el('td', 'usage-num', formatUsd(row.costUSD)),
      el('td', 'usage-num', sharePct === null ? NO_VALUE : formatPercent(sharePct)),
      el('td', 'usage-num', formatTokens(row.input)),
      el('td', 'usage-num', formatTokens(row.output)),
      el('td', 'usage-num', row.cacheHitPct === null ? NO_VALUE : formatPercent(row.cacheHitPct)),
      el('td', 'usage-num', formatCount(row.sessions)),
    );
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function buildSpendSection(
  report: UsageReport,
  rangeKey: UsageRangeKey,
  onRerender: () => void,
): HTMLElement {
  const section = el('section', 'usage-section');
  section.append(buildSectionHeading('Spend', 'list price estimate, not a bill'));

  const range = report.ranges?.[rangeKey];
  if (!range) {
    section.append(el('p', 'usage-note', 'Spend rollups are not available yet.'));
    return section;
  }

  const head = el('div', 'usage-spend-head');
  const summary = el('div', 'usage-spend-summary');
  const rangeSwitch = segmented({
    label: 'Spend range',
    options: RANGE_OPTIONS,
    value: rangeKey,
    size: 'small',
    onChange: (nextRange) => {
      reportUsageAction('range');
      setUsageRange(nextRange);
    },
  });
  summary.append(
    rangeSwitch.element,
    el('div', 'usage-spend-hero usage-num', formatUsd(range.costUSD)),
    el('div', 'usage-spend-delta', spendDeltaText(rangeKey, range.costUSD, range.previousCostUSD)),
  );
  head.append(summary, buildDailyChart(range.daily));
  section.append(head);

  const budgetsRow = buildBudgetsRow(report);
  if (budgetsRow) section.append(budgetsRow);

  const availableTabs = range.byLane !== null
    ? BREAKDOWN_OPTIONS
    : BREAKDOWN_OPTIONS.filter((option) => option.value !== 'lane');
  if (!availableTabs.some((option) => option.value === activeBreakdown)) activeBreakdown = 'agent';

  const breakdownSwitch = segmented({
    label: 'Spend breakdown',
    options: availableTabs,
    value: activeBreakdown,
    size: 'small',
    onChange: (nextTab) => {
      activeBreakdown = nextTab;
      onRerender();
    },
  });
  section.append(breakdownSwitch.element, buildBreakdownTable(range, activeBreakdown));

  const missingModels = report.pricing?.missing ?? [];
  if (missingModels.length > 0) {
    const noun = missingModels.length === 1 ? 'model has' : 'models have';
    section.append(el('p', 'usage-note', `${missingModels.length} ${noun} no list price and count as $0: ${missingModels.join(', ')}.`));
  }
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
  if (snapshot.report?.ranges) {
    rootEl.append(buildSpendSection(snapshot.report, snapshot.rangeValue, () => renderUsagePanel({ force: true })));
  }
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
