import './usage-panel.css';
import { buildPanelSection, el, isPanelHidden } from '../dom-helpers.ts';
import { createPollAgoTicker, formatAgo } from '../poll-ago.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import type { ViewModule, ViewRefreshReason } from '../view-registry-core.ts';
import { reportUsageAction, requestUsageReport, setUsageLookingProbe, setUsageRange, subscribeUsage, usageRefreshStatus, usageSnapshot } from './usage-store.ts';
import type { UsageChange } from './usage-store.ts';

import {
  DEFAULT_DAY_SORT,
  DEFAULT_DETAIL_SCREEN,
  DEFAULT_MODEL_SORT,
  DEFAULT_PERIOD_VIEW,
  DEFAULT_SESSION_SORT,
  HEATMAP_DAY_LABELS,
  LANE_SCOPE_HINT,
  OVERHEAD_SCOPE_HINT,
  PERIOD_VIEWS,
  PLAN_LIMIT_VENDORS,
  PLAN_WINDOWS,
  RANGE_OPTIONS,
  SESSION_ROW_LIMIT,
  USAGE_CAVEAT_SHORT,
  USAGE_DISABLED_HINT,
  anomalyLine,
  anomalyTone,
  ariaSortValue,
  blockHistoryRows,
  blockLabel,
  budgetRowMeterLabel,
  budgetRowPct,
  budgetRows,
  budgetRowText,
  budgetScopeLabel,
  budgetSummary,
  cacheSavingsTile,
  claudeOnlyHint,
  compositionParts,
  dailyRowForDay,
  dayRangeLabel,
  formatPercent,
  formatTokens,
  formatUsd,
  glimmervoidLaneCostUSD,
  glimmervoidOverhead,
  hasAnomaly,
  hasLaneAttribution,
  hasMultiVendorUsage,
  hasSavings,
  heatmapCells,
  heatmapCellTitle,
  historyDayCount,
  historyNote,
  isGlimmervoidSessionRow,
  isUsageUnavailable,
  laneLabel,
  laneRows,
  laneSessionsText,
  lastActivityMs,
  missingPricingLine,
  modelLabel,
  modelRowPrefix,
  nextSortState,
  overheadLanesText,
  overheadPlanText,
  paceSubText,
  paceVerdict,
  nextPaceResetMs,
  paceWindows,
  percentOfTotal,
  periodDayKeys,
  periodLabel,
  periodRows,
  planLimitAgeText,
  planLimitStaleNote,
  prReviewsSpendTile,
  rangeDays,
  rangeLabel,
  reportDayKey,
  resetClockText,
  sessionOverflowText,
  sessionRowLabel,
  sessionsSummary,
  shareBasis,
  shareLabel,
  sortDailyRows,
  sortModelRows,
  sortSessionRows,
  topModelSummary,
  usageErrorLine,
  usageWarningLine,
  vendorTotalsRows,
  visibleSessionRows,
  yourDayHint,
} from './usage-view-core.ts';
import type { PaceWindow, PlanLimits, SortState, UsageDetailScreen, UsageScreen, UsageTotals, UsageWireRow } from './usage-view-core.ts';

type FocusTarget =
  | { kind: 'sort'; table: string; key: string }
  | { kind: 'period'; view: string }
  | { kind: 'day'; day: string }
  | { kind: 'sessions-toggle' }
  | { kind: 'range'; value: string }
  | { kind: 'back' }
  | { kind: 'drill'; screen: UsageDetailScreen };

interface TableHeading {
  label: string;
  numeric?: boolean;
  key?: string;
}

interface TableCell {
  text?: string;
  node?: Node | null;
  numeric?: boolean;
  className?: string | null;
  title?: string;
  span?: number;
}

let _usage = usageSnapshot();
let _root: HTMLDivElement | null = null;

let _daySort: SortState = DEFAULT_DAY_SORT;
let _modelSort: SortState = DEFAULT_MODEL_SORT;
let _sessionSort: SortState = DEFAULT_SESSION_SORT;
let _sessionsExpanded = false;
let _focusAfterRender: FocusTarget | null = null;
let _periodView: string = DEFAULT_PERIOD_VIEW;
const _expandedDays = new Set<string>();
let _screen: UsageScreen = 'overview';
let _detailScreen: UsageDetailScreen = DEFAULT_DETAIL_SCREEN;
let _shouldScrollToTop = false;
let _resetRenderTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let _reportAgeEl: HTMLParagraphElement | null = null;
let _sessionsTsEl: HTMLParagraphElement | null = null;
let _refreshButtonEl: HTMLButtonElement | null = null;
let _refreshStatusEl: HTMLSpanElement | null = null;

const _ticker = createPollAgoTicker(() => _root);

const buildSection = (title: string, hint?: string | null) => buildPanelSection('usage', title, hint);

function buildTile(label: string, value: string, sub?: string | null, tone?: string | null) {
  const tile = el('div', 'usage-tile');
  if (tone && tone !== 'ok') tile.dataset.tone = tone;
  const valueEl = el('span', 'usage-tile-value', value);
  tile.append(valueEl, el('span', 'usage-tile-label', label));
  const subEl = sub ? el('span', 'usage-tile-sub', sub) : null;
  if (subEl) tile.append(subEl);
  return { tile, valueEl, subEl };
}

function clampPct(pct: unknown) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 100);
}

function buildMeter(pct: unknown, tone: unknown, label: string) {
  const meter = el('div', 'usage-meter');
  meter.dataset.tone = String(tone);
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-label', label);
  const fill = el('span', 'usage-meter-fill');
  meter.append(fill);
  paintMeter(meter, pct);
  return meter;
}

function paintMeter(meter: HTMLElement | null, pct: unknown) {
  if (!meter) return;
  const value = clampPct(pct);
  meter.setAttribute('aria-valuenow', String(Math.round(value)));
  const fill = meter.querySelector<HTMLElement>('.usage-meter-fill');
  if (fill) fill.style.width = `${value}%`;
}

function buildTable(headings: TableHeading[], sort: SortState | null, onSort: (key: string) => void, tableId: string) {
  const wrap = el('div', 'usage-table-scroll');
  wrap.dataset.usageTable = tableId;
  const table = el('table', 'usage-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of headings) {
    const cell = el('th', heading.numeric ? 'usage-num' : null);
    cell.scope = 'col';
    if (!heading.key) {
      cell.textContent = heading.label;
      headRow.append(cell);
      continue;
    }
    const sortKey = heading.key;
    cell.setAttribute('aria-sort', ariaSortValue(sort, sortKey));
    const button = el('button', 'usage-sort', heading.label);
    button.type = 'button';
    button.dataset.sortKey = sortKey;
    button.addEventListener('click', () => {
      reportUsageAction('sort');
      _focusAfterRender = { kind: 'sort', table: tableId, key: sortKey };
      onSort(sortKey);
    });
    cell.append(button);
    headRow.append(cell);
  }
  head.append(headRow);
  const body = el('tbody');
  table.append(head, body);
  wrap.append(table);
  return { wrap, body };
}

function appendCells(row: HTMLElement, cells: TableCell[]) {
  for (const cell of cells) {
    const td = el('td', cell.numeric ? 'usage-num' : cell.className || null, cell.node ? null : cell.text);
    if (cell.node) td.append(cell.node);
    if (cell.title) td.title = cell.title;
    if (cell.span) td.colSpan = cell.span;
    row.append(td);
  }
}

function buildShareCell(pct: number | null) {
  const wrap = el('div', 'usage-share');
  if (!Number.isFinite(pct)) {
    wrap.append(el('span', 'usage-share-text', formatPercent(pct)));
    return wrap;
  }
  const bar = el('span', 'usage-share-bar');
  const fill = el('span', 'usage-share-fill');
  fill.style.width = `${clampPct(pct)}%`;
  bar.append(fill);
  wrap.append(bar, el('span', 'usage-share-text', formatPercent(pct)));
  return wrap;
}

function paintReportAge() {
  if (!_reportAgeEl?.isConnected) return;
  const ts = Number(_usage.report?.ts);
  _reportAgeEl.textContent = Number.isFinite(ts) && ts > 0 ? `Report ${formatAgo(ts)}` : '';
}

function paintSessionsTs() {
  if (!_sessionsTsEl?.isConnected) return;
  const ts = Number(_usage.sessions?.ts);
  _sessionsTsEl.textContent = Number.isFinite(ts) && ts > 0 ? `Sessions ${formatAgo(ts)}` : '';
}

function buildRefreshControls() {
  const controls = el('div', 'usage-controls');
  const button = el('button', 'usage-refresh', 'Refresh');
  button.type = 'button';
  button.title = 'Re-read every transcript from the start';
  button.addEventListener('click', () => {
    reportUsageAction('refresh');
    requestUsageReport({ force: true });
  });
  const status = el('span', 'usage-refresh-status', '');
  _refreshButtonEl = button;
  _refreshStatusEl = status;
  paintRefreshStatus();
  _reportAgeEl = el('p', 'usage-meta', '');
  paintReportAge();
  _ticker.onTick(paintReportAge);
  controls.append(button, status, _reportAgeEl);
  return controls;
}

function buildReportWarnings() {
  const lines = [usageWarningLine(_usage.report), missingPricingLine(_usage.report?.pricing?.missing)].filter(Boolean);
  return lines.map((line) => el('p', 'usage-warning', line));
}

function todayCostUSD() {
  if (!_usage.report) return null;
  const today = dailyRowForDay(_usage.report.daily, reportDayKey(_usage.report));
  return typeof today?.costUSD === 'number' && Number.isFinite(today.costUSD) ? today.costUSD : 0;
}

function buildVerdict(windows: readonly PaceWindow[], now: number) {
  const verdict = paceVerdict(windows, budgetRows(_usage.report), todayCostUSD(), now);
  const box = el('div', 'usage-verdict');
  box.dataset.tone = verdict.tone;
  box.append(el('p', 'usage-verdict-headline', verdict.headline), el('p', verdict.tone === 'ok' ? 'usage-verdict-detail' : 'usage-verdict-detail usage-warning', verdict.detail));
  return box;
}

function buildPaceSection(windows: readonly PaceWindow[], now: number) {
  if (windows.length === 0) return null;
  const section = el('section', 'usage-pace');
  section.setAttribute('aria-label', 'Plan limits');
  for (const { vendor, label } of PLAN_LIMIT_VENDORS) {
    const vendorWindows = windows.filter((window) => window.vendor === vendor);
    if (vendorWindows.length === 0) continue;
    section.append(buildPaceVendor(label, _usage.planLimitsByVendor[vendor], vendorWindows, now));
  }
  section.append(buildPaceLegend());
  return section;
}

function buildPaceVendor(label: string, planLimits: PlanLimits | null, windows: readonly PaceWindow[], now: number) {
  const group = el('div', 'usage-pace-vendor');
  const head = el('div', 'usage-pace-vendor-head');
  head.append(el('h3', 'usage-eyebrow', label));
  const ageEl = el('span', 'usage-meta', '');
  head.append(ageEl);
  const paintAge = () => {
    if (!ageEl.isConnected) return;
    const age = planLimitAgeText(planLimits?.ts);
    ageEl.textContent = age ? `official, ${age}` : 'official';
  };
  paintAge();
  _ticker.onTick(paintAge);
  group.append(head);
  const stale = planLimitStaleNote(planLimits?.ts);
  if (stale) {
    const note = el('p', 'usage-meta', stale);
    note.dataset.tone = 'warn';
    group.append(note);
  }
  for (const window of windows) group.append(buildPaceWindow(window, now));
  return group;
}

function buildPaceWindow(window: PaceWindow, now: number) {
  const row = el('div', 'usage-pace-window');
  row.dataset.tone = window.tone;
  const head = el('div', 'usage-pace-head');
  head.append(el('span', 'usage-pace-label', PLAN_WINDOWS.find((spec) => spec.key === window.key)?.label || window.windowLabel));
  head.append(el('span', 'usage-pace-used', `${Math.round(window.usedPct)}%`));
  const clock = resetClockText(window.resetsAtMs, now);
  head.append(el('span', 'usage-pace-reset', clock ? `resets ${clock}` : ''));
  row.append(head, buildPaceBar(window));
  const sub = paceSubText(window);
  if (sub) row.append(el('p', 'usage-pace-sub', sub));
  return row;
}

function buildPaceBar(window: PaceWindow) {
  const bar = el('div', 'usage-pacebar');
  bar.setAttribute('role', 'img');
  const usedPct = clampPct(window.usedPct);
  const described = [`${Math.round(window.usedPct)}% used`];
  const fill = el('span', 'usage-pacebar-fill');
  fill.style.width = `${usedPct}%`;
  bar.append(fill);
  if (window.projectedPct !== null && window.projectedPct > window.usedPct) {
    const projection = el('span', 'usage-pacebar-projection');
    projection.style.left = `${usedPct}%`;
    projection.style.width = `${clampPct(window.projectedPct) - usedPct}%`;
    bar.append(projection);
    described.push(`about ${Math.round(window.projectedPct)}% projected at reset`);
  }
  if (window.elapsedPct !== null) {
    const tick = el('span', 'usage-pacebar-tick');
    tick.style.left = `${clampPct(window.elapsedPct)}%`;
    bar.append(tick);
    described.push(`${Math.round(window.elapsedPct)}% of the window gone`);
  }
  bar.setAttribute('aria-label', `${window.vendorLabel} ${window.windowLabel} limit: ${described.join(', ')}`);
  return bar;
}

function buildPaceLegend() {
  const legend = el('div', 'usage-pace-legend');
  legend.setAttribute('aria-hidden', 'true');
  for (const [part, label] of [['fill', 'used'], ['projection', 'projected'], ['tick', 'time gone']]) {
    const item = el('span', 'usage-pace-legend-item');
    const swatch = el('span', 'usage-pace-swatch');
    swatch.dataset.part = part;
    item.append(swatch, el('span', null, label));
    legend.append(item);
  }
  return legend;
}

function buildWindowCard(now: number) {
  const card = el('section', 'usage-window');
  const blockHours = _usage.report?.blockHours;
  const hours = typeof blockHours === 'number' && Number.isFinite(blockHours) ? blockHours : 5;
  card.append(el('h3', 'usage-eyebrow', `This ${hours}-hour window, Claude`));
  const block = _usage.report?.activeBlock;
  if (!block) {
    card.append(buildIdleLine());
    return card;
  }
  card.append(el('p', 'usage-window-figure', `${formatUsd(block.costUSD ?? 0)} so far`));
  const rate = Number.isFinite(block.burn?.costPerHour) ? `${formatUsd(block.burn?.costPerHour)} an hour` : '';
  card.append(el('p', 'usage-window-sub', [rate, `${formatTokens(block.tokens ?? 0)} tokens`].filter(Boolean).join(', ')));
  const projectedCost = block.projection?.projectedCostUSD;
  const endClock = resetClockText(block.endTs, now);
  if (Number.isFinite(projectedCost) && endClock) card.append(el('p', 'usage-meta', `Heading for ${formatUsd(projectedCost)} by ${endClock}`));
  const anomaly = buildAnomalyLine();
  if (anomaly) card.append(anomaly);
  return card;
}

function buildIdleLine() {
  const lastTs = lastActivityMs(_usage.report?.blocks);
  if (lastTs === null) return el('p', 'usage-empty', 'No Claude activity in this range. A window opens with the next Claude turn.');
  const line = el('p', 'usage-empty', 'No window open. Last Claude activity ');
  const ago = el('span', 'usage-ago', '');
  _ticker.track(ago, lastTs, formatAgo);
  line.append(ago, '.');
  return line;
}

function buildDrillRow(screen: UsageDetailScreen, label: string, detail: string, value: string) {
  const button = el('button', 'usage-drill');
  button.type = 'button';
  button.dataset.usageScreen = screen;
  if (_detailScreen === screen) button.setAttribute('aria-current', 'true');
  const text = el('span', 'usage-drill-text');
  text.append(el('span', 'usage-drill-label', label));
  if (detail) text.append(el('span', 'usage-drill-detail', detail));
  button.append(text, el('span', 'usage-drill-value', value), el('span', 'usage-drill-chevron'));
  button.addEventListener('click', () => openScreen(screen));
  return button;
}

function buildDrillRows() {
  const nav = el('nav', 'usage-drills');
  nav.setAttribute('aria-label', 'Usage details');
  const report = _usage.report;
  const periodText = rangeLabel(_usage.rangeValue);
  nav.append(buildDrillRow('report', 'Spend', `${periodText}, est. list price`, formatUsd(report?.totals?.costUSD ?? 0)));
  const topModel = topModelSummary(report);
  nav.append(buildDrillRow('report', 'Models', topModel ? `${topModel.label} leads` : 'none yet', topModel ? formatPercent(topModel.sharePct) : ''));
  const sessions = sessionsSummary(report);
  nav.append(buildDrillRow('report', 'Sessions', sessions.topLabel ? `top: ${sessions.topLabel}` : 'none yet', String(sessions.count)));
  const dayCount = historyDayCount(report?.daily);
  nav.append(buildDrillRow('history', 'History', 'daily heatmap, past windows', `${dayCount} ${dayCount === 1 ? 'day' : 'days'}`));
  const overheadCost = glimmervoidLaneCostUSD(report);
  if (overheadCost !== null || glimmervoidOverhead(report, _usage.planLimitsByVendor.claude).length > 0) {
    nav.append(buildDrillRow('overhead', 'Glimmervoid overhead', 'sessions it spawns for its own work', overheadCost === null ? '' : formatUsd(overheadCost)));
  }
  const budgets = budgetRows(report);
  if (budgets.length > 0) {
    const summary = budgetSummary(budgets);
    nav.append(buildDrillRow('budgets', 'Budgets', summary.detail, summary.value));
  }
  return nav;
}

function scheduleResetRender(windows: readonly PaceWindow[], now: number) {
  if (_resetRenderTimer) clearTimeout(_resetRenderTimer);
  _resetRenderTimer = null;
  const nextResetMs = nextPaceResetMs(windows);
  if (nextResetMs === null) return;
  _resetRenderTimer = setTimeout(() => {
    _resetRenderTimer = null;
    render();
  }, Math.min(nextResetMs - now + 1000, MAX_TIMER_DELAY_MS));
}

function buildOverview() {
  const overview = el('div', 'usage-overview');
  const now = Date.now();
  const windows = paceWindows(_usage.planLimitsByVendor, now);
  scheduleResetRender(windows, now);
  if (isUsageUnavailable(_usage.report)) {
    overview.append(buildUnavailableSection());
    const pace = buildPaceSection(windows, now);
    if (pace) overview.append(pace);
    overview.append(buildRefreshControls());
    return overview;
  }
  if (_usage.report) overview.append(buildVerdict(windows, now));
  overview.append(...buildReportWarnings());
  const pace = buildPaceSection(windows, now);
  if (pace) overview.append(pace);
  if (!_usage.report) {
    overview.append(el('p', 'usage-empty', 'Waiting for the first usage scan. Figures appear once it finishes.'));
    overview.append(buildRefreshControls());
    return overview;
  }
  overview.append(buildWindowCard(now), buildDrillRows(), buildRefreshControls());
  return overview;
}

function buildRangeSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Report period');
  for (const option of RANGE_OPTIONS) {
    const button = el('button', 'usage-period-button', PERIOD_VIEWS.find((view) => view.value === option.value)?.label || option.label);
    button.type = 'button';
    button.dataset.usageRange = option.value;
    button.setAttribute('aria-pressed', option.value === _usage.rangeValue ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (_usage.rangeValue === option.value) return;
      reportUsageAction('period');
      setUsageRange(option.value);
      _focusAfterRender = { kind: 'range', value: option.value };
      requestUsageReport();
      render();
    });
    group.append(button);
  }
  return group;
}

function buildBackControl() {
  const back = el('button', 'usage-back', 'Back');
  back.type = 'button';
  back.addEventListener('click', closeScreen);
  return back;
}

function buildReportScreen() {
  const screen = el('div', 'usage-screen');
  screen.append(buildBackControl(), buildSection('Report', dayRangeLabel(periodDayKeys(reportDayKey(_usage.report), rangeDays(_usage.rangeValue)))), buildRangeSwitch());
  const yourDay = buildYourDaySection();
  if (yourDay) screen.append(yourDay);
  screen.append(buildTotalsSection());
  const savings = buildSavingsSection();
  if (savings) screen.append(savings);
  screen.append(buildModelsSection(), buildSessionsSection());
  return screen;
}

function buildHistoryScreen() {
  const screen = el('div', 'usage-screen');
  screen.append(buildBackControl(), buildDailySection());
  const blocks = buildBlockHistorySection();
  if (blocks) screen.append(blocks);
  return screen;
}

function buildOverheadScreen() {
  const screen = el('div', 'usage-screen');
  screen.append(buildBackControl(), buildOverheadSection() || buildNoOverhead());
  return screen;
}

function buildBudgetsScreen() {
  const screen = el('div', 'usage-screen');
  screen.append(buildBackControl(), buildBudgetsSection() || buildNoBudgets());
  return screen;
}

function buildNoOverhead() {
  const section = buildSection('Glimmervoid overhead', '');
  section.append(el('p', 'usage-empty', 'Glimmervoid spawned no sessions of its own in this range.'));
  return section;
}

function buildNoBudgets() {
  const section = buildSection('Budgets', 'your own ceilings');
  const empty = el('p', 'usage-empty', 'No budgets set. ');
  empty.append(createSettingsLink('machine-usage', 'usage-daily-budget', 'Budget settings'));
  section.append(empty);
  return section;
}

const DETAIL_BUILDERS: Readonly<Record<UsageDetailScreen, () => HTMLElement>> = Object.freeze({
  report: buildReportScreen,
  history: buildHistoryScreen,
  overhead: buildOverheadScreen,
  budgets: buildBudgetsScreen,
});

function buildDetail() {
  const detail = el('div', 'usage-detail');
  if (!_usage.report || isUsageUnavailable(_usage.report)) return detail;
  detail.append(DETAIL_BUILDERS[_detailScreen]());
  return detail;
}

function openScreen(screen: UsageDetailScreen) {
  reportUsageAction('expand');
  _screen = screen;
  _detailScreen = screen;
  _focusAfterRender = { kind: 'back' };
  _shouldScrollToTop = true;
  render();
}

function closeScreen() {
  const previous = _detailScreen;
  _screen = 'overview';
  _focusAfterRender = { kind: 'drill', screen: previous };
  _shouldScrollToTop = true;
  render();
}

function buildYourDaySection() {
  const yourDay = _usage.report?.yourDay;
  if (!yourDay) return null;
  const section = buildSection('Your day', yourDayHint(yourDay, Date.now()));
  if (yourDay.insights.length === 0) return section;
  const insights = el('ul', 'usage-your-day-insights');
  for (const insight of yourDay.insights) insights.append(el('li', 'usage-your-day-insight', insight.text));
  section.append(insights);
  return section;
}

function buildOverheadSection() {
  const windows = glimmervoidOverhead(_usage.report, _usage.planLimitsByVendor.claude);
  const lanesTable = buildLanesTable();
  if (windows.length === 0 && !lanesTable) return null;
  const section = buildSection('Glimmervoid overhead', windows.length > 0 ? OVERHEAD_SCOPE_HINT : null);
  if (windows.length > 0) {
    const tiles = el('div', 'usage-tiles');
    for (const window of windows) {
      const detail = [overheadPlanText(window), formatUsd(window.costUSD)].filter(Boolean).join(', ');
      tiles.append(buildTile(`${window.label}, share of Claude use`, formatPercent(window.sharePct), detail).tile);
    }
    section.append(tiles);
    for (const window of windows) {
      const lanesText = overheadLanesText(window);
      if (lanesText) section.append(el('p', 'usage-meta', `${window.label}: ${lanesText}`));
    }
  }
  if (lanesTable) {
    section.append(el('p', 'usage-meta', `Selected range by lane. ${LANE_SCOPE_HINT}`));
    section.append(lanesTable);
  }
  return section;
}

function buildLanesTable() {
  if (!hasLaneAttribution(_usage.report)) return null;
  const rows = laneRows(_usage.report);
  const totalCost = rows.reduce((sum, row) => sum + (typeof row.costUSD === 'number' && Number.isFinite(row.costUSD) ? row.costUSD : 0), 0);
  const { wrap, body } = buildTable(
    [
      { label: 'Lane' },
      { label: 'Cost', numeric: true },
      { label: 'Tokens', numeric: true },
      { label: 'Sessions', numeric: true },
      { label: 'Share', numeric: true },
    ],
    null,
    () => {},
    'lane',
  );
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    if (row.lane === 'other') tr.dataset.lane = 'other';
    appendCells(tr, [
      { text: laneLabel(row.lane), className: 'usage-lane-cell' },
      { text: formatUsd(row.costUSD), numeric: true },
      { text: formatTokens(row.tokens), numeric: true },
      { text: laneSessionsText(row.sessions), numeric: true },
      { node: buildShareCell(percentOfTotal(row.costUSD, totalCost)), className: 'usage-share-cell' },
    ]);
    body.append(tr);
  }
  return wrap;
}

function buildAnomalyLine() {
  const anomaly = _usage.report?.anomaly;
  if (!hasAnomaly(anomaly)) return null;
  const line = el('p', 'usage-meta', anomalyLine(anomaly));
  line.dataset.tone = anomalyTone(anomaly);
  return line;
}

function buildBlockHistorySection() {
  const rows = blockHistoryRows(_usage.report?.blocks);
  if (rows.length === 0) return null;
  const claudeOnly = claudeOnlyHint(_usage.report?.totals);
  const section = buildSection('Recent blocks', claudeOnly ? `newest first, ${claudeOnly}` : 'newest first');
  const list = el('div', 'usage-blocks');
  const peak = rows.reduce((best, row) => Math.max(best, row.tokens), 0);
  for (const row of rows) {
    const item = el('div', 'usage-block');
    if (row.isActive) item.dataset.active = 'true';
    item.append(el('span', 'usage-block-label', blockLabel(row.startTs)));
    const bar = el('span', 'usage-block-bar');
    const fill = el('span', 'usage-block-fill');
    fill.style.width = `${clampPct(percentOfTotal(row.tokens, peak) ?? 0)}%`;
    bar.append(fill);
    item.append(bar);
    item.append(el('span', 'usage-block-value', `${formatTokens(row.tokens)} ${formatUsd(row.costUSD)}`));
    list.append(item);
  }
  section.append(list);
  return section;
}

function buildTotalsSection() {
  const totals = _usage.report?.totals || {};
  const today = dailyRowForDay(_usage.report?.daily, reportDayKey(_usage.report));
  const hint = [USAGE_CAVEAT_SHORT, _usage.report?.tz ? `TZ ${_usage.report.tz}` : ''].filter(Boolean).join(' ');
  const section = buildSection('Totals', hint);
  const tiles = el('div', 'usage-tiles');
  tiles.append(buildTile('today', formatTokens(today?.tokens ?? 0), formatUsd(today?.costUSD ?? 0)).tile);
  tiles.append(buildTile('range total', formatTokens(totals.tokens ?? 0), formatUsd(totals.costUSD ?? 0)).tile);
  const prReviews = prReviewsSpendTile(_usage.report);
  if (prReviews) tiles.append(buildTile(prReviews.label, prReviews.value, prReviews.sub).tile);
  section.append(tiles);
  const composition = buildCompositionRow(totals);
  if (composition) section.append(composition);

  const vendorRows = hasMultiVendorUsage(totals) ? vendorTotalsRows(totals) : [];
  if (vendorRows.length > 0) {
    const vendorTiles = el('div', 'usage-tiles usage-vendor-tiles');
    for (const row of vendorRows) {
      vendorTiles.append(buildTile(row.label, formatTokens(row.tokens), formatUsd(row.costUSD)).tile);
    }
    section.append(vendorTiles);
  }
  _sessionsTsEl = el('p', 'usage-meta', '');
  section.append(_sessionsTsEl);
  paintSessionsTs();
  _ticker.onTick(paintSessionsTs);
  return section;
}

function buildCompositionRow(totals: UsageTotals | null | undefined) {
  const parts = compositionParts(totals);
  if (parts.length === 0) return null;
  const wrap = el('div', 'usage-compo');

  const bar = el('div', 'usage-compo-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const part of parts) {
    if (part.pct <= 0) continue;
    const fill = el('span', 'usage-compo-fill');
    fill.dataset.part = part.key;
    fill.style.width = `${part.pct}%`;
    fill.title = part.title;
    bar.append(fill);
  }
  const legend = el('div', 'usage-compo-legend');
  for (const part of parts) {
    const item = el('span', 'usage-compo-item');
    const swatch = el('span', 'usage-compo-swatch');
    swatch.dataset.part = part.key;
    item.append(swatch, el('span', 'usage-compo-label', part.label), el('span', 'usage-compo-value', part.value));
    legend.append(item);
  }
  wrap.append(bar, legend);
  return wrap;
}

function buildSavingsSection() {
  const savings = _usage.report?.savings;
  if (!hasSavings(savings)) return null;
  const section = buildSection('Savings', '');
  const tiles = el('div', 'usage-tiles');
  const cache = cacheSavingsTile(savings);
  if (cache) tiles.append(buildTile('Prompt cache', cache.value, cache.sub).tile);
  section.append(tiles);
  return section;
}

function buildBudgetsSection() {
  const rows = budgetRows(_usage.report);
  if (rows.length === 0) return null;
  const section = buildSection('Budgets', 'your own ceilings');

  const wrap = el('div', 'usage-budgets');
  const settingsLink = createSettingsLink('machine-usage', 'usage-daily-budget', 'Budget settings');
  wrap.appendChild(settingsLink);
  for (const row of rows) {
    const item = el('div', 'usage-budget');
    const head = el('div', 'usage-budget-head');
    head.append(el('span', 'usage-budget-label', budgetScopeLabel(row.scope)));
    head.append(el('span', 'usage-budget-value', budgetRowText(row)));
    head.append(el('span', 'usage-budget-pct', formatPercent(budgetRowPct(row))));
    item.append(head);
    item.append(buildMeter(budgetRowPct(row), row.tone, budgetRowMeterLabel(row)));
    wrap.append(item);
  }
  section.append(wrap);
  return section;
}

function buildDailySection() {
  const daily = _usage.report?.daily || [];
  const periodView = _periodView;
  const rows = sortDailyRows(periodRows(daily, periodView), _daySort);
  const columnLabel = PERIOD_VIEWS.find((view) => view.value === periodView)?.label || 'Day';
  const hints = [historyNote(daily)].filter(Boolean);
  const section = buildSection('Over time', hints.join(', '));
  section.append(buildPeriodSwitch());
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No usage.'));
    return section;
  }
  const heatmap = buildHeatmap(daily);
  if (heatmap) section.append(heatmap);
  const { wrap, body } = buildTable(
    [
      { label: columnLabel, key: 'day' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Models' },
    ],
    _daySort,
    (key) => {
      _daySort = nextSortState(_daySort, key);
      render();
    },
    'day',
  );
  for (const row of rows) {
    const day = String(row.day ?? '');
    const tr = el('tr', 'usage-row');
    if (row.source === 'history') tr.dataset.source = 'history';
    const models = sortModelRows(row.models);

    const expandKey = `${periodView}:${day}`;
    const toggle = buildBreakdownToggle(expandKey, models.length);
    appendCells(tr, [
      { node: buildPeriodCell(row, periodView), title: day },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: toggle, className: 'usage-toggle-cell' },
    ]);
    body.append(tr);
    if (models.length === 0) continue;
    if (!_expandedDays.has(expandKey)) continue;
    body.append(buildBreakdownRow(models));
  }
  section.append(wrap);
  return section;
}

function buildPeriodSwitch() {
  const group = el('div', 'usage-period');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Period');
  for (const view of PERIOD_VIEWS) {
    const button = el('button', 'usage-period-button', view.label);
    button.type = 'button';
    button.dataset.periodView = view.value;
    button.setAttribute('aria-pressed', view.value === _periodView ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (_periodView === view.value) return;
      reportUsageAction('period');
      _periodView = view.value;
      _focusAfterRender = { kind: 'period', view: view.value };
      render();
    });
    group.append(button);
  }
  return group;
}

function buildPeriodCell(row: UsageWireRow, periodView: string) {
  const wrap = el('span', 'usage-period-cell');
  wrap.append(el('span', null, periodLabel(row.day, periodView)));
  if (row.source === 'history') wrap.append(el('span', 'usage-history-tag', 'history'));
  return wrap;
}

function buildHeatmap(daily: unknown) {
  const { cells, max } = heatmapCells(daily, { today: reportDayKey(_usage.report) });
  if (cells.length === 0 || max <= 0) return null;
  const wrap = el('div', 'usage-heatmap-scroll');
  const grid = el('div', 'usage-heatmap');
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `Daily usage for the trailing ${Math.max(...cells.map((cell) => cell.week)) + 1} weeks`);
  const labels = el('div', 'usage-heatmap-days');
  for (const label of HEATMAP_DAY_LABELS) labels.append(el('span', 'usage-heatmap-day', label));
  for (const cell of cells) {
    const box = el('span', 'usage-heatmap-cell');
    box.dataset.tone = String(cell.tone);
    if (cell.noData) box.dataset.noData = 'true';
    if (cell.source === 'history') box.dataset.source = 'history';
    box.style.gridColumn = String(cell.week + 1);
    box.style.gridRow = String(cell.weekday + 1);
    box.title = heatmapCellTitle(cell);
    grid.append(box);
  }
  wrap.append(labels, grid);
  return wrap;
}

function buildBreakdownToggle(expandKey: string, modelCount: number) {
  if (modelCount === 0) return null;
  const button = el('button', 'usage-toggle', 'Models');
  button.type = 'button';
  button.dataset.usageDay = expandKey;
  button.setAttribute('aria-expanded', _expandedDays.has(expandKey) ? 'true' : 'false');
  button.addEventListener('click', () => {
    reportUsageAction('expand');
    _focusAfterRender = { kind: 'day', day: expandKey };
    if (_expandedDays.has(expandKey)) {
      _expandedDays.delete(expandKey);
      render();
      return;
    }
    _expandedDays.add(expandKey);
    render();
  });
  return button;
}

function buildBreakdownRow(models: UsageWireRow[]) {
  const breakdown = el('tr', 'usage-row-breakdown');
  const cell = el('td', 'usage-models');
  cell.colSpan = 4;
  for (const model of models) {
    const chip = el('span', 'usage-model-chip');
    chip.append(
      el('span', 'usage-model-name', modelLabel(model)),
      el('span', 'usage-model-value', `${formatTokens(model.tokens)} ${formatUsd(model.costUSD)}`),
    );
    cell.append(chip);
  }
  breakdown.append(cell);
  return breakdown;
}

function buildModelCell(row: UsageWireRow, totals: UsageTotals) {
  const wrap = el('span', 'usage-model-name-wrap');
  const prefix = modelRowPrefix(row, totals);
  if (prefix) wrap.append(el('span', 'usage-vendor-tag', prefix));
  wrap.append(el('span', null, modelLabel(row)));
  return wrap;
}

function buildModelsSection() {
  const rows = sortModelRows(_usage.report?.models, _modelSort);
  const totals = _usage.report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By model', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No models.'));
    return section;
  }
  const { wrap, body } = buildTable(
    [
      { label: 'Model', key: 'model' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Share', numeric: true },
      { label: 'Input', numeric: true, key: 'input' },
      { label: 'Output', numeric: true, key: 'output' },
      { label: 'Cache write', numeric: true, key: 'cacheCreate' },
      { label: 'Cache read', numeric: true, key: 'cacheRead' },
    ],
    _modelSort,
    (key) => {
      _modelSort = nextSortState(_modelSort, key);
      render();
    },
    'model',
  );
  for (const row of rows) {
    const tr = el('tr', 'usage-row');
    appendCells(tr, [
      { node: buildModelCell(row, totals), className: 'usage-model-cell', title: modelLabel(row) },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: buildShareCell(percentOfTotal(row[basis], totals[basis])), className: 'usage-share-cell' },
      { text: formatTokens(row.input), numeric: true },
      { text: formatTokens(row.output), numeric: true },
      { text: formatTokens(row.cacheCreate), numeric: true },
      { text: formatTokens(row.cacheRead), numeric: true },
    ]);
    body.append(tr);
  }
  section.append(wrap);
  return section;
}

function buildSessionsSection() {
  const rows = sortSessionRows(_usage.report?.sessions, _sessionSort);
  const visible = visibleSessionRows(rows, _sessionsExpanded);
  const totals = _usage.report?.totals || {};
  const basis = shareBasis(totals);
  const section = buildSection('By session', shareLabel(basis));
  if (rows.length === 0) {
    section.append(el('p', 'usage-empty', 'No sessions.'));
    return section;
  }
  const { wrap, body } = buildTable(
    [
      { label: 'Session', key: 'label' },
      { label: 'Tokens', numeric: true, key: 'tokens' },
      { label: 'Cost', numeric: true, key: 'costUSD' },
      { label: 'Share', numeric: true },
      { label: 'Last activity', numeric: true, key: 'lastTs' },
    ],
    _sessionSort,
    (key) => {
      _sessionSort = nextSortState(_sessionSort, key);
      render();
    },
    'session',
  );
  for (const row of visible.rows) {
    const tr = el('tr', 'usage-row');
    if (isGlimmervoidSessionRow(row)) tr.dataset.managed = 'true';
    const label = sessionRowLabel(row);
    const agoCell = el('span', 'usage-ago', '');
    appendCells(tr, [
      { text: label, className: 'usage-session-cell', title: row.project ? String(row.project) : label },
      { text: formatTokens(row.tokens), numeric: true },
      { text: formatUsd(row.costUSD), numeric: true },
      { node: buildShareCell(percentOfTotal(row[basis], totals[basis])), className: 'usage-share-cell' },
      { node: agoCell, numeric: true },
    ]);
    _ticker.track(agoCell, Number(row.lastTs), formatAgo);
    body.append(tr);
  }
  section.append(wrap);
  if (rows.length > SESSION_ROW_LIMIT) {
    section.append(buildSessionsOverflow(visible.hiddenCount));
  }
  return section;
}

function buildSessionsOverflow(hiddenCount: number) {
  const wrap = el('div', 'usage-overflow');
  const text = sessionOverflowText(hiddenCount);
  if (text) wrap.append(el('p', 'usage-meta', text));
  const button = el('button', 'usage-toggle', 'All sessions');
  button.type = 'button';
  button.dataset.usageSessionsToggle = 'true';
  button.setAttribute('aria-expanded', _sessionsExpanded ? 'true' : 'false');
  button.addEventListener('click', () => {
    reportUsageAction('expand');
    _focusAfterRender = { kind: 'sessions-toggle' };
    _sessionsExpanded = !_sessionsExpanded;
    render();
  });
  wrap.append(button);
  return wrap;
}

function buildUnavailableSection() {
  const section = buildSection('Not available', '');
  section.append(el('p', 'usage-empty', usageErrorLine(_usage.report)));
  section.append(el('p', 'usage-empty', USAGE_DISABLED_HINT));
  return section;
}

function clearRefs() {
  _reportAgeEl = null;
  _sessionsTsEl = null;
  _refreshButtonEl = null;
  _refreshStatusEl = null;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  _usage = usageSnapshot();
  const scroller = _root.parentElement;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  _ticker.reset();
  clearRefs();
  _root.textContent = '';
  buildBody();
  if (scroller) scroller.scrollTop = _shouldScrollToTop ? 0 : scrollTop;
  _shouldScrollToTop = false;
  restoreFocusAfterRender();
}

function restoreFocusAfterRender() {
  const target = _focusAfterRender;
  _focusAfterRender = null;
  if (!target) return;
  const selector = selectorForFocusTarget(target);
  if (!selector) return;
  if (!_root) return;
  const focusTarget = _root.querySelector(selector);
  if (!(focusTarget instanceof HTMLElement)) return;
  focusTarget.focus();
}

function selectorForFocusTarget(target: FocusTarget) {
  if (target.kind === 'day') return `.usage-toggle[data-usage-day="${CSS.escape(target.day)}"]`;
  if (target.kind === 'period') return `.usage-period-button[data-period-view="${CSS.escape(target.view)}"]`;
  if (target.kind === 'sessions-toggle') return '.usage-toggle[data-usage-sessions-toggle="true"]';
  if (target.kind === 'range') return `.usage-period-button[data-usage-range="${CSS.escape(target.value)}"]`;
  if (target.kind === 'back') return '.usage-back';
  if (target.kind === 'drill') return `.usage-drill[data-usage-screen="${CSS.escape(target.screen)}"]`;
  if (target.kind === 'sort') return `[data-usage-table="${CSS.escape(target.table)}"] .usage-sort[data-sort-key="${CSS.escape(target.key)}"]`;
  return null;
}

function buildBody() {
  if (!_root) return;
  _root.dataset.screen = _screen;
  const layout = el('div', 'usage-layout');
  layout.append(buildOverview(), buildDetail());
  _root.append(layout);
}

function paintRefreshStatus() {
  const status = usageRefreshStatus();
  if (_refreshButtonEl) _refreshButtonEl.disabled = status.isPending;
  if (!_refreshStatusEl) return;
  _refreshStatusEl.textContent = status.text;
  if (status.hasFailure) { _refreshStatusEl.dataset.tone = 'error'; return; }
  delete _refreshStatusEl.dataset.tone;
}

function applyUsageChange(change: UsageChange) {
  if (change === 'refresh-status') {
    paintRefreshStatus();
    return;
  }
  _usage = usageSnapshot();
  if (change === 'sessions' && _usage.report && !isUsageUnavailable(_usage.report) && _sessionsTsEl?.isConnected) {
    paintSessionsTs();
    return;
  }
  render();
}

function mountUsageView(parent: HTMLElement) {
  if (_root) return;
  const root = el('div', 'usage-content');
  parent.appendChild(root);
  _root = root;
  setUsageLookingProbe(() => !isPanelHidden(_root));
  subscribeUsage(applyUsageChange);
  _ticker.ensure();
  render({ force: true });
}

function refreshUsageView(reason: ViewRefreshReason) {
  if (reason === 'shown') render({ force: true });
  requestUsageReport();
}

export const view: ViewModule<HTMLElement> = { mount: mountUsageView, refresh: refreshUsageView };
