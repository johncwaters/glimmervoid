import { el } from '../dom-helpers.ts';
import { attachChartReadout } from '../chart-readout.ts';
import type { ChartReadoutCell } from '../chart-readout.ts';
import { createPressable } from '../ui/pressable.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { reportUsageAction } from './usage-store.ts';
import { DEFAULT_DAY_SORT, DEFAULT_PERIOD_VIEW, HEATMAP_DAY_LABELS, LANE_SCOPE_HINT, OVERHEAD_SCOPE_HINT, PERIOD_VIEWS, blockHistoryRows, blockLabel, budgetRowMeterLabel, budgetRowPct, budgetRows, budgetRowText, budgetScopeLabel, claudeOnlyHint, formatPercent, formatTokens, formatUsd, glimmervoidOverhead, hasLaneAttribution, heatmapCells, heatmapCellText, historyNote, laneLabel, laneRows, laneSessionsText, modelLabel, nextSortState, overheadLanesText, overheadPlanText, percentOfTotal, periodLabel, periodRows, reportDayKey, sortDailyRows, sortModelRows } from './usage-view-core.ts';
import type { SortState, UsageWireRow } from './usage-view-core.ts';
import { _usage, render, setFocusAfterRender } from './usage-panel-state.ts';
import { appendCells, buildBackControl, buildMeter, buildSection, buildShareCell, buildTable, buildTile, clampPct } from './usage-panel-parts.ts';

let _daySort: SortState = DEFAULT_DAY_SORT;

let _periodView: string = DEFAULT_PERIOD_VIEW;

const _expandedDays = new Set<string>();

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
      { node: buildPeriodCell(row, periodView) },
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
    const periodOption = createPressable('usage-period-button', view.label);
    periodOption.dataset.periodView = view.value;
    periodOption.setAttribute('aria-pressed', view.value === _periodView ? 'true' : 'false');
    periodOption.addEventListener('click', () => {
      if (_periodView === view.value) return;
      reportUsageAction('period');
      _periodView = view.value;
      setFocusAfterRender({ kind: 'period', view: view.value });
      render();
    });
    group.append(periodOption);
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
  const todayKey = reportDayKey(_usage.report);
  const { cells, max } = heatmapCells(daily, { today: todayKey });
  if (cells.length === 0 || max <= 0) return null;
  const wrap = el('div', 'usage-heatmap-scroll');
  const grid = el('div', 'usage-heatmap');
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `Daily usage for the trailing ${Math.max(...cells.map((cell) => cell.week)) + 1} weeks`);
  const labels = el('div', 'usage-heatmap-days');
  for (const label of HEATMAP_DAY_LABELS) labels.append(el('span', 'usage-heatmap-day', label));
  const readoutCells: ChartReadoutCell[] = [];
  let todayCell: HTMLElement | undefined;
  for (const cell of cells) {
    const box = el('span', 'usage-heatmap-cell');
    box.dataset.tone = String(cell.tone);
    if (cell.noData) box.dataset.noData = 'true';
    if (cell.source === 'history') box.dataset.source = 'history';
    box.style.gridColumn = String(cell.week + 1);
    box.style.gridRow = String(cell.weekday + 1);
    readoutCells.push({ element: box, text: heatmapCellText(cell) });
    if (cell.day === todayKey) todayCell = box;
    grid.append(box);
  }
  wrap.append(labels, grid);
  const readout = attachChartReadout(grid, readoutCells, { className: 'usage-meta chart-readout', initialCell: todayCell, isPickedByColumn: false });
  const block = el('div', 'usage-heatmap-block');
  block.append(readout, wrap);
  return block;
}

function buildBreakdownToggle(expandKey: string, modelCount: number) {
  if (modelCount === 0) return null;
  const modelsToggle = createPressable('usage-toggle', 'Models');
  modelsToggle.dataset.usageDay = expandKey;
  modelsToggle.setAttribute('aria-expanded', _expandedDays.has(expandKey) ? 'true' : 'false');
  modelsToggle.addEventListener('click', () => {
    reportUsageAction('expand');
    setFocusAfterRender({ kind: 'day', day: expandKey });
    if (_expandedDays.has(expandKey)) {
      _expandedDays.delete(expandKey);
      render();
      return;
    }
    _expandedDays.add(expandKey);
    render();
  });
  return modelsToggle;
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

export { buildBudgetsScreen, buildHistoryScreen, buildOverheadScreen };
