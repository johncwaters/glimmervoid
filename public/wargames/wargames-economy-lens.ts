import type { SeatId } from '#shared/contracts/wargames.ts';
import { projectSeatState, villageYieldOf, warehouseCapOf } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createSvgShape } from '../svg-dom.ts';
import { switchInput } from '../ui/switch.ts';
import { ECON_GLYPHS, econGlyph, GRAIN_COLOR, ORE_COLOR } from './wargames-econ-glyphs.ts';
import type { EconGlyphKey } from './wargames-econ-glyphs.ts';
import { hexCenter, SEAT_COLORS, seatLabelOf } from './wargames-map.ts';
import type { WargamesPov } from './wargames-store.ts';
import './wargames-economy-lens.css';

type VillageState = NonNullable<MatchState['villages'][number]>;

const HIT_RADIUS = 36;
const BAR_OFFSET_Y = -15;
const BAR_HEIGHT = 7;
const BAR_MIN_WIDTH = 16;
const BAR_MAX_WIDTH = 60;
const SEGMENT_GAP = 1.5;
const CHIP_PADDING = 2;

interface EconomyLens {
  readonly controls: HTMLElement;
  attach(svg: SVGSVGElement): void;
  update(state: MatchState, pov: WargamesPov, selectedHexIndex: number | null): void;
  showSettledBoard(): void;
}

interface LensInput {
  readonly state: MatchState;
  readonly pov: WargamesPov;
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

function visibleVillagesOf(state: MatchState, pov: WargamesPov): VillageState[] {
  if (pov === 'god') return state.villages.filter((village): village is VillageState => village !== null);
  return projectSeatState(state, pov).visibleVillages;
}

function incomeOf(village: VillageState): { grain: number; ore: number } {
  if (village.productionState !== 'producing') return { grain: 0, ore: 0 };
  return villageYieldOf(village);
}

function ownerLabelOf(state: MatchState, owner: SeatId | null): string {
  if (owner === null) return 'Barbarians';
  return seatLabelOf(state, owner);
}

function summaryOf(state: MatchState, village: VillageState): string {
  if (village.isBeacon) return `Beacon ${village.hexIndex}, ${village.owner === null ? 'unheld' : seatLabelOf(state, village.owner)}: raiders ${village.troops.raider}, guards ${village.troops.guard}, envoys ${village.troops.envoy}`;
  const income = incomeOf(village);
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
  const income = incomeOf(village);
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

function appendIncomeBar(layer: SVGElement, centerX: number, centerY: number, income: { grain: number; ore: number }, maxVisibleIncome: number, isUnowned: boolean): void {
  const total = income.grain + income.ore;
  if (total === 0 || maxVisibleIncome === 0) return;
  const width = BAR_MIN_WIDTH + (BAR_MAX_WIDTH - BAR_MIN_WIDTH) * (total / maxVisibleIncome);
  const left = centerX - width / 2;
  const top = centerY + BAR_OFFSET_Y - BAR_HEIGHT / 2;
  const grainWidth = Math.max(1, (width - SEGMENT_GAP) * (income.grain / total));
  const oreWidth = Math.max(1, width - SEGMENT_GAP - grainWidth);
  const chip = createSvgShape('g', { class: isUnowned ? 'wg-lens-mark wg-lens-mark-unowned' : 'wg-lens-mark' });
  layer.append(chip);
  chip.append(
    createSvgShape('rect', {
      x: (left - CHIP_PADDING).toFixed(1),
      y: (top - CHIP_PADDING).toFixed(1),
      width: (width + CHIP_PADDING * 2).toFixed(1),
      height: String(BAR_HEIGHT + CHIP_PADDING * 2),
      rx: '2.5',
      class: 'wg-lens-chip-bg',
    }),
    createSvgShape('rect', { x: left.toFixed(1), y: top.toFixed(1), width: grainWidth.toFixed(1), height: String(BAR_HEIGHT), rx: '1.5', fill: GRAIN_COLOR }),
    createSvgShape('rect', { x: (left + grainWidth + SEGMENT_GAP).toFixed(1), y: top.toFixed(1), width: oreWidth.toFixed(1), height: String(BAR_HEIGHT), rx: '1.5', fill: ORE_COLOR }),
  );
}

function legendKey(key: 'grain' | 'ore', color: string): HTMLElement {
  const wrap = el('span', 'wg-lens-chip');
  const swatch = el('span', 'wg-lens-key-swatch');
  swatch.style.background = color;
  wrap.append(swatch, econGlyph(key, 12, null), el('span', '', ECON_GLYPHS[key].label));
  return wrap;
}

export function createEconomyLens(onSelectHex: (hexIndex: number) => void, isBoardSettled: () => boolean): EconomyLens {
  let isOn = false;
  let latestState: MatchState | null = null;
  let latestPov: WargamesPov = 'god';
  let hoveredHexIndex: number | null = null;
  const layer = createSvgShape('g', { class: 'wg-lens-layer' });
  const markLayer = createSvgShape('g', { class: 'wg-lens-marks' });
  const hitLayer = createSvgShape('g', { class: 'wg-lens-hits' });
  layer.append(markLayer, hitLayer);
  layer.setAttribute('display', 'none');

  let selectedHexIndex: number | null = null;
  let heldInput: LensInput | null = null;

  function applyHeldInput(): void {
    if (!heldInput) return;
    latestState = heldInput.state;
    latestPov = heldInput.pov;
    selectedHexIndex = heldInput.selectedHexIndex;
    heldInput = null;
    render();
  }
  const detail = el('div', 'wg-lens-detail');

  const toggle = el('label', 'wg-lens-toggle');
  const lensSwitch = switchInput({ label: 'Economy lens', checked: false, onChange: (checked) => setLensOn(checked) });
  toggle.append(lensSwitch, econGlyph('grain', 12, null), el('span', '', 'Economy'));

  const legend = el('div', 'wg-lens-legend');
  legend.append(el('span', 'wg-econ-muted', 'Bar: income per turn'), legendKey('grain', GRAIN_COLOR), legendKey('ore', ORE_COLOR));
  const controlRow = el('div', 'wg-lens-control-row');
  controlRow.append(toggle, legend);
  const controls = el('div', 'wg-lens-controls');
  controls.append(controlRow, detail);
  controls.dataset.lens = 'off';
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
    layer.setAttribute('display', isOn ? 'inline' : 'none');
    controls.dataset.lens = isOn ? 'on' : 'off';
    if (!isOn || !latestState) return;
    const state = latestState;
    const villages = visibleVillagesOf(state, latestPov);
    const maxVisibleIncome = Math.max(0, ...villages.map((village) => {
      const income = incomeOf(village);
      return income.grain + income.ore;
    }));
    for (const village of villages) {
      const tile = state.hexes[village.hexIndex];
      if (!tile) continue;
      const center = hexCenter(tile.q, tile.r);
      if (!village.isBeacon) appendIncomeBar(markLayer, center.x, center.y, incomeOf(village), maxVisibleIncome, village.owner === null);
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

  function setLensOn(checked: boolean): void {
    isOn = checked;
    render();
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
    update(state, pov, selectedHex) {
      heldInput = { state, pov, selectedHexIndex: selectedHex };
      if (!isBoardSettled()) return;
      applyHeldInput();
    },
    showSettledBoard() {
      applyHeldInput();
    },
  };
}
