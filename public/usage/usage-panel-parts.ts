import { buildPanelSection, el } from '../dom-helpers.ts';
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
  title?: string;
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
      setFocusAfterRender({ kind: 'sort', table: tableId, key: sortKey });
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

function buildBackControl() {
  const back = el('button', 'usage-back', 'Back');
  back.type = 'button';
  back.addEventListener('click', closeScreen);
  return back;
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
