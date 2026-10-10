import { el } from './dom-helpers.ts';
import { paintPillStatus } from './focus-view/pill-dom.ts';
import { PR_STATUS_LEGEND } from './pr-status-icon-core.ts';
import type { PrStatusIcon } from './pr-status-icon-core.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { STATUS_LEGEND } from './status-legend-core.ts';

function buildLegendSection(title: string, rows: readonly HTMLElement[]) {
  const legend = el('section', 'status-legend');
  const list = el('dl', 'status-legend-rows');
  list.append(...rows);
  legend.append(el('h2', 'status-legend-title', title), list);
  return legend;
}

function buildLegendRow(badge: HTMLElement, meaning: string) {
  const row = el('div', 'status-legend-row');
  row.append(badge, el('dd', 'status-legend-meaning', meaning));
  return row;
}

export function renderStatusLegend() {
  return buildLegendSection('Status colors', STATUS_LEGEND.map((entry) => {
    const badge = el('dt', 'status-legend-badge');
    const glyph = el('span', 'status-legend-glyph');
    const name = el('span', 'status-legend-name');
    glyph.setAttribute('aria-hidden', 'true');
    badge.append(glyph, name);
    const row = buildLegendRow(badge, entry.meaning);
    paintPillStatus(row, { glyph, label: name }, entry.state, entry.awaitingBackgroundTasks);
    return row;
  }));
}

export function renderPrStatusLegend() {
  return buildLegendSection('Pull request icons', (Object.keys(PR_STATUS_LEGEND) as PrStatusIcon[]).map((icon) => {
    const entry = PR_STATUS_LEGEND[icon];
    const badge = el('dt', 'status-legend-badge');
    badge.append(createPrStatusIcon(icon), el('span', 'status-legend-name', entry.label));
    return buildLegendRow(badge, entry.meaning);
  }));
}
