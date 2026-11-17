import { buildPanelSection, el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { meter } from '../ui/meter.ts';
import type { MeterTone } from '../ui/meter.ts';
import { createPressable } from '../ui/pressable.ts';
import { formatAgo } from '../poll-ago.ts';
import { reportUsageAction } from './usage-store.ts';
import { ariaSortValue, formatPercent } from './usage-view-core.ts';
import type { SortState, UsageDetailScreen } from './usage-view-core.ts';
import { _detailScreen, _reportAgeEl, _sessionsTsEl, _usage, render, setDetailScreen, setFocusAfterRender, setScreen, setShouldScrollToTop } from './usage-panel-state.ts';

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
  span?: number;
}

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
  return meter({ value: clampPct(pct) / 100, label, tone: budgetMeterTone(tone) }).element;
}

function budgetMeterTone(tone: unknown): MeterTone {
  if (tone === 'crit') return 'failed';
  if (tone === 'warn') return 'waiting';
  return 'accent';
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
    const sortHeading = createPressable('usage-sort', heading.label);
    sortHeading.dataset.sortKey = sortKey;
    sortHeading.addEventListener('click', () => {
      reportUsageAction('sort');
      setFocusAfterRender({ kind: 'sort', table: tableId, key: sortKey });
      onSort(sortKey);
    });
    cell.append(sortHeading);
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
  const bar = meter({ value: clampPct(pct) / 100, tone: 'muted', thickness: 'thin' });
  wrap.append(bar.element, el('span', 'usage-share-text', formatPercent(pct)));
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

function buildBackControl() {
  return button({ variant: 'secondary', label: 'Back', action: 'back-to-usage-overview', onClick: closeScreen });
}

function openScreen(screen: UsageDetailScreen) {
  reportUsageAction('expand');
  setScreen(screen);
  setDetailScreen(screen);
  setFocusAfterRender({ kind: 'back' });
  setShouldScrollToTop(true);
  render();
}

function closeScreen() {
  const previous = _detailScreen;
  setScreen('overview');
  setFocusAfterRender({ kind: 'drill', screen: previous });
  setShouldScrollToTop(true);
  render();
}

export { appendCells, buildBackControl, buildMeter, buildSection, buildShareCell, buildTable, buildTile, clampPct, openScreen, paintReportAge, paintSessionsTs };
