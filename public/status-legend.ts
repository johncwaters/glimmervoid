import { el } from './dom-helpers.ts';
import { paintPillStatus } from './focus-view/pill-dom.ts';
import { STATUS_LEGEND } from './status-legend-core.ts';

export function renderStatusLegend() {
  const legend = el('section', 'status-legend');
  legend.appendChild(el('h2', 'status-legend-title', 'Status colors'));
  const rows = el('dl', 'status-legend-rows');
  for (const entry of STATUS_LEGEND) {
    const row = el('div', 'status-legend-row');
    const badge = el('dt', 'status-legend-badge');
    const glyph = el('span', 'status-legend-glyph');
    const name = el('span', 'status-legend-name');
    glyph.setAttribute('aria-hidden', 'true');
    badge.append(glyph, name);
    paintPillStatus(row, { glyph, label: name }, entry.state, entry.awaitingBackgroundTasks);
    row.append(badge, el('dd', 'status-legend-meaning', entry.meaning));
    rows.appendChild(row);
  }
  legend.appendChild(rows);
  return legend;
}
