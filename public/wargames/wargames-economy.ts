import type { SeatId, TroopCounts, WargamesEvent } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createSvgIcon, createSvgShape } from '../svg-dom.ts';
import { meter } from '../ui/meter.ts';
import { tag } from '../ui/tag.ts';
import {
  EMPTY_ECONOMY_TIMELINE,
  extendEconomyTimeline,
  growthModeOf,
  totalIncomeOf,
} from './wargames-economy-core.ts';
import type { EconomyTimeline, EconomyTurn, GrowthMode, SeatEconomy } from './wargames-economy-core.ts';
import { econGlyph } from './wargames-econ-glyphs.ts';
import type { EconGlyphKey } from './wargames-econ-glyphs.ts';
import { SEAT_COLORS } from './wargames-map.ts';
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

function wordHeaderCell(label: string, className = ''): HTMLTableCellElement {
  const cell = el('th', className, label);
  cell.scope = 'col';
  return cell;
}

function glyphHeaderCell(key: EconGlyphKey, className = ''): HTMLTableCellElement {
  const cell = el('th', className);
  cell.scope = 'col';
  cell.append(econGlyph(key, 14));
  return cell;
}

function stockCell(resourceName: string, stock: number, income: number, warehouseCap: number): HTMLTableCellElement {
  const cell = el('td', 'wg-econ-stock');
  const fraction = warehouseCap > 0 ? stock / warehouseCap : 0;
  const isNearCap = fraction >= NEAR_CAP_FRACTION;
  const numbers = el('span', 'wg-econ-stock-numbers');
  const stockGroup = el('span', 'wg-econ-stock-value');
  stockGroup.append(el('span', 'wg-num', String(stock)));
  if (isNearCap) stockGroup.append(tag({ text: 'Cap', tone: 'neutral' }));
  numbers.append(stockGroup, el('span', 'wg-econ-muted wg-num', `+${income}`));
  const stockMeter = meter({
    value: fraction,
    label: `${resourceName} stock against warehouse cap`,
    valueText: `${stock} of ${warehouseCap}, ${Math.round(fraction * 100)}%`,
    tone: 'muted',
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

const TROOP_KINDS = ['raider', 'guard', 'envoy'] as const;

function troopsCell(troops: TroopCounts, field: number): HTMLTableCellElement {
  const cell = el('td');
  const wrap = el('span', 'wg-econ-chips');
  for (const kind of TROOP_KINDS) {
    const chip = el('span', 'wg-econ-chip');
    chip.append(econGlyph(kind), el('span', 'wg-num', String(troops[kind])));
    if (troops[kind] === 0) chip.classList.add('wg-econ-muted');
    wrap.append(chip);
  }
  if (field > 0) {
    const fieldChip = el('span', 'wg-econ-chip wg-econ-muted');
    fieldChip.append(econGlyph('field'), el('span', 'wg-num', String(field)));
    wrap.append(fieldChip);
  }
  cell.append(wrap);
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
  const builtChip = el('span', 'wg-econ-chip');
  builtChip.append(econGlyph('built'), el('span', 'wg-num', String(seat.levelsBuilt)));
  const takenChip = el('span', 'wg-econ-chip wg-econ-taken');
  takenChip.append(econGlyph('taken'), el('span', 'wg-num', String(seat.levelsTaken)));
  counts.append(builtChip, takenChip);
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
    wordHeaderCell('Seat'),
    glyphHeaderCell('village', 'wg-num'),
    glyphHeaderCell('grain'),
    glyphHeaderCell('ore'),
    glyphHeaderCell('farm', 'wg-num'),
    glyphHeaderCell('mine', 'wg-num'),
    glyphHeaderCell('wall', 'wg-num'),
    wordHeaderCell('Troops'),
    wordHeaderCell('Income'),
    wordHeaderCell('Growth'),
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
      troopsCell(economy.troops, economy.field),
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
