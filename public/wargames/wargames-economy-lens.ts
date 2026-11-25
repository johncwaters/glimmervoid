import type { SeatId } from '#shared/contracts/wargames.ts';
import { paidImprovementYieldOf, villageIncomeOf, warehouseCapOf } from '#shared/wargames/engine.ts';
import { TERRAIN_MIN_RADIUS } from '#shared/wargames/terrain.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createSvgShape } from '../svg-dom.ts';
import { econGlyph, GRAIN_COLOR, ORE_COLOR } from './wargames-econ-glyphs.ts';
import type { EconGlyphKey } from './wargames-econ-glyphs.ts';
import { GRAIN_GLYPH_PATH, hexCenter, IMPROVEMENT_SLOT_Y, ORE_GLYPH_PATH, SEAT_COLORS, seatLabelOf, VILLAGE_INCOME_MAX_WIDTH, VILLAGE_INCOME_SLOT_Y } from './wargames-map.ts';
import './wargames-economy-lens.css';

type VillageState = NonNullable<MatchState['villages'][number]>;

const HIT_RADIUS = 36;
const MARK_GLYPH_SIZE = 9;
const MARK_FONT_SIZE = '9';
const MARK_DIGIT_WIDTH = 5.3;
const MARK_ITEM_GAP = 3;
const STOCK_BAR_HEIGHT = 2.5;
const STOCK_BAR_OFFSET_Y = 7.5;

interface EconomyLens {
  readonly controls: HTMLElement;
  attach(svg: SVGSVGElement): void;
  update(state: MatchState, selectedHexIndex: number | null): void;
  showSettledBoard(): void;
}

interface LensInput {
  readonly state: MatchState;
  readonly selectedHexIndex: number | null;
}

function hitPolygonPoints(centerX: number, centerY: number): string {
  const corners: string[] = [];
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * (60 * corner - 30);
    corners.push(`${(centerX + HIT_RADIUS * Math.cos(angle)).toFixed(1)},${(centerY + HIT_RADIUS * Math.sin(angle)).toFixed(1)}`);
  }
  return corners.join(' ');
}

function boardVillagesOf(state: MatchState): VillageState[] {
  return state.villages.filter((village): village is VillageState => village !== null);
}

function incomeOf(state: MatchState, village: VillageState): { grain: number; ore: number } {
  if (village.productionState !== 'producing') return { grain: 0, ore: 0 };
  return villageIncomeOf(state, village);
}

function ownerLabelOf(state: MatchState, owner: SeatId | null): string {
  if (owner === null) return 'Barbarians';
  return seatLabelOf(state, owner);
}

function summaryOf(state: MatchState, village: VillageState): string {
  if (village.isBeacon) return `Beacon ${village.hexIndex}, ${village.owner === null ? 'unheld' : seatLabelOf(state, village.owner)}: raiders ${village.troops.raider}, guards ${village.troops.guard}, envoys ${village.troops.envoy}`;
  const income = incomeOf(state, village);
  const cap = warehouseCapOf(village);
  const { farm, mine, wall } = village.buildings;
  const { raider, guard, envoy } = village.troops;
  const producing = village.productionState === 'producing' ? `income grain ${income.grain}, ore ${income.ore}` : 'barren, no income';
  return `Village ${village.hexIndex}, ${ownerLabelOf(state, village.owner)}: ${producing}; grain ${village.resources.grain} of ${cap}, ore ${village.resources.ore} of ${cap}; farm ${farm}, mine ${mine}, wall ${wall}; raiders ${raider}, guards ${guard}, envoys ${envoy}`;
}

function chip(key: EconGlyphKey, text: string): HTMLElement {
  const wrap = el('span', 'wg-lens-chip');
  wrap.append(econGlyph(key), el('span', 'wg-num', text));
  return wrap;
}

function fillBeaconDetail(detail: HTMLElement, state: MatchState, village: VillageState): void {
  const head = el('span', 'wg-lens-detail-head');
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = village.owner === null ? 'var(--text-dim)' : SEAT_COLORS[village.owner];
  head.append(swatch, el('span', 'wg-lens-detail-owner', village.owner === null ? 'Beacon, unheld' : `Beacon, ${seatLabelOf(state, village.owner)}`), el('span', 'wg-econ-muted', `#${village.hexIndex}`));
  const pointsRow = el('span', 'wg-lens-detail-group');
  const beaconPoints = state.balance.victory.beaconPoints;
  pointsRow.append(el('span', 'wg-lens-detail-key', 'Worth'), chip('points', `+${beaconPoints} VP a turn while held`));
  const troopRow = el('span', 'wg-lens-detail-group');
  troopRow.append(
    el('span', 'wg-lens-detail-key', 'Troops'),
    chip('raider', String(village.troops.raider)),
    chip('guard', String(village.troops.guard)),
    chip('envoy', String(village.troops.envoy)),
  );
  detail.replaceChildren(head, pointsRow, troopRow);
}

function fillDetail(detail: HTMLElement, state: MatchState, village: VillageState): void {
  if (village.isBeacon) {
    fillBeaconDetail(detail, state, village);
    return;
  }
  const income = incomeOf(state, village);
  const cap = warehouseCapOf(village);
  const head = el('span', 'wg-lens-detail-head');
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = village.owner === null ? 'var(--text-dim)' : SEAT_COLORS[village.owner];
  head.append(swatch, el('span', 'wg-lens-detail-owner', ownerLabelOf(state, village.owner)), el('span', 'wg-econ-muted', `#${village.hexIndex}`));
  const incomeRow = el('span', 'wg-lens-detail-group');
  incomeRow.append(el('span', 'wg-lens-detail-key', 'Income'));
  if (village.productionState !== 'producing') incomeRow.append(el('span', 'wg-econ-muted', 'Barren'));
  if (village.productionState === 'producing') incomeRow.append(chip('grain', `+${income.grain}`), chip('ore', `+${income.ore}`));
  const stockRow = el('span', 'wg-lens-detail-group');
  stockRow.append(
    el('span', 'wg-lens-detail-key', 'Stock'),
    chip('grain', `${village.resources.grain}/${cap}`),
    chip('ore', `${village.resources.ore}/${cap}`),
  );
  const buildingRow = el('span', 'wg-lens-detail-group');
  buildingRow.append(
    el('span', 'wg-lens-detail-key', 'Levels'),
    chip('farm', String(village.buildings.farm)),
    chip('mine', String(village.buildings.mine)),
    chip('wall', String(village.buildings.wall)),
  );
  const troopRow = el('span', 'wg-lens-detail-group');
  troopRow.append(
    el('span', 'wg-lens-detail-key', 'Troops'),
    chip('raider', String(village.troops.raider)),
    chip('guard', String(village.troops.guard)),
    chip('envoy', String(village.troops.envoy)),
  );
  detail.replaceChildren(head, incomeRow, stockRow, buildingRow, troopRow);
}

interface ResourceMark {
  readonly path: string;
  readonly color: string;
  readonly label: string;
  readonly stockShare: number | null;
  readonly width: number;
}

function resourceMarkOf(path: string, color: string, amount: number, stockShare: number | null): ResourceMark {
  const label = String(amount);
  return { path, color, label, stockShare, width: MARK_GLYPH_SIZE + 1.5 + label.length * MARK_DIGIT_WIDTH };
}

function appendMarkGlyph(container: SVGElement, path: string, centerX: number, centerY: number, color: string): void {
  const scale = MARK_GLYPH_SIZE / 16;
  const group = createSvgShape('g', { transform: `translate(${(centerX - MARK_GLYPH_SIZE / 2).toFixed(1)}, ${(centerY - MARK_GLYPH_SIZE / 2).toFixed(1)}) scale(${scale.toFixed(3)})` });
  group.append(createSvgShape('path', { d: path, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  container.append(group);
}

function appendResourceMarks(layer: SVGElement, startX: number, centerY: number, marks: readonly ResourceMark[], className: string, maxWidth = Number.POSITIVE_INFINITY): void {
  const group = createSvgShape('g', { class: className });
  const fullWidth = marksWidth(marks);
  if (fullWidth > maxWidth) {
    const pivotX = startX + fullWidth / 2;
    group.setAttribute('transform', `translate(${pivotX.toFixed(1)} ${centerY.toFixed(1)}) scale(${(maxWidth / fullWidth).toFixed(3)}) translate(${(-pivotX).toFixed(1)} ${(-centerY).toFixed(1)})`);
  }
  let cursorX = startX;
  for (const mark of marks) {
    appendMarkGlyph(group, mark.path, cursorX + MARK_GLYPH_SIZE / 2, centerY, mark.color);
    const text = createSvgShape('text', { x: (cursorX + MARK_GLYPH_SIZE + 1.5).toFixed(1), y: (centerY + 3.5).toFixed(1), 'font-size': MARK_FONT_SIZE, fill: mark.color, class: 'wg-lens-mark-text' });
    text.textContent = mark.label;
    group.append(text);
    if (mark.stockShare !== null) {
      const barTop = centerY + STOCK_BAR_OFFSET_Y - STOCK_BAR_HEIGHT / 2;
      group.append(
        createSvgShape('rect', { x: cursorX.toFixed(1), y: barTop.toFixed(1), width: mark.width.toFixed(1), height: String(STOCK_BAR_HEIGHT), class: 'wg-lens-stock-track' }),
        createSvgShape('rect', { x: cursorX.toFixed(1), y: barTop.toFixed(1), width: (mark.width * Math.min(1, Math.max(0, mark.stockShare))).toFixed(1), height: String(STOCK_BAR_HEIGHT), fill: mark.color }),
      );
    }
    cursorX += mark.width + MARK_ITEM_GAP;
  }
  layer.append(group);
}

function marksWidth(marks: readonly ResourceMark[]): number {
  return marks.reduce((sum, mark) => sum + mark.width, 0) + Math.max(0, marks.length - 1) * MARK_ITEM_GAP;
}

function appendVillageIncome(layer: SVGElement, state: MatchState, village: VillageState, centerX: number, centerY: number): void {
  const income = incomeOf(state, village);
  if (income.grain + income.ore === 0) return;
  const cap = Math.max(1, warehouseCapOf(village));
  const marks = [
    resourceMarkOf(GRAIN_GLYPH_PATH, GRAIN_COLOR, income.grain, village.resources.grain / cap),
    resourceMarkOf(ORE_GLYPH_PATH, ORE_COLOR, income.ore, village.resources.ore / cap),
  ];
  appendResourceMarks(layer, centerX - marksWidth(marks) / 2, centerY + VILLAGE_INCOME_SLOT_Y, marks, village.owner === null ? 'wg-lens-mark wg-lens-mark-unowned' : 'wg-lens-mark', VILLAGE_INCOME_MAX_WIDTH);
}

function improvementYieldMarkOf(state: MatchState, hexIndex: number): ResourceMark | null {
  const paid = paidImprovementYieldOf(state, hexIndex);
  if (paid.ore > 0) return resourceMarkOf(ORE_GLYPH_PATH, ORE_COLOR, paid.ore, null);
  if (paid.grain > 0) return resourceMarkOf(GRAIN_GLYPH_PATH, GRAIN_COLOR, paid.grain, null);
  return null;
}

function appendImprovementYields(layer: SVGElement, state: MatchState): void {
  for (const [hexIndex, tile] of state.territory) {
    if (tile.level === 0 || (tile.improvement !== 'field' && tile.improvement !== 'quarry')) continue;
    if (state.villages[hexIndex] !== null) continue;
    const mark = improvementYieldMarkOf(state, hexIndex);
    const hex = state.hexes[hexIndex];
    if (!mark || !hex) continue;
    const center = hexCenter(hex.q, hex.r);
    appendResourceMarks(layer, center.x - 2, center.y + IMPROVEMENT_SLOT_Y, [mark], 'wg-lens-mark');
  }
}

export const ECONOMY_KEY_ROWS: readonly { path: string; color: string; label: string }[] = [
  { path: GRAIN_GLYPH_PATH, color: GRAIN_COLOR, label: 'Grain a turn, bar fills to the warehouse cap' },
  { path: ORE_GLYPH_PATH, color: ORE_COLOR, label: 'Ore a turn, bar fills to the warehouse cap' },
];

export function createEconomyLens(onSelectHex: (hexIndex: number) => void, isBoardSettled: () => boolean): EconomyLens {
  let latestState: MatchState | null = null;
  let hoveredHexIndex: number | null = null;
  const layer = createSvgShape('g', { class: 'wg-lens-layer' });
  const markLayer = createSvgShape('g', { class: 'wg-lens-marks' });
  const hitLayer = createSvgShape('g', { class: 'wg-lens-hits' });
  layer.append(markLayer, hitLayer);

  let selectedHexIndex: number | null = null;
  let heldInput: LensInput | null = null;

  function applyHeldInput(): void {
    if (!heldInput) return;
    latestState = heldInput.state;
    selectedHexIndex = heldInput.selectedHexIndex;
    heldInput = null;
    render();
  }
  const detail = el('div', 'wg-lens-detail');

  const controls = el('div', 'wg-lens-controls');
  controls.append(detail);
  const hitsByHexIndex = new Map<number, SVGElement>();
  const villageByHexIndex = new Map<number, VillageState>();

  function hitFor(hexIndex: number): SVGElement {
    const existing = hitsByHexIndex.get(hexIndex);
    if (existing) return existing;
    const hit = createSvgShape('polygon', { class: 'wg-lens-hit', tabindex: '0', role: 'button' });
    const pointAtThisVillage = () => {
      hoveredHexIndex = hexIndex;
      showDetail();
    };
    const stopPointing = () => {
      hoveredHexIndex = null;
      showDetail();
    };
    hit.addEventListener('pointerenter', pointAtThisVillage);
    hit.addEventListener('focus', pointAtThisVillage);
    hit.addEventListener('pointerleave', stopPointing);
    hit.addEventListener('blur', stopPointing);
    hit.addEventListener('click', () => onSelectHex(hexIndex));
    hit.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelectHex(hexIndex);
    });
    hitsByHexIndex.set(hexIndex, hit);
    hitLayer.append(hit);
    return hit;
  }

  function showDetail(): void {
    const shownHexIndex = hoveredHexIndex ?? selectedHexIndex;
    const village = shownHexIndex === null ? undefined : villageByHexIndex.get(shownHexIndex);
    if (!latestState || !village) {
      detail.replaceChildren(el('span', 'wg-econ-muted', 'Point at or select a village for its numbers'));
      return;
    }
    fillDetail(detail, latestState, village);
  }

  function render(): void {
    markLayer.replaceChildren();
    villageByHexIndex.clear();
    if (!latestState) return;
    const state = latestState;
    const isDenseMap = (state.spec.mapRadius ?? 0) >= TERRAIN_MIN_RADIUS;
    appendImprovementYields(markLayer, state);
    for (const village of boardVillagesOf(state)) {
      const tile = state.hexes[village.hexIndex];
      if (!tile) continue;
      const center = hexCenter(tile.q, tile.r);
      const isQuietBarbarian = isDenseMap && village.owner === null && village.hexIndex !== selectedHexIndex;
      if (!village.isBeacon && !isQuietBarbarian) appendVillageIncome(markLayer, state, village, center.x, center.y);
      villageByHexIndex.set(village.hexIndex, village);
      const hit = hitFor(village.hexIndex);
      hit.setAttribute('points', hitPolygonPoints(center.x, center.y));
      hit.setAttribute('aria-label', summaryOf(state, village));
    }
    for (const [hexIndex, hit] of hitsByHexIndex) {
      if (villageByHexIndex.has(hexIndex)) continue;
      hit.remove();
      hitsByHexIndex.delete(hexIndex);
    }
    showDetail();
  }



  return {
    controls,
    attach(svg) {
      if (layer.parentNode === svg) return;
      const hexLayer = svg.querySelector('.wg-hex-layer');
      if (hexLayer) {
        hexLayer.after(layer);
        return;
      }
      svg.append(layer);
    },
    update(state, selectedHex) {
      heldInput = { state, selectedHexIndex: selectedHex };
      if (!isBoardSettled()) return;
      applyHeldInput();
    },
    showSettledBoard() {
      applyHeldInput();
    },
  };
}
