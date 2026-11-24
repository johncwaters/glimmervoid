import type { SeatId, WargamesEvent } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createLineIcon, createSvgIcon, createSvgShape } from '../svg-dom.ts';
import { meter } from '../ui/meter.ts';
import { tag } from '../ui/tag.ts';
import {
  EMPTY_ECONOMY_TIMELINE,
  extendEconomyTimeline,
  growthModeOf,
  totalIncomeOf,
} from './wargames-economy-core.ts';
import type { EconomyTimeline, EconomyTurn, GrowthMode, SeatEconomy } from './wargames-economy-core.ts';
import {
  BUILD_HAMMER_PATH,
  BUILDING_GLYPH_PATHS,
  CONTROL_FLAG_PATH,
  GRAIN_GLYPH_PATH,
  ORE_GLYPH_PATH,
  SEAT_COLORS,
  UNIT_GLYPH_PATHS,
} from './wargames-map.ts';
import './wargames-economy.css';

const NEAR_CAP_FRACTION = 0.9;
const TREND_WIDTH = 96;
const TREND_HEIGHT = 24;
const TREND_INSET = 3;

const GROWTH_LABELS: Readonly<Record<GrowthMode, string>> = Object.freeze({
  build: 'Build',
  capture: 'Capture',
  mixed: 'Mixed',
  none: 'None',
});

const GROWTH_TONES: Readonly<Record<GrowthMode, 'accent' | 'neutral' | 'muted'>> = Object.freeze({
  build: 'neutral',
  capture: 'accent',
  mixed: 'muted',
  none: 'muted',
});

function glyph(pathData: string, color: string, label?: string): SVGSVGElement {
  const icon = createLineIcon(pathData, '1.5');
  icon.setAttribute('width', '12');
  icon.setAttribute('height', '12');
  icon.style.color = color;
  if (!label) return icon;
  icon.removeAttribute('aria-hidden');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', label);
  return icon;
}

function buildingGlyphPath(key: 'farm' | 'mine' | 'wall'): string {
  return BUILDING_GLYPH_PATHS.find((entry) => entry.key === key)?.path ?? '';
}

function headerCell(label: string, glyphPath: string | null, className = ''): HTMLTableCellElement {
  const cell = el('th', className);
  cell.scope = 'col';
  const inner = el('span', 'wg-econ-head');
  if (glyphPath) inner.append(glyph(glyphPath, 'var(--text-muted)'));
  inner.append(el('span', '', label));
  cell.append(inner);
  return cell;
}

function stockCell(resourceName: string, stock: number, income: number, warehouseCap: number): HTMLTableCellElement {
  const cell = el('td', 'wg-econ-stock');
  const fraction = warehouseCap > 0 ? stock / warehouseCap : 0;
  const isNearCap = fraction >= NEAR_CAP_FRACTION;
  const numbers = el('span', 'wg-econ-stock-numbers');
  numbers.append(el('span', 'wg-num', String(stock)), el('span', 'wg-econ-muted wg-num', `+${income}`));
  const stockMeter = meter({
    value: fraction,
    label: `${resourceName} stock against warehouse cap`,
    valueText: `${stock} of ${warehouseCap}, ${Math.round(fraction * 100)}%`,
    tone: isNearCap ? 'waiting' : 'muted',
    thickness: 'thin',
  });
  cell.append(numbers, stockMeter.element);
  return cell;
}

function levelCell(level: number): HTMLTableCellElement {
  const cell = el('td', 'wg-num', String(level));
  if (level === 0) cell.classList.add('wg-econ-muted');
  return cell;
}

function troopsCell(garrison: number, field: number): HTMLTableCellElement {
  const cell = el('td', 'wg-num');
  cell.append(el('span', '', String(garrison)));
  if (field > 0) cell.append(el('span', 'wg-econ-muted', ` +${field} out`));
  return cell;
}

function trendSvg(incomes: readonly number[], maxIncome: number, color: string): SVGSVGElement {
  const svg = createSvgIcon(TREND_WIDTH, TREND_HEIGHT);
  svg.classList.add('wg-econ-trend');
  svg.setAttribute('aria-hidden', 'true');
  const usableWidth = TREND_WIDTH - TREND_INSET * 2;
  const usableHeight = TREND_HEIGHT - TREND_INSET * 2;
  const stepWidth = incomes.length > 1 ? usableWidth / (incomes.length - 1) : 0;
  const points = incomes.map((income, index) => ({
    left: TREND_INSET + index * stepWidth,
    top: TREND_INSET + usableHeight - (maxIncome > 0 ? (income / maxIncome) * usableHeight : 0),
  }));
  const baselineTop = String(TREND_HEIGHT - TREND_INSET);
  svg.append(createSvgShape('line', {
    x1: String(TREND_INSET),
    x2: String(TREND_WIDTH - TREND_INSET),
    y1: baselineTop,
    y2: baselineTop,
    class: 'wg-econ-trend-base',
  }));
  svg.append(createSvgShape('polyline', {
    points: points.map((point) => `${point.left.toFixed(1)},${point.top.toFixed(1)}`).join(' '),
    fill: 'none',
    stroke: color,
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  const latestPoint = points[points.length - 1];
  if (latestPoint) {
    svg.append(createSvgShape('circle', { cx: latestPoint.left.toFixed(1), cy: latestPoint.top.toFixed(1), r: '2.5', fill: color }));
  }
  return svg;
}

function incomeCell(seatId: SeatId, turns: readonly EconomyTurn[], maxIncome: number): HTMLTableCellElement {
  const incomes = turns.map((turn) => {
    const seat = turn.seats.find((entry) => entry.seatId === seatId);
    return seat ? totalIncomeOf(seat) : 0;
  });
  const firstIncome = incomes[0] ?? 0;
  const latestIncome = incomes[incomes.length - 1] ?? 0;
  const cell = el('td', 'wg-econ-income');
  const wrap = el('span', 'wg-econ-income-wrap');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `Income ${firstIncome} at turn 1, ${latestIncome} now, over ${incomes.length} turns`);
  wrap.append(trendSvg(incomes, maxIncome, SEAT_COLORS[seatId]), el('span', 'wg-num', String(latestIncome)));
  cell.append(wrap);
  return cell;
}

function growthCell(seat: SeatEconomy): HTMLTableCellElement {
  const mode = growthModeOf(seat);
  const cell = el('td');
  const wrap = el('span', 'wg-econ-growth');
  const counts = el('span', 'wg-econ-growth-counts');
  counts.append(
    glyph(BUILD_HAMMER_PATH, 'var(--text-muted)', 'Levels built'),
    el('span', 'wg-num', String(seat.levelsBuilt)),
    glyph(CONTROL_FLAG_PATH, 'var(--text-muted)', 'Levels taken'),
    el('span', 'wg-num', String(seat.levelsTaken)),
  );
  wrap.append(tag({ text: GROWTH_LABELS[mode], tone: GROWTH_TONES[mode] }), counts);
  cell.append(wrap);
  return cell;
}

function seatCell(label: string, seatId: SeatId): HTMLTableCellElement {
  const cell = el('th', 'wg-econ-seat');
  cell.scope = 'row';
  const wrap = el('span', 'wg-faction-name');
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = SEAT_COLORS[seatId];
  wrap.append(swatch, el('span', 'wg-faction-id', label));
  cell.append(wrap);
  return cell;
}

function buildTable(state: MatchState, turns: readonly EconomyTurn[]): HTMLTableElement {
  const table = el('table', 'wg-table wg-econ-table');
  table.append(el('caption', 'wg-econ-caption', `Economy, turn ${state.tick}`));
  const headRow = el('tr');
  headRow.append(
    headerCell('Seat', null),
    headerCell('Villages', null, 'wg-num'),
    headerCell('Grain', GRAIN_GLYPH_PATH),
    headerCell('Ore', ORE_GLYPH_PATH),
    headerCell('Farm', buildingGlyphPath('farm'), 'wg-num'),
    headerCell('Mine', buildingGlyphPath('mine'), 'wg-num'),
    headerCell('Wall', buildingGlyphPath('wall'), 'wg-num'),
    headerCell('Troops', UNIT_GLYPH_PATHS.find((entry) => entry.key === 'guard')?.path ?? null, 'wg-num'),
    headerCell('Income', null),
    headerCell('Growth', null),
  );
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  const latestTurn = turns[turns.length - 1];
  const maxIncome = Math.max(0, ...turns.flatMap((turn) => turn.seats.map(totalIncomeOf)));
  for (const seat of state.seats) {
    const seatId = seat.config.seatId;
    const economy = latestTurn?.seats.find((entry) => entry.seatId === seatId);
    if (!economy) continue;
    const row = el('tr');
    if (seat.status === 'eliminated' || economy.villages === 0) row.dataset.eliminated = 'true';
    row.append(
      seatCell(seat.config.label, seatId),
      el('td', 'wg-num wg-econ-villages', String(economy.villages)),
      stockCell('Grain', economy.grain, economy.grainIncome, economy.warehouseCap),
      stockCell('Ore', economy.ore, economy.oreIncome, economy.warehouseCap),
      levelCell(economy.farm),
      levelCell(economy.mine),
      levelCell(economy.wall),
      troopsCell(economy.garrison, economy.field),
      incomeCell(seatId, turns, maxIncome),
      growthCell(economy),
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

export function createWargamesEconomy(): { element: HTMLElement; update(state: MatchState, events: readonly WargamesEvent[]): void } {
  const element = el('section', 'wg-econ');
  let timeline: EconomyTimeline = EMPTY_ECONOMY_TIMELINE;

  return {
    element,
    update(state, events) {
      timeline = extendEconomyTimeline(timeline, events);
      element.hidden = timeline.turns.length === 0;
      if (timeline.turns.length === 0) {
        element.replaceChildren();
        return;
      }
      element.replaceChildren(buildTable(state, timeline.turns));
    },
  };
}
