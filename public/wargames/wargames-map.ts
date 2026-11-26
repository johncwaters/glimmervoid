import { ImprovementKind, WARGAMES_MAX_HEX_RADIUS, WARGAMES_SEAT_IDS } from '#shared/contracts/wargames.ts';
import type { OrderItem, SeatId, TroopCounts, WargamesReport } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, hexIndexAt, marchRouteOf } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { TERRAIN_MIN_RADIUS, isPassable } from '#shared/wargames/terrain.ts';
import type { TerrainKind } from '#shared/wargames/terrain.ts';
import { CHAT_ICON_PATH, PLUS_ICON_PATH, createLineIcon, createSvgShape } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import {
  createBoardAnimationQueue,
  directTurnEvents,
  transitionBoardOverlay,
} from './wargames-anim-queue.ts';
import type { BoardAnimationBeat, BoardOverlayMode } from './wargames-anim-queue.ts';
import { isZoomed, panViewBox, viewBoxAttributeOf, zoomViewBoxAt } from './wargames-map-viewport-core.ts';
import type { MapViewBox } from './wargames-map-viewport-core.ts';
import type { WargamesPov } from './wargames-store.ts';

type VillageState = NonNullable<MatchState['villages'][number]>;

function latestResolvedTickOf(ordersByTick: Readonly<Record<number, unknown>>): number {
  let latest = -1;
  for (const key of Object.keys(ordersByTick)) {
    const numeric = Number(key);
    if (Number.isInteger(numeric) && numeric > latest) latest = numeric;
  }
  return latest;
}

function cloneVillage(village: VillageState | null): VillageState | null {
  if (!village) return null;
  return {
    ...village,
    resources: { ...village.resources },
    troops: { ...village.troops },
    buildings: { ...village.buildings },
  };
}

function findOrderTroopsForArmy(
  ordersBySeat: Readonly<Record<SeatId, OrderItem[]>> | undefined,
  owner: SeatId,
  originHexIndex: number,
  targetHexIndex: number,
): TroopCounts {
  const seatOrders = ordersBySeat?.[owner];
  if (!seatOrders) return { raider: 0, guard: 0, envoy: 0 };
  const matched = seatOrders.find(
    (order) => order.kind === 'march' && order.fromHexIndex === originHexIndex && order.toHexIndex === targetHexIndex,
  );
  if (matched?.kind !== 'march') return { raider: 0, guard: 0, envoy: 0 };
  return { ...matched.troops };
}

export const SEAT_COLORS: Readonly<Record<SeatId, string>> = Object.freeze({
  s1: '#38bdf8',
  s2: '#22c55e',
  s3: '#facc15',
  s4: '#ef4444',
  s5: '#c084fc',
  s6: '#fb923c',
});

const HEX_SIZE = 40;
const HEX_INNER_RADIUS = HEX_SIZE - 2;
const SQRT_3 = Math.sqrt(3);
const HEX_EDGE_INSET = (HEX_INNER_RADIUS * SQRT_3) / 2 - 4;
const BATTLE_LABEL_MAX_CHARS = 24;
const NEUTRAL_COLOR = 'var(--text-dim)';
const ZOOM_BUTTON_STEP = 1.4;
const WHEEL_ZOOM_RATE = 0.0015;
const DRAG_THRESHOLD_PX = 4;
const MINUS_ICON_PATH = 'M3 8h10';
const FIT_ICON_PATH = 'M2.5 5.5v-3h3 M10.5 2.5h3v3 M13.5 10.5v3h-3 M5.5 13.5h-3v-3';
const DIPLOMACY_MESSAGE_BEAT_MS = 2600;
const DIPLOMACY_THOUGHT_BEAT_MS = 2400;
const DIPLOMACY_MAX_PENDING_BEATS = 10;

type UnitKey = 'raider' | 'guard' | 'envoy';
type BuildingKey = 'farm' | 'mine' | 'wall';

export const UNIT_GLYPH_PATHS: readonly { key: UnitKey; label: string; color: string; path: string }[] = [
  { key: 'raider', label: 'Raider', color: '#f77f6a', path: 'M 3 13 L 13 3 M 10 3 H 13 V 6 M 4.5 9.5 L 6.5 11.5' },
  { key: 'guard', label: 'Guard', color: '#7da3c8', path: 'M 8 2.2 L 13 4.2 V 8.2 C 13 11.2 10.7 13 8 13.8 C 5.3 13 3 11.2 3 8.2 V 4.2 Z M 8 4.5 V 11.5' },
  { key: 'envoy', label: 'Envoy', color: '#e8b931', path: 'M 2.5 12.5 L 3.5 5.5 L 6.5 8.5 L 8 4 L 9.5 8.5 L 12.5 5.5 L 13.5 12.5 Z' },
];

export const BUILDING_GLYPH_PATHS: readonly { key: BuildingKey; label: string; color: string; path: string }[] = [
  { key: 'farm', label: 'Farm', color: '#84cc16', path: 'M 2 13.5 L 4.5 5.5 H 11.5 L 14 13.5 Z M 8 5.5 V 13.5 M 3.3 9.5 H 12.7' },
  { key: 'mine', label: 'Mine', color: '#94a3b8', path: 'M 2.5 6.5 Q 8 1.5 13.5 6.5 M 8 4 V 14' },
  { key: 'wall', label: 'Wall', color: '#a8a29e', path: 'M 3 13.5 V 4.5 H 5.5 V 6.5 H 7 V 4.5 H 9 V 6.5 H 10.5 V 4.5 H 13 V 13.5 Z' },
];

const IMPROVEMENT_GLYPHS: Readonly<Record<ImprovementKind, { label: string; color: string; path: string }>> = Object.freeze({
  field: { label: 'Field', color: '#bef264', path: 'M 2 12.5 Q 8 9.5 14 12.5 M 2 8.5 Q 8 5.5 14 8.5 M 2 4.5 Q 8 1.5 14 4.5' },
  quarry: { label: 'Quarry', color: 'var(--state-monitoring)', path: 'M 2.5 13 L 3.5 7 L 8 4.5 L 13 6.5 L 13.5 12 L 8 13.5 Z M 3.5 7 L 8.5 9 L 13 6.5 M 8.5 9 L 8 13.5' },
  outpost: { label: 'Outpost', color: '#f0abfc', path: 'M 3 14 V 6 L 4.5 4 L 6 6 V 14 M 6.5 14 V 6 L 8 4 L 9.5 6 V 14 M 10 14 V 6 L 11.5 4 L 13 6 V 14' },
});

export const IMPROVEMENT_GLYPH_PATHS: readonly { key: ImprovementKind; label: string; color: string; path: string }[] = ImprovementKind.options.map((key) => ({ key, ...IMPROVEMENT_GLYPHS[key] }));

const WALL_GLYPH = BUILDING_GLYPH_PATHS.find((building) => building.key === 'wall') ?? BUILDING_GLYPH_PATHS[0];

export const CONTROL_FLAG_PATH = 'M 4 14 V 2.5 M 4 3 H 12.5 L 10.5 5.75 L 12.5 8.5 H 4';
export const PACT_SCROLL_PATH = 'M 4 3 H 12 V 13 H 4 Z M 6 6 H 10 M 6 9 H 9';
function previewDashOf(isFriendlyReinforce: boolean): string {
  return isFriendlyReinforce ? '2 4' : '5 4';
}
export const BREACH_WARNING_PATH = 'M 8 2 L 14 13 H 2 Z M 8 6 V 9 M 8 11 V 11.5';
export const THOUGHT_CLOUD_PATH = 'M 5 10.5 A 2.5 2.5 0 0 1 4.2 5.6 A 3 3 0 0 1 9.8 4.2 A 2.6 2.6 0 0 1 12.2 10 Z M 4.5 13 L 4.6 13 M 2.6 14.8 L 2.7 14.8';
export const LAND_GLYPH_PATH = 'M 8 2.5 L 12.8 5.25 V 10.75 L 8 13.5 L 3.2 10.75 V 5.25 Z M 5.5 8 H 10.5 M 8 5.5 V 10.5';
export const VILLAGE_GLYPH_PATH = 'M 8 2 L 13.2 5 V 11 L 8 14 L 2.8 11 V 5 Z';
export const MARCH_ARROW_PATH = 'M 3 8 H 13 M 9 4 L 13 8 L 9 12';
export const GRAIN_GLYPH_PATH = 'M 8 13 V 3 M 8 6 L 5 4 M 8 6 L 11 4 M 8 9 L 5 7 M 8 9 L 11 7';
export const ORE_GLYPH_PATH = 'M 8 2 L 13 6 L 11 13 H 5 L 3 6 Z';
const MOUNTAIN_GLYPH_PATH = 'M 2 13 L 6 5 L 9 10 L 11 7 L 14 13 Z';
const LAKE_GLYPH_PATH = 'M 2 6 Q 4 4 6 6 T 10 6 T 14 6 M 2 10 Q 4 8 6 10 T 10 10 T 14 10';
const FOREST_GLYPH_PATH = 'M 8 2 L 13 10 H 3 Z M 8 10 V 14';
export const BEACON_GLYPH_PATH = 'M 6 14 L 7 7 H 9 L 10 14 Z M 8 2 V 4.5 M 3.5 4 L 5.5 5.5 M 12.5 4 L 10.5 5.5';
export const TERRAIN_GLYPHS: Readonly<Record<Exclude<TerrainKind, 'plain'>, { path: string; color: string; label: string }>> = Object.freeze({
  mountain: { path: MOUNTAIN_GLYPH_PATH, color: 'var(--text)', label: 'Mountain' },
  lake: { path: LAKE_GLYPH_PATH, color: 'var(--text)', label: 'Lake' },
  forest: { path: FOREST_GLYPH_PATH, color: 'var(--text-dim)', label: 'Forest' },
  fertile: { path: GRAIN_GLYPH_PATH, color: 'var(--state-waiting)', label: 'Fertile land' },
  ore: { path: ORE_GLYPH_PATH, color: 'var(--state-monitoring)', label: 'Ore deposit' },
});

const MOUNTAIN_BARRIER_FILL = 'color-mix(in srgb, var(--text-dim) 42%, var(--bg))';
const BARRIER_FILLS: Readonly<Partial<Record<TerrainKind, string>>> = Object.freeze({
  mountain: MOUNTAIN_BARRIER_FILL,
  lake: 'color-mix(in srgb, var(--state-monitoring) 34%, var(--bg))',
});

function barrierFillFor(kind: TerrainKind): string | undefined {
  if (isPassable(kind)) return undefined;
  return BARRIER_FILLS[kind] ?? MOUNTAIN_BARRIER_FILL;
}
const BARRIER_SCALE = HEX_SIZE / HEX_INNER_RADIUS;

type TerritoryTile = NonNullable<ReturnType<MatchState['territory']['get']>>;

function territoryFill(owner: SeatId): string {
  return `color-mix(in srgb, ${SEAT_COLORS[owner]} 11%, var(--bg-surface))`;
}

function territoryStroke(owner: SeatId): string {
  return `color-mix(in srgb, ${SEAT_COLORS[owner]} 45%, var(--border))`;
}

const EDGE_NEIGHBOR_STEPS: readonly { q: number; r: number }[] = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 }, { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

function hexCornerAt(centerX: number, centerY: number, corner: number): { x: number; y: number } {
  const angle = (Math.PI / 180) * (60 * corner - 30);
  return { x: centerX + HEX_INNER_RADIUS * Math.cos(angle), y: centerY + HEX_INNER_RADIUS * Math.sin(angle) };
}

function holdsLandAt(state: MatchState, owner: SeatId, axialQ: number, axialR: number): boolean {
  const neighborIndex = hexIndexAt(axialQ, axialR, state.spec.mapRadius);
  if (neighborIndex < 0) return false;
  return state.territory.get(neighborIndex)?.owner === owner || state.villages[neighborIndex]?.owner === owner;
}

function renderTerritoryBorder(container: SVGElement, state: MatchState, hexIndex: number, owner: SeatId, centerX: number, centerY: number): void {
  const tile = state.hexes[hexIndex];
  EDGE_NEIGHBOR_STEPS.forEach((step, edge) => {
    if (holdsLandAt(state, owner, tile.q + step.q, tile.r + step.r)) return;
    const from = hexCornerAt(centerX, centerY, edge);
    const to = hexCornerAt(centerX, centerY, edge + 1);
    container.append(createSvgShape('line', {
      x1: from.x.toFixed(1), y1: from.y.toFixed(1), x2: to.x.toFixed(1), y2: to.y.toFixed(1),
      stroke: territoryStroke(owner), 'stroke-width': '1.6', 'stroke-linecap': 'round',
    }));
  });
}

function renderImprovement(slot: Pick<HexNodeSlot, 'terrainGroup' | 'centerX' | 'centerY'>, tile: TerritoryTile): void {
  if (tile.improvement === null) return;
  const glyph = buildingGlyphOf(tile.improvement);
  const hasYield = tile.improvement !== 'outpost';
  const glyphX = hasYield ? slot.centerX - 12 : slot.centerX;
  const glyphElement = createMapStrokeGlyph(glyph.path, glyphX, slot.centerY + IMPROVEMENT_SLOT_Y, 16, glyph.color, '2');
  glyphElement.setAttribute('aria-label', `${tile.improvement} level ${tile.level}`);
  glyphElement.setAttribute('class', 'wg-improvement');
  slot.terrainGroup.append(glyphElement);
  if (!hasYield && tile.level > 1) appendBoardText(slot.terrainGroup, String(tile.level), { x: slot.centerX + 10, y: slot.centerY + IMPROVEMENT_SLOT_Y + 3.5, anchor: 'start', fontSize: '10', fill: glyph.color, className: 'wg-hex-detail' });
}

const UNIT_GLYPH_SIZE = 12;
const UNIT_COUNT_FONT_SIZE = '11';
const UNIT_DIGIT_WIDTH = 6.4;
const UNIT_TOKEN_GAP = 4;
const ARMY_TOKEN_HEIGHT = 19;
const ARMY_TOKEN_PADDING = 5;
const ARMY_TOKEN_MAX_WIDTH = HEX_INNER_RADIUS * SQRT_3 - 4;
const ARMY_TOKEN_TILE_OFFSET_Y = 12;
export const VILLAGE_INCOME_SLOT_Y = -22;
export const IMPROVEMENT_SLOT_Y = -14;
export const VILLAGE_INCOME_MAX_WIDTH = (HEX_INNER_RADIUS + VILLAGE_INCOME_SLOT_Y) * SQRT_3 * 2 - 8;
const CONTROL_BADGE_OFFSET_Y = 23;
const VILLAGE_INCOME_HALF_WIDTH = VILLAGE_INCOME_MAX_WIDTH / 2;
const VILLAGE_ARMY_SPOTS: readonly { x: number; y: number }[] = [
  { x: 38, y: 22 }, { x: -38, y: 22 }, { x: 42, y: -6 }, { x: -42, y: -6 }, { x: 0, y: 48 }, { x: 0, y: -50 },
];
const ARRIVAL_LABEL_SPOTS: readonly { x: number; y: number }[] = [
  { x: 0, y: -31 }, { x: 0, y: -45 }, { x: 20, y: -38 }, { x: -20, y: -38 }, { x: 34, y: -40 }, { x: -34, y: -40 }, { x: 44, y: 0 }, { x: -44, y: 0 },
];
const SHARED_TILE_ARMY_SPOTS: readonly { x: number; y: number }[] = [
  { x: 0, y: 12 }, { x: 0, y: -9 }, { x: 0, y: 33 }, { x: 36, y: 24 }, { x: -36, y: 24 },
];

interface BoardBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function boxAround(centerX: number, centerY: number, width: number, height: number): BoardBox {
  return { left: centerX - width / 2, top: centerY - height / 2, right: centerX + width / 2, bottom: centerY + height / 2 };
}

function boxesOverlap(first: BoardBox, second: BoardBox): boolean {
  return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
}

function armyTokenFill(owner: SeatId): string {
  return `color-mix(in srgb, ${SEAT_COLORS[owner]} 16%, var(--bg))`;
}

function armyTokenContentOf(troops: TroopCounts, isCompact: boolean): UnitCountToken[] {
  const tokens = unitCountTokensOf(troops);
  const fitsFullRow = tokenRowWidth(tokens, UNIT_TOKEN_GAP) + ARMY_TOKEN_PADDING * 2 <= ARMY_TOKEN_MAX_WIDTH;
  if (!isCompact && fitsFullRow && tokens.length > 0) return tokens;
  const leadUnit = leadUnitOf(troops);
  return [unitCountTokenOf(leadUnit.path, leadUnit.color, troopCountOf(troops))];
}

function renderArmyToken(layer: SVGElement, centerX: number, centerY: number, owner: SeatId, troops: TroopCounts, isCompact: boolean, isQuiet = false): SVGElement {
  const group = createSvgShape('g', { class: 'wg-army-token' });
  const tokens = armyTokenContentOf(troops, isCompact);
  const rowWidth = tokenRowWidth(tokens, UNIT_TOKEN_GAP);
  const frameColor = isQuiet ? `color-mix(in srgb, ${SEAT_COLORS[owner]} 55%, var(--bg))` : SEAT_COLORS[owner];
  appendPillFrame(group, centerX, centerY, rowWidth + ARMY_TOKEN_PADDING * 2, ARMY_TOKEN_HEIGHT, frameColor, { strokeWidth: isQuiet ? '1' : '1.6', fill: armyTokenFill(owner) });
  appendUnitCountRow(group, centerX - rowWidth / 2, centerY, tokens, UNIT_TOKEN_GAP, 'wg-army-pill-text');
  group.setAttribute('aria-label', `${troopCountOf(troops)} troops`);
  layer.append(group);
  return group;
}

const TERRAIN_TINT_OPACITY = '0.1';
const UNOWNED_VILLAGE_GLYPH_PATH = 'M 3 8 L 8 3.5 L 13 8 V 13 H 3 Z M 6.5 13 V 10 H 9.5 V 13';
const BEACON_RING_SCALE = 0.74;

function renderBeacon(slot: Pick<HexNodeSlot, 'terrainGroup' | 'centerX' | 'centerY'>, owner: SeatId | null, isQuietSite: boolean): void {
  const ringColor = owner === null ? 'var(--text-head)' : SEAT_COLORS[owner];
  slot.terrainGroup.append(createSvgShape('polygon', {
    points: hexPolygonPoints(slot.centerX, slot.centerY, BEACON_RING_SCALE),
    fill: 'none',
    stroke: ringColor,
    'stroke-width': '2',
    'stroke-dasharray': '4 2',
  }));
  const glyph = isQuietSite || owner === null
    ? createMapStrokeGlyph(BEACON_GLYPH_PATH, slot.centerX, slot.centerY, 22, ringColor, '2')
    : createMapStrokeGlyph(BEACON_GLYPH_PATH, slot.centerX, slot.centerY - 15, 13, ringColor, '2');
  glyph.setAttribute('aria-label', owner === null ? 'Beacon, unheld' : 'Beacon, held');
  slot.terrainGroup.append(glyph);
}

function renderSiteGlyph(slot: Pick<HexNodeSlot, 'terrainGroup' | 'centerX' | 'centerY'>, village: { isBeacon: boolean; owner: SeatId | null }, isQuietSite: boolean): void {
  if (village.isBeacon) {
    renderBeacon(slot, village.owner, isQuietSite);
    return;
  }
  if (!isQuietSite) return;
  const glyph = createMapStrokeGlyph(UNOWNED_VILLAGE_GLYPH_PATH, slot.centerX, slot.centerY, 16, 'var(--text-dim)', '1.6');
  glyph.setAttribute('aria-label', 'Village');
  slot.terrainGroup.append(glyph);
}

function renderTerrainGlyph(container: SVGElement, centerX: number, centerY: number, kind: TerrainKind, isGlyphCentered: boolean): void {
  container.replaceChildren();
  if (kind === 'plain') return;
  const glyph = TERRAIN_GLYPHS[kind];
  const isBlocked = !isPassable(kind);
  if (!isBlocked) {
    container.append(createSvgShape('polygon', { points: hexPolygonPoints(centerX, centerY), fill: 'var(--text-muted)', 'fill-opacity': TERRAIN_TINT_OPACITY, stroke: 'none' }));
  }
  const glyphElement = isGlyphCentered
    ? createMapStrokeGlyph(glyph.path, centerX, centerY, isBlocked ? 26 : 18, glyph.color, '2')
    : createMapStrokeGlyph(glyph.path, centerX - 13, centerY - 15, 13, glyph.color, '2');
  glyphElement.setAttribute('aria-label', glyph.label);
  container.append(glyphElement);
}
export const BUILD_HAMMER_PATH = 'M 8 7 V 14 M 3 3 H 11.5 L 13 5 L 11.5 7 H 3 Z';

export function controlToneColor(loyalty: number, owner: SeatId | null): string {
  if (loyalty <= 35) return 'var(--state-failed)';
  if (loyalty <= 65) return 'var(--state-waiting)';
  if (owner !== null) return SEAT_COLORS[owner];
  return NEUTRAL_COLOR;
}

export function seatLabelOf(state: MatchState, seatId: SeatId): string {
  const seat = state.seats.find((candidate) => candidate.config.seatId === seatId);
  return seat ? seat.config.label : `Seat ${WARGAMES_SEAT_IDS.indexOf(seatId) + 1}`;
}

function createMapStrokeGlyph(
  pathData: string,
  centerX: number,
  centerY: number,
  size: number,
  color: string,
  strokeWidth = '1.8',
): SVGElement {
  const scale = size / 16;
  const group = createSvgShape('g', {
    transform: `translate(${(centerX - size / 2).toFixed(1)}, ${(centerY - size / 2).toFixed(1)}) scale(${scale.toFixed(3)})`,
  });
  group.append(createSvgShape('path', {
    d: pathData,
    fill: 'none',
    stroke: color,
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  return group;
}

function appendBoardText(
  container: SVGElement,
  label: string,
  attributes: { x: number; y: number; anchor: 'start' | 'middle'; fontSize: string; fill: string; className: string },
): SVGElement {
  const textNode = createSvgShape('text', {
    x: attributes.x.toFixed(1),
    y: attributes.y.toFixed(1),
    'text-anchor': attributes.anchor,
    'font-size': attributes.fontSize,
    fill: attributes.fill,
    class: attributes.className,
  });
  textNode.textContent = label;
  container.append(textNode);
  return textNode;
}

function appendPillFrame(
  container: SVGElement,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  stroke: string,
  options: { strokeWidth?: string; dasharray?: string; fill?: string } = {},
): void {
  const frameAttributes: Record<string, string> = {
    x: (centerX - width / 2).toFixed(1),
    y: (centerY - height / 2).toFixed(1),
    width: width.toFixed(1),
    height: height.toFixed(1),
    rx: '3',
    fill: options.fill ?? 'var(--bg)',
    stroke,
    'stroke-width': options.strokeWidth ?? '1',
  };
  if (options.dasharray) frameAttributes['stroke-dasharray'] = options.dasharray;
  container.append(createSvgShape('rect', frameAttributes));
}

interface UnitCountToken {
  readonly path: string;
  readonly color: string;
  readonly digits: string;
  readonly width: number;
}

function unitCountTokenOf(path: string, color: string, count: number): UnitCountToken {
  const digits = String(count);
  return { path, color, digits, width: UNIT_GLYPH_SIZE + 1.5 + digits.length * UNIT_DIGIT_WIDTH };
}

function unitCountTokensOf(troops: TroopCounts): UnitCountToken[] {
  return UNIT_GLYPH_PATHS
    .filter((unit) => troops[unit.key] > 0)
    .map((unit) => unitCountTokenOf(unit.path, unit.color, troops[unit.key]));
}

function tokenRowWidth(tokens: readonly UnitCountToken[], gap: number): number {
  return tokens.reduce((sum, token) => sum + token.width, 0) + Math.max(0, tokens.length - 1) * gap;
}

function appendUnitCountRow(
  container: SVGElement,
  startX: number,
  centerY: number,
  tokens: readonly UnitCountToken[],
  gap: number,
  className: string,
): void {
  let cursorX = startX;
  for (const token of tokens) {
    container.append(createMapStrokeGlyph(token.path, cursorX + UNIT_GLYPH_SIZE / 2, centerY, UNIT_GLYPH_SIZE, token.color, '2'));
    appendBoardText(container, token.digits, {
      x: cursorX + UNIT_GLYPH_SIZE + 1.5,
      y: centerY + 3.9,
      anchor: 'start',
      fontSize: UNIT_COUNT_FONT_SIZE,
      fill: 'var(--text-head)',
      className,
    });
    cursorX += token.width + gap;
  }
}

function addTroopCounts(into: TroopCounts, amount: TroopCounts): void {
  into.raider += amount.raider;
  into.guard += amount.guard;
  into.envoy += amount.envoy;
}

function renderHexUnitRow(container: SVGElement, centerX: number, centerY: number, tokens: readonly UnitCountToken[]): void {
  const rowWidth = tokenRowWidth(tokens, UNIT_TOKEN_GAP);
  container.append(createSvgShape('rect', { x: (centerX - rowWidth / 2 - 3).toFixed(1), y: (centerY - UNIT_GLYPH_SIZE / 2 - 2).toFixed(1), width: (rowWidth + 6).toFixed(1), height: String(UNIT_GLYPH_SIZE + 4), rx: '3', class: 'wg-garrison-plate' }));
  appendUnitCountRow(container, centerX - tokenRowWidth(tokens, UNIT_TOKEN_GAP) / 2, centerY, tokens, UNIT_TOKEN_GAP, 'wg-army-pill-text');
}

function renderHexUnitTokens(container: SVGElement, centerX: number, centerY: number, troops: TroopCounts): void {
  container.replaceChildren();
  const tokens = unitCountTokensOf(troops);
  if (tokens.length === 0) return;
  if (tokenRowWidth(tokens, UNIT_TOKEN_GAP) <= ARMY_TOKEN_MAX_WIDTH) {
    renderHexUnitRow(container, centerX, centerY + 3, tokens);
    return;
  }
  renderHexUnitRow(container, centerX, centerY - 6, tokens.slice(0, 2));
  renderHexUnitRow(container, centerX, centerY + 8, tokens.slice(2));
}

function controlBadgeContentWidth(label: string): number {
  return 10 + 2 + label.length * 5.9;
}

function garrisonBoxesOf(troops: TroopCounts, centerX: number, centerY: number): BoardBox[] {
  const tokens = unitCountTokensOf(troops);
  if (tokens.length === 0) return [];
  if (tokenRowWidth(tokens, UNIT_TOKEN_GAP) <= ARMY_TOKEN_MAX_WIDTH) return [boxAround(centerX, centerY + 3, tokenRowWidth(tokens, UNIT_TOKEN_GAP), UNIT_GLYPH_SIZE + 2)];
  return [
    boxAround(centerX, centerY - 6, tokenRowWidth(tokens.slice(0, 2), UNIT_TOKEN_GAP), UNIT_GLYPH_SIZE + 2),
    boxAround(centerX, centerY + 8, tokenRowWidth(tokens.slice(2), UNIT_TOKEN_GAP), UNIT_GLYPH_SIZE + 2),
  ];
}

function renderControlBadge(container: SVGElement, centerX: number, centerY: number, loyalty: number, owner: SeatId | null): void {
  container.replaceChildren();
  const controlPercent = Math.max(0, Math.min(100, Math.round(loyalty)));
  if (controlPercent >= 100) return;
  const tone = controlToneColor(controlPercent, owner);
  const label = `${controlPercent}%`;
  const contentWidth = controlBadgeContentWidth(label);
  const badgeCenterY = centerY + CONTROL_BADGE_OFFSET_Y;
  appendPillFrame(container, centerX, badgeCenterY, contentWidth + 8, 13, tone);
  const startX = centerX - contentWidth / 2;
  container.append(createMapStrokeGlyph(CONTROL_FLAG_PATH, startX + 5, badgeCenterY, 10, tone, '2'));
  appendBoardText(container, label, {
    x: startX + 12,
    y: badgeCenterY + 3.5,
    anchor: 'start',
    fontSize: '10',
    fill: tone,
    className: 'wg-army-pill-text',
  });
}

function arrowEndpointTrims(distance: number): { startTrim: number; endTrim: number } {
  return { startTrim: Math.min(HEX_EDGE_INSET - 10, distance * 0.3), endTrim: Math.min(HEX_EDGE_INSET, distance * 0.45) };
}

export function hexCenter(axialQ: number, axialR: number): { x: number; y: number } {
  return {
    x: HEX_SIZE * (SQRT_3 * axialQ + (SQRT_3 / 2) * axialR),
    y: HEX_SIZE * (1.5 * axialR),
  };
}

function hexPolygonPoints(centerX: number, centerY: number, scale = 1): string {
  const points: string[] = [];
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * (60 * corner - 30);
    const pointX = centerX + HEX_INNER_RADIUS * scale * Math.cos(angle);
    const pointY = centerY + HEX_INNER_RADIUS * scale * Math.sin(angle);
    points.push(`${pointX.toFixed(1)},${pointY.toFixed(1)}`);
  }
  return points.join(' ');
}

function villageFillColor(owner: SeatId | null, isBarren: boolean): string {
  if (owner !== null) {
    const mixPercent = isBarren ? 8 : 18;
    const baseSurface = isBarren ? 'var(--bg)' : 'var(--bg-card)';
    return `color-mix(in srgb, ${SEAT_COLORS[owner]} ${mixPercent}%, ${baseSurface})`;
  }
  if (isBarren) return 'var(--bg)';
  return 'color-mix(in srgb, var(--text-dim) 10%, var(--bg-card))';
}

interface HexNodeSlot {
  group: SVGElement;
  polygon: SVGElement;
  indexLabel: SVGElement;
  detailLabel: SVGElement;
  terrainGroup: SVGElement;
  unitGroup: SVGElement;
  controlGroup: SVGElement;
  centerX: number;
  centerY: number;
}

interface ArmyPlacement {
  readonly hexIndex: number;
  readonly owner: SeatId;
  readonly troops: TroopCounts;
  readonly armyIds: string[];
}

interface ArmyGlide {
  readonly army: ArmySnapshot;
  readonly armyId: string;
  readonly fromHexIndex: number;
  readonly destHexIndex: number;
}

interface ArmySnapshot {
  hexIndex: number;
  targetHexIndex: number;
  originHexIndex: number;
  owner: SeatId;
  troops: TroopCounts;
  status: string;
}

function troopCountOf(troops: TroopCounts): number {
  return troops.raider + troops.guard + troops.envoy;
}

interface BuildingUpgradeCallout {
  path: string;
  color: string;
  level: number;
}

interface HexDeltaSummary {
  troopDelta: number;
  loyaltyDelta: number;
  ownerChanged: boolean;
  buildingUpgrades: BuildingUpgradeCallout[];
  targetVillage: VillageState;
}

function collectBuildingUpgrades(prev: VillageState['buildings'], next: VillageState['buildings']): BuildingUpgradeCallout[] {
  const upgrades: BuildingUpgradeCallout[] = [];
  for (const entry of BUILDING_GLYPH_PATHS) {
    if (next[entry.key] > prev[entry.key]) {
      upgrades.push({ path: entry.path, color: entry.color, level: next[entry.key] });
    }
  }
  return upgrades;
}

function pairKeyOf(fromHexIndex: number, toHexIndex: number): string {
  return `${Math.min(fromHexIndex, toHexIndex)}-${Math.max(fromHexIndex, toHexIndex)}`;
}

function appendDiplomacyArc(
  fxLayer: SVGElement,
  fromSlot: HexNodeSlot,
  toSlot: HexNodeSlot,
  options: {
    stroke: string;
    dasharray: string;
    glyphPath: string;
    label: string;
    markerId: string | null;
    durationMs: number;
  },
): SVGElement | null {
  const vectorX = toSlot.centerX - fromSlot.centerX;
  const vectorY = toSlot.centerY - fromSlot.centerY;
  const distance = Math.hypot(vectorX, vectorY);
  if (distance < 1) return null;

  const unitX = vectorX / distance;
  const unitY = vectorY / distance;
  const { startTrim, endTrim } = arrowEndpointTrims(distance);
  const startX = fromSlot.centerX + unitX * startTrim;
  const startY = fromSlot.centerY + unitY * startTrim;
  const endX = toSlot.centerX - unitX * endTrim;
  const endY = toSlot.centerY - unitY * endTrim;
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const curveLift = Math.min(44, distance * 0.24);
  const controlX = midX - unitY * curveLift;
  const controlY = midY + unitX * curveLift;
  const peakX = (startX + 2 * controlX + endX) / 4;
  const peakY = (startY + 2 * controlY + endY) / 4;

  const group = createSvgShape('g', { class: 'wg-diplomacy-arc' });
  group.style.animationDuration = `${options.durationMs}ms`;
  const pathAttributes: Record<string, string> = {
    d: `M ${startX.toFixed(1)} ${startY.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`,
    fill: 'none',
    stroke: options.stroke,
    'stroke-width': '2',
    'stroke-dasharray': options.dasharray,
  };
  if (options.markerId) pathAttributes['marker-end'] = `url(#${options.markerId})`;
  group.append(createSvgShape('path', pathAttributes));

  const labelWidth = options.label.length > 0 ? 2 + options.label.length * 6 : 0;
  const contentWidth = 10 + labelWidth;
  appendPillFrame(group, peakX, peakY, contentWidth + 8, 15, options.stroke);
  const contentStartX = peakX - contentWidth / 2;
  group.append(createMapStrokeGlyph(options.glyphPath, contentStartX + 5, peakY, 10, options.stroke, '1.6'));
  if (options.label.length > 0) {
    appendBoardText(group, options.label, {
      x: contentStartX + 12,
      y: peakY + 3,
      anchor: 'start',
      fontSize: '10',
      fill: options.stroke,
      className: 'wg-delta-text',
    });
  }
  fxLayer.append(group);
  return group;
}

function appendFocusRing(fxLayer: SVGElement, centerX: number, centerY: number): SVGElement {
  const ring = createSvgShape('polygon', {
    points: hexPolygonPoints(centerX, centerY),
    fill: 'none',
    stroke: 'var(--accent)',
    'stroke-width': '2',
    opacity: '0.75',
  });
  fxLayer.append(ring);
  return ring;
}

function appendDeltaCallout(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  label: string,
  fill: string,
  durationMs: number,
): SVGElement {
  const group = createSvgShape('g', { class: 'wg-delta-callout' });
  group.style.animationDuration = `${durationMs}ms`;
  appendPillFrame(group, centerX, centerY - 3, Math.max(26, label.length * 6.8 + 10), 16, fill);
  appendBoardText(group, label, { x: centerX, y: centerY + 0.5, anchor: 'middle', fontSize: '11', fill, className: 'wg-delta-text' });
  fxLayer.append(group);
  return group;
}

function appendGlyphCallout(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  options: { prefix: string; glyphPath: string; glyphColor: string; label: string; stroke: string; durationMs: number },
): SVGElement {
  const prefixWidth = options.prefix.length * 6.6;
  const contentWidth = prefixWidth + 13 + options.label.length * 6.6;
  const group = createSvgShape('g', { class: 'wg-delta-callout' });
  group.style.animationDuration = `${options.durationMs}ms`;
  appendPillFrame(group, centerX, centerY - 3, Math.max(32, contentWidth + 8), 16, options.stroke);
  const startX = centerX - contentWidth / 2;
  if (options.prefix.length > 0) {
    appendBoardText(group, options.prefix, { x: startX, y: centerY + 0.5, anchor: 'start', fontSize: '11', fill: options.stroke, className: 'wg-delta-text' });
  }
  group.append(createMapStrokeGlyph(options.glyphPath, startX + prefixWidth + 5.5, centerY - 3, 11, options.glyphColor));
  appendBoardText(group, options.label, {
    x: startX + prefixWidth + 12.5,
    y: centerY + 0.5,
    anchor: 'start',
    fontSize: '11',
    fill: options.stroke,
    className: 'wg-delta-text',
  });
  fxLayer.append(group);
  return group;
}

function appendCombatClash(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  strokeColor: string,
  durationMs: number,
): SVGElement {
  const clash = createSvgShape('g', { class: 'wg-combat-clash' });
  clash.style.transformOrigin = `${centerX.toFixed(1)}px ${centerY.toFixed(1)}px`;
  clash.style.animationDuration = `${durationMs}ms`;
  clash.append(
    createSvgShape('path', {
      d: `M ${(centerX - 9).toFixed(1)} ${(centerY - 9).toFixed(1)} L ${(centerX + 9).toFixed(1)} ${(centerY + 9).toFixed(1)} M ${(centerX + 9).toFixed(1)} ${(centerY - 9).toFixed(1)} L ${(centerX - 9).toFixed(1)} ${(centerY + 9).toFixed(1)}`,
      stroke: strokeColor,
      'stroke-width': '2.6',
      'stroke-linecap': 'square',
      fill: 'none',
    }),
  );
  fxLayer.append(clash);
  return clash;
}

function leadUnitOf(troops: TroopCounts): (typeof UNIT_GLYPH_PATHS)[number] {
  let best = UNIT_GLYPH_PATHS[0];
  let bestCount = -1;
  for (const unit of UNIT_GLYPH_PATHS) {
    if (troops[unit.key] > bestCount) {
      best = unit;
      bestCount = troops[unit.key];
    }
  }
  return best;
}

function appendGlidingArmy(
  layer: SVGElement,
  routePoints: readonly { x: number; y: number }[],
  army: ArmySnapshot,
  durationMs: number,
  options: { isCompact: boolean; fadesOnArrival: boolean },
): SVGElement | null {
  if (routePoints.length < 2) return null;
  const start = routePoints[0];
  const wrapper = createSvgShape('g', { class: 'wg-army-glide' });
  wrapper.append(createSvgShape('path', {
    d: routePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
    fill: 'none',
    stroke: SEAT_COLORS[army.owner],
    'stroke-width': '2.4',
    'stroke-dasharray': '6 3',
    'stroke-linejoin': 'round',
    'stroke-opacity': '0.7',
  }));
  const mover = createSvgShape('g', {});
  renderArmyToken(mover, start.x, start.y, army.owner, army.troops, options.isCompact);
  wrapper.append(mover);
  layer.append(wrapper);
  const legLengths = routePoints.slice(1).map((point, index) => Math.hypot(point.x - routePoints[index].x, point.y - routePoints[index].y));
  const totalLength = Math.max(1, legLengths.reduce((sum, length) => sum + length, 0));
  let travelled = 0;
  const travelShare = options.fadesOnArrival ? 0.8 : 1;
  const keyframes: Keyframe[] = [{ transform: 'translate(0px, 0px)', opacity: 1, offset: 0 }];
  routePoints.slice(1).forEach((point, index) => {
    travelled += legLengths[index];
    keyframes.push({ transform: `translate(${(point.x - start.x).toFixed(1)}px, ${(point.y - start.y).toFixed(1)}px)`, opacity: 1, offset: (travelled / totalLength) * travelShare });
  });
  if (options.fadesOnArrival) {
    const end = routePoints[routePoints.length - 1];
    keyframes.push({ transform: `translate(${(end.x - start.x).toFixed(1)}px, ${(end.y - start.y).toFixed(1)}px)`, opacity: 0, offset: 1 });
  }
  if (typeof mover.animate === 'function') mover.animate(keyframes, { duration: durationMs, easing: 'ease-in-out', fill: 'forwards' });
  return wrapper;
}

type BattleReportPayload = Extract<WargamesReport, { kind: 'battle' }>;

function battleReportsForHex(state: MatchState, pov: WargamesPov, tick: number, hexIndex: number): BattleReportPayload[] {
  const source = pov === 'god' ? [...state.reportsById.values()] : state.reportsBySeat[pov];
  const matched: BattleReportPayload[] = [];
  const seenIds = new Set<string>();
  for (const report of source) {
    if (report.kind !== 'battle') continue;
    if (report.tick !== tick || report.hexIndex !== hexIndex) continue;
    if (seenIds.has(report.reportId)) continue;
    seenIds.add(report.reportId);
    matched.push(report);
  }
  return matched;
}

interface BattleHeadline {
  readonly text: string;
  readonly color: string;
}

function battleHeadlineOf(reports: readonly BattleReportPayload[], fullLabelOf: (seatId: SeatId) => string): BattleHeadline {
  const labelOf = (seatId: SeatId) => truncateCalloutText(fullLabelOf(seatId), BATTLE_LABEL_MAX_CHARS);
  const first = reports[0];
  const capturedReport = reports.find((report) => report.captured) ?? null;
  if (capturedReport) return { text: `${labelOf(capturedReport.attacker)} captured`, color: SEAT_COLORS[capturedReport.attacker] };
  const defenderBeforeTotal = troopCountOf(first.defenderBefore);
  const defenderFell = defenderBeforeTotal === 0 || troopCountOf(first.defenderLost) >= defenderBeforeTotal;
  if (!defenderFell) {
    const defenderLabel = first.defender ? labelOf(first.defender) : 'Barbarians';
    return { text: `${defenderLabel} held`, color: first.defender ? SEAT_COLORS[first.defender] : 'var(--text-head)' };
  }
  const survivingAttackers = reports.filter((report) => troopCountOf(report.attackerLost) < troopCountOf(report.attackerSent));
  if (survivingAttackers.length === 0) return { text: 'Both sides wiped out', color: 'var(--state-waiting)' };
  const survivorsOf = (report: BattleReportPayload) => troopCountOf(report.attackerSent) - troopCountOf(report.attackerLost);
  const winningAttacker = survivingAttackers.reduce((best, candidate) => (survivorsOf(candidate) > survivorsOf(best) ? candidate : best));
  return { text: `${labelOf(winningAttacker.attacker)} won`, color: SEAT_COLORS[winningAttacker.attacker] };
}

interface BattleLossSegment {
  readonly color: string;
  readonly label: string;
  readonly glyphPath: string | null;
}

function battleLossSegmentsOf(reports: readonly BattleReportPayload[]): BattleLossSegment[] {
  const first = reports[0];
  const capturedReport = reports.find((report) => report.captured) ?? null;
  const segments: BattleLossSegment[] = reports.map((report) => ({
    color: SEAT_COLORS[report.attacker],
    label: `-${troopCountOf(report.attackerLost)}`,
    glyphPath: null,
  }));
  segments.push({
    color: first.defender ? SEAT_COLORS[first.defender] : NEUTRAL_COLOR,
    label: `-${troopCountOf(first.defenderLost)}`,
    glyphPath: null,
  });
  const finalLoyalty = capturedReport ? capturedReport.loyaltyAfter : first.loyaltyAfter;
  if (finalLoyalty < first.loyaltyBefore) {
    segments.push({ color: 'var(--state-waiting)', label: `${finalLoyalty}%`, glyphPath: CONTROL_FLAG_PATH });
  }
  const wallLevelsLost = (first.wallBefore ?? 0) - (first.wallAfter ?? first.wallBefore ?? 0);
  if (wallLevelsLost > 0) segments.push({ color: WALL_GLYPH.color, label: `-${wallLevelsLost}`, glyphPath: WALL_GLYPH.path });
  for (const report of reports) {
    if (report.morale !== undefined) segments.push({ color: SEAT_COLORS[report.attacker], label: `morale x${report.morale}`, glyphPath: null });
  }
  return segments;
}

interface ViewBoxBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const DEFAULT_VIEW_BOX_BOUNDS: ViewBoxBounds = Object.freeze({
  minX: -266,
  maxX: 266,
  minY: -232,
  maxY: 232,
});

function appendBattleBubble(
  fxLayer: SVGElement,
  anchorX: number,
  anchorY: number,
  reports: readonly BattleReportPayload[],
  labelOf: (seatId: SeatId) => string,
  durationMs: number,
  bounds: ViewBoxBounds,
): SVGElement | null {
  if (reports.length === 0) return null;
  const headline = battleHeadlineOf(reports, labelOf);
  const segments = battleLossSegmentsOf(reports);
  const segmentGap = 7;
  const measuredSegments = segments.map((segment) => ({ ...segment, width: 11 + segment.label.length * 6 }));
  const segmentsWidth = measuredSegments.reduce((sum, segment) => sum + segment.width, 0) + Math.max(0, segments.length - 1) * segmentGap;
  const cardWidth = Math.min(280, Math.max(110, Math.max(headline.text.length * 6.2, segmentsWidth) + 18));
  const cardHeight = 36;
  const position = clampToViewBox(anchorX, anchorY, cardWidth, cardHeight, 30, bounds);

  const group = createSvgShape('g', { class: 'wg-battle-bubble' });
  group.style.animationDuration = `${durationMs}ms`;
  appendPillFrame(group, position.x, position.y, cardWidth, cardHeight, headline.color, { strokeWidth: '1.5' });
  appendBoardText(group, headline.text, {
    x: position.x,
    y: position.y - 4,
    anchor: 'middle',
    fontSize: '10',
    fill: headline.color,
    className: 'wg-army-pill-text',
  });

  const rowY = position.y + 9;
  let cursorX = position.x - segmentsWidth / 2;
  for (const segment of measuredSegments) {
    if (segment.glyphPath) {
      group.append(createMapStrokeGlyph(segment.glyphPath, cursorX + 4.5, rowY - 0.5, 10, segment.color, '2'));
    }
    if (!segment.glyphPath) {
      group.append(createSvgShape('rect', {
        x: cursorX.toFixed(1),
        y: (rowY - 3.5).toFixed(1),
        width: '6',
        height: '6',
        fill: segment.color,
      }));
    }
    appendBoardText(group, segment.label, {
      x: cursorX + 11,
      y: rowY + 3.5,
      anchor: 'start',
      fontSize: '10',
      fill: 'var(--text-head)',
      className: 'wg-hex-detail',
    });
    cursorX += segment.width + segmentGap;
  }
  fxLayer.append(group);
  return group;
}

function renderRouteMarks(layer: SVGElement, toSlot: HexNodeSlot, owner: SeatId, route: MarchRoutePoints, groupClass: string, placeLabel: (centerX: number, centerY: number, width: number, height: number, spots: readonly { x: number; y: number }[]) => { x: number; y: number }): void {
  const color = SEAT_COLORS[owner];
  const marksGroup = createSvgShape('g', { class: groupClass });
  for (const mark of route.turnMarks) {
    marksGroup.append(createSvgShape('circle', { cx: mark.x.toFixed(1), cy: mark.y.toFixed(1), r: '3.2', fill: color, stroke: 'var(--bg)', 'stroke-width': '1', class: 'wg-turn-mark' }));
  }
  if (route.arrivalLabel) {
    const spot = placeLabel(toSlot.centerX, toSlot.centerY, route.arrivalLabel.length * 7 + 2, 12, ARRIVAL_LABEL_SPOTS);
    const label = createSvgShape('text', { x: spot.x.toFixed(1), y: (spot.y + 4).toFixed(1), fill: color, 'font-size': '11', 'font-weight': '700', 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: 'var(--bg)', 'stroke-width': '3', class: 'wg-arrival-label' });
    label.textContent = route.arrivalLabel;
    marksGroup.append(label);
  }
  layer.append(marksGroup);
}

function unitVectorBetween(fromX: number, fromY: number, toX: number, toY: number): { x: number; y: number; length: number } {
  const length = Math.hypot(toX - fromX, toY - fromY);
  if (length < 1) return { x: 0, y: 0, length: 0 };
  return { x: (toX - fromX) / length, y: (toY - fromY) / length, length };
}

function distanceInHexes(state: MatchState, fromHexIndex: number, toHexIndex: number): number {
  const from = state.hexes[fromHexIndex];
  const to = state.hexes[toHexIndex];
  if (!from || !to) return 0;
  return Math.max(Math.abs(from.q - to.q), Math.abs(from.r - to.r), Math.abs(from.q + from.r - to.q - to.r));
}

interface RouteStroke {
  owner: SeatId;
  troopTotal: number;
  hexIndices: number[];
  dash: string;
  lineClass: string;
}

function troopTotalOf(troops: TroopCounts): number {
  return troops.raider + troops.guard + troops.envoy;
}

function routeWidthFor(troopTotal: number): string {
  if (troopTotal >= 30) return '3.8';
  if (troopTotal >= 10) return '2.6';
  return '1.6';
}

interface MarchRoutePoints {
  corners: { x: number; y: number }[];
  turnMarks: { x: number; y: number }[];
  arrivalLabel: string | null;
}

interface PreviewGlyphToken {
  kind: 'build' | 'train';
  path: string;
  color: string;
  count: number | null;
}

function clampToViewBox(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  offsetY: number,
  bounds: ViewBoxBounds,
): { x: number; y: number } {
  const aboveY = anchorY - offsetY;
  const preferredY = aboveY - height / 2 < bounds.minY ? anchorY + offsetY : aboveY;
  const clampedX = Math.max(bounds.minX + width / 2, Math.min(bounds.maxX - width / 2, anchorX));
  const clampedY = Math.max(bounds.minY + height / 2, Math.min(bounds.maxY - height / 2, preferredY));
  return { x: clampedX, y: clampedY };
}

function unitGlyphOf(troop: UnitKey): (typeof UNIT_GLYPH_PATHS)[number] {
  return UNIT_GLYPH_PATHS.find((entry) => entry.key === troop) ?? UNIT_GLYPH_PATHS[0];
}

function isImprovementKey(key: BuildingKey | ImprovementKind): key is ImprovementKind {
  return ImprovementKind.safeParse(key).success;
}

function buildingGlyphOf(building: BuildingKey | ImprovementKind): { path: string; color: string } {
  if (isImprovementKey(building)) return IMPROVEMENT_GLYPHS[building];
  return BUILDING_GLYPH_PATHS.find((entry) => entry.key === building) ?? BUILDING_GLYPH_PATHS[0];
}

function collapsedWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateCalloutText(text: string, maxChars: number): string {
  const normalized = collapsedWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function appendSpeakerMarker(
  fxLayer: SVGElement,
  anchorX: number,
  anchorY: number,
  options: { color: string; isThought: boolean; durationMs: number; bounds: ViewBoxBounds },
): SVGElement {
  const markerSize = 18;
  const position = clampToViewBox(anchorX, anchorY, markerSize, markerSize, 28, options.bounds);
  const group = createSvgShape('g', { class: 'wg-board-callout' });
  group.style.animationDuration = `${options.durationMs}ms`;
  appendPillFrame(group, position.x, position.y, markerSize, markerSize, options.color, {
    strokeWidth: '1.4',
    dasharray: options.isThought ? '3 2' : undefined,
  });
  group.append(createMapStrokeGlyph(options.isThought ? THOUGHT_CLOUD_PATH : CHAT_ICON_PATH, position.x, position.y, 11, options.color, '1.6'));
  fxLayer.append(group);
  return group;
}

function renderPreviewBadge(
  layer: SVGElement,
  centerX: number,
  centerY: number,
  tokens: readonly PreviewGlyphToken[],
  seatColor: string,
): void {
  const measured = tokens.map((token) => {
    const digits = token.count === null ? '' : String(token.count);
    const prefixWidth = token.kind === 'build' ? 22 : 18;
    return { ...token, digits, width: prefixWidth + digits.length * 6 };
  });
  const gap = 3.5;
  const contentWidth = measured.reduce((sum, item) => sum + item.width, 0) + Math.max(0, measured.length - 1) * gap;
  const badgeY = centerY - 19;
  const group = createSvgShape('g', {});
  appendPillFrame(group, centerX, badgeY, Math.max(26, contentWidth + 8), 15, seatColor, { dasharray: '2 2' });
  let cursorX = centerX - contentWidth / 2;
  for (const item of measured) {
    if (item.kind === 'build') {
      group.append(
        createMapStrokeGlyph(BUILD_HAMMER_PATH, cursorX + 5, badgeY, 10, NEUTRAL_COLOR),
        createMapStrokeGlyph(item.path, cursorX + 16.5, badgeY, 10.5, item.color),
      );
      cursorX += item.width + gap;
      continue;
    }
    appendBoardText(group, '+', { x: cursorX, y: badgeY + 3.5, anchor: 'start', fontSize: '10', fill: NEUTRAL_COLOR, className: 'wg-army-pill-text' });
    group.append(createMapStrokeGlyph(item.path, cursorX + 11, badgeY, 10.5, item.color));
    if (item.digits.length > 0) {
      appendBoardText(group, item.digits, {
        x: cursorX + 17,
        y: badgeY + 3.5,
        anchor: 'start',
        fontSize: '10',
        fill: 'var(--text-head)',
        className: 'wg-army-pill-text',
      });
    }
    cursorX += item.width + gap;
  }
  layer.append(group);
}

function cleanupNodes(nodes: readonly (SVGElement | (() => void) | null)[]): () => void {
  return () => {
    for (const node of nodes) {
      if (typeof node === 'function') {
        node();
        continue;
      }
      node?.remove();
    }
  };
}

type BoardCaptionTone = 'message' | 'thought';

interface BoardCaptionLine {
  readonly color: string;
  readonly speaker: string;
  readonly text: string;
  readonly tone: BoardCaptionTone;
}

export function isMatchOver(state: MatchState): boolean {
  return state.status === 'finished' || state.status === 'aborted';
}

interface WargamesMapView {
  readonly element: SVGSVGElement;
  readonly viewport: HTMLDivElement;
  readonly caption: HTMLDivElement;
  isBoardSettled(): boolean;
  update(
    state: MatchState | null,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void;
  dispose(): void;
}

function createArrowMarker(markerId: string, fill: string): SVGElement {
  const marker = createSvgShape('marker', {
    id: markerId,
    viewBox: '0 0 10 10',
    refX: '8',
    refY: '5',
    markerWidth: '6',
    markerHeight: '6',
    orient: 'auto',
  });
  marker.append(createSvgShape('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill }));
  return marker;
}

export function createWargamesMap(
  onSelectHex: (hexIndex: number) => void,
  onBoardSettled: () => void,
): WargamesMapView {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wg-hex-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Wargames 37-hex tactical map');

  const defs = createSvgShape('defs', {});
  for (const seatId of WARGAMES_SEAT_IDS) {
    defs.append(createArrowMarker(`wg-arrow-${seatId}`, SEAT_COLORS[seatId]));
  }
  defs.append(createArrowMarker('wg-arrow-breach', 'var(--state-failed)'));

  const hexLayer = createSvgShape('g', { class: 'wg-hex-layer' });
  const previewLayer = createSvgShape('g', { class: 'wg-preview-layer' });
  const routeLayer = createSvgShape('g', { class: 'wg-route-layer' });
  const hexContentLayer = createSvgShape('g', { class: 'wg-hex-content-layer' });
  const armyLayer = createSvgShape('g', { class: 'wg-army-layer' });
  const glideLayer = createSvgShape('g', { class: 'wg-army-layer' });
  const fxLayer = createSvgShape('g', { class: 'wg-fx-layer' });
  const commsLayer = createSvgShape('g', { class: 'wg-fx-layer' });
  svg.append(defs, hexLayer, previewLayer, routeLayer, hexContentLayer, armyLayer, glideLayer, fxLayer, commsLayer);

  const caption = document.createElement('div');
  caption.className = 'wg-board-caption';
  caption.setAttribute('aria-live', 'polite');
  caption.dataset.state = 'empty';
  let captionLineId = 0;

  const viewport = document.createElement('div');
  viewport.className = 'wg-map-viewport';
  const zoomControls = document.createElement('div');
  zoomControls.className = 'wg-map-zoom';
  let fitView: MapViewBox = { x: 0, y: 0, width: 1, height: 1 };
  let currentView: MapViewBox = fitView;

  function applyView(nextView: MapViewBox): void {
    currentView = nextView;
    svg.setAttribute('viewBox', viewBoxAttributeOf(currentView));
    viewport.dataset.zoom = isZoomed(currentView, fitView) ? 'zoomed' : 'fit';
  }

  function zoomAtCenter(factor: number): void {
    applyView(zoomViewBoxAt(currentView, fitView, factor, currentView.x + currentView.width / 2, currentView.y + currentView.height / 2));
  }

  function boardPointAt(clientX: number, clientY: number): { x: number; y: number } {
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: currentView.x + currentView.width / 2, y: currentView.y + currentView.height / 2 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function boardUnitsPerPixel(): number {
    const matrix = svg.getScreenCTM();
    return matrix && matrix.a > 0 ? 1 / matrix.a : 1;
  }

  zoomControls.append(
    button({ variant: 'floating-icon', size: 'small', label: 'Zoom in', icon: createLineIcon(PLUS_ICON_PATH, '1.5'), onClick: () => zoomAtCenter(ZOOM_BUTTON_STEP) }),
    button({ variant: 'floating-icon', size: 'small', label: 'Zoom out', icon: createLineIcon(MINUS_ICON_PATH, '1.5'), onClick: () => zoomAtCenter(1 / ZOOM_BUTTON_STEP) }),
    button({ variant: 'floating-icon', size: 'small', label: 'Fit map', icon: createLineIcon(FIT_ICON_PATH, '1.5'), onClick: () => applyView(fitView) }),
  );
  viewport.append(svg, zoomControls);

  svg.addEventListener('wheel', (event) => {
    const isZoomGesture = event.ctrlKey || event.metaKey || isZoomed(currentView, fitView);
    if (!isZoomGesture) return;
    event.preventDefault();
    const focus = boardPointAt(event.clientX, event.clientY);
    applyView(zoomViewBoxAt(currentView, fitView, Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), focus.x, focus.y));
  }, { passive: false });

  const activePointers = new Map<number, { x: number; y: number }>();
  let dragStart: { x: number; y: number } | null = null;
  let hasDragged = false;
  let pinchDistance = 0;

  function releasePointer(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) dragStart = null;
    pinchDistance = pointerSpread();
  }

  function pointerSpread(): number {
    const [first, second] = [...activePointers.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  }

  svg.addEventListener('pointerdown', (event) => {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    hasDragged = false;
    dragStart = { x: event.clientX, y: event.clientY };
    pinchDistance = pointerSpread();
  });

  svg.addEventListener('pointermove', (event) => {
    const previous = activePointers.get(event.pointerId);
    if (!previous || !dragStart) return;
    if (event.buttons === 0) {
      releasePointer(event);
      return;
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2) {
      const spread = pointerSpread();
      if (pinchDistance > 0 && spread > 0) {
        const [first, second] = [...activePointers.values()];
        const focus = boardPointAt((first.x + second.x) / 2, (first.y + second.y) / 2);
        applyView(zoomViewBoxAt(currentView, fitView, spread / pinchDistance, focus.x, focus.y));
      }
      pinchDistance = spread;
      hasDragged = true;
      return;
    }
    if (!isZoomed(currentView, fitView)) return;
    if (!hasDragged && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) < DRAG_THRESHOLD_PX) return;
    if (!hasDragged) svg.setPointerCapture(event.pointerId);
    hasDragged = true;
    const unitsPerPixel = boardUnitsPerPixel();
    applyView(panViewBox(currentView, fitView, (previous.x - event.clientX) * unitsPerPixel, (previous.y - event.clientY) * unitsPerPixel));
  });

  svg.addEventListener('pointerup', releasePointer);
  svg.addEventListener('pointercancel', releasePointer);
  svg.addEventListener('lostpointercapture', releasePointer);
  svg.addEventListener('click', (event) => {
    if (!hasDragged) return;
    event.stopPropagation();
    hasDragged = false;
  }, true);

  function showCaption(line: BoardCaptionLine): () => void {
    captionLineId += 1;
    const shownLineId = captionLineId;
    const swatch = document.createElement('span');
    swatch.className = 'wg-board-caption-swatch';
    swatch.style.background = line.color;
    const speaker = document.createElement('span');
    speaker.className = 'wg-board-caption-speaker';
    speaker.textContent = line.speaker;
    const text = document.createElement('span');
    text.className = 'wg-board-caption-text';
    text.textContent = line.text;
    caption.replaceChildren(swatch, speaker, text);
    caption.dataset.state = 'shown';
    caption.dataset.tone = line.tone;
    return () => {
      if (shownLineId !== captionLineId) return;
      clearCaption();
    };
  }

  function clearCaption(): void {
    caption.replaceChildren();
    caption.dataset.state = 'empty';
  }

  let lastRenderedMatchId: string | null = null;
  let lastRenderedPov: WargamesPov | null = null;
  let lastResolvedTick: number | null = null;
  let overlayMode: BoardOverlayMode = 'idle';
  let latestState: MatchState | null = null;
  let latestPov: WargamesPov = 'god';
  let latestSelectedHexIndex: number | null = null;
  let latestSpotlightSeatId: SeatId | null = null;
  let lastVillageSnapshots: (VillageState | null)[] = ALL_HEXES.map(() => null);
  let displayedVillages: (VillageState | null)[] = ALL_HEXES.map(() => null);
  let lastArmySnapshots = new Map<string, ArmySnapshot>();
  let lastMessageCount = 0;
  let lastNoteBySeat = new Map<SeatId, string>();

  const diplomacyQueue = createBoardAnimationQueue({
    shouldSkip: () => !prefersMotion(),
    maxPendingBeats: DIPLOMACY_MAX_PENDING_BEATS,
  });

  function resetDiplomacyFx(): void {
    diplomacyQueue.clear();
    commsLayer.replaceChildren();
    clearCaption();
  }

  function seatAnchorSlot(state: MatchState, seatId: SeatId): HexNodeSlot | null {
    const owned = boardVillagesOf(state).find((village) => village?.owner === seatId);
    if (!owned) return null;
    return slots[owned.hexIndex] ?? null;
  }

  function syncDiplomacyTracking(state: MatchState): void {
    lastMessageCount = state.messages.length;
    lastNoteBySeat = new Map(state.seats.map((seat) => [seat.config.seatId, seat.note]));
  }

  function messageSpeakerLabel(state: MatchState, message: MatchState['messages'][number]): string {
    const speakerLabel = seatLabelOf(state, message.from);
    if (message.channel === 'dm' && message.to !== null) return `${speakerLabel} to ${seatLabelOf(state, message.to)}`;
    if (message.channel === 'public') return `${speakerLabel} to everyone`;
    return speakerLabel;
  }

  function emitLiveDiplomacyFx(state: MatchState, pov: WargamesPov): void {
    const firstNewMessageNumber = lastMessageCount;
    const newMessages = state.messages.slice(lastMessageCount);
    const updatedNotes: { seatId: SeatId; note: string }[] = [];
    for (const seat of state.seats) {
      const seatId = seat.config.seatId;
      const previousNote = lastNoteBySeat.get(seatId) ?? '';
      if (seat.note.trim().length > 0 && seat.note !== previousNote) {
        updatedNotes.push({ seatId, note: seat.note });
      }
    }
    syncDiplomacyTracking(state);
    if (!prefersMotion()) return;

    const beats: BoardAnimationBeat[] = [];
    for (const [offset, message] of newMessages.entries()) {
      const isVisible = pov === 'god'
        || message.from === pov
        || message.to === pov
        || message.channel === 'public';
      if (!isVisible) continue;
      const speakerSlot = seatAnchorSlot(state, message.from);
      if (!speakerSlot) continue;
      const recipientSlot = message.channel === 'dm' && message.to !== null ? seatAnchorSlot(state, message.to) : null;
      const speakerColor = SEAT_COLORS[message.from];
      const captionLine: BoardCaptionLine = {
        color: speakerColor,
        speaker: messageSpeakerLabel(state, message),
        text: collapsedWhitespace(message.text),
        tone: 'message',
      };
      beats.push({
        id: `message-${firstNewMessageNumber + offset}`,
        durationMs: DIPLOMACY_MESSAGE_BEAT_MS,
        start: (durationMs) => cleanupNodes([
          recipientSlot
            ? appendDiplomacyArc(commsLayer, speakerSlot, recipientSlot, {
              stroke: speakerColor,
              dasharray: '4 4',
              glyphPath: CHAT_ICON_PATH,
              label: '',
              markerId: `wg-arrow-${message.from}`,
              durationMs,
            })
            : null,
          appendSpeakerMarker(commsLayer, speakerSlot.centerX, speakerSlot.centerY, {
            color: speakerColor,
            isThought: false,
            durationMs,
            bounds: viewBoxBounds,
          }),
          showCaption(captionLine),
        ]),
      });
    }
    for (const entry of updatedNotes) {
      if (pov !== 'god' && entry.seatId !== pov) continue;
      const thinkerSlot = seatAnchorSlot(state, entry.seatId);
      if (!thinkerSlot) continue;
      beats.push({
        id: `note-${entry.seatId}-${state.tick}`,
        durationMs: DIPLOMACY_THOUGHT_BEAT_MS,
        start: (durationMs) => cleanupNodes([
          appendSpeakerMarker(commsLayer, thinkerSlot.centerX, thinkerSlot.centerY, {
            color: SEAT_COLORS[entry.seatId],
            isThought: true,
            durationMs,
            bounds: viewBoxBounds,
          }),
          showCaption({
            color: SEAT_COLORS[entry.seatId],
            speaker: `${seatLabelOf(state, entry.seatId)} thinks`,
            text: collapsedWhitespace(entry.note),
            tone: 'thought',
          }),
        ]),
      });
    }
    diplomacyQueue.appendBeats(beats);
  }

  function prefersMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  }

  function advanceOverlay(event: Parameters<typeof transitionBoardOverlay>[1]): void {
    const nextMode = transitionBoardOverlay(overlayMode, event);
    if (nextMode !== null) overlayMode = nextMode;
  }

  function paintHexSlot(
    index: number,
    village: VillageState | null,
    state: MatchState,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void {
    const slot = slots[index];
    if (!slot) return;
    const isSelected = selectedHexIndex === index;
    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    const isDenseMap = state.spec.mapRadius >= TERRAIN_MIN_RADIUS;
    const terrainKind = state.terrain[index] ?? 'plain';
    slot.indexLabel.setAttribute('visibility', isDenseMap && !isSelected ? 'hidden' : 'visible');
    const territoryTile = village === null ? state.territory.get(index) ?? null : null;
    renderTerrainGlyph(slot.terrainGroup, slot.centerX, slot.centerY, terrainKind, village === null && territoryTile?.improvement == null);
    if (village) renderSiteGlyph(slot, village, isDenseMap && village.owner === null && !isSelected);

    if (village) {
      slot.polygon.setAttribute('points', hexPolygonPoints(slot.centerX, slot.centerY));
      const isBarren = village.productionState === 'barren';
      const seatColor = village.owner !== null ? SEAT_COLORS[village.owner] : null;
      const stroke = isSelected ? 'var(--text-head)' : seatColor ?? 'var(--border-hover)';
      slot.polygon.setAttribute('fill', villageFillColor(village.owner, isBarren));
      slot.polygon.setAttribute('stroke', stroke);
      slot.polygon.setAttribute('stroke-width', isSelected ? '3' : seatColor ? '2' : '1.5');
      if (isBarren) slot.polygon.setAttribute('stroke-dasharray', '3 3');
      if (!isBarren) slot.polygon.removeAttribute('stroke-dasharray');

      slot.detailLabel.textContent = isBarren ? 'Barren' : '';
      slot.detailLabel.setAttribute('class', 'wg-hex-detail');
      slot.detailLabel.setAttribute('font-size', '10');
      slot.detailLabel.setAttribute('fill', 'var(--text-muted)');
      if (isBarren) slot.unitGroup.replaceChildren();
      if (!isBarren) renderHexUnitTokens(slot.unitGroup, slot.centerX, slot.centerY, village.troops);
      renderControlBadge(slot.controlGroup, slot.centerX, slot.centerY, village.loyalty, village.owner);

      const isQuietBarbarian = isDenseMap && village.owner === null && !isSelected;
      setHexDetailShown(slot, !isQuietBarbarian && (!isSpotlightActive || isSelected || village.owner === spotlightSeatId));
      return;
    }

    const barrierFill = barrierFillFor(terrainKind);
    slot.polygon.setAttribute('points', hexPolygonPoints(slot.centerX, slot.centerY, barrierFill === undefined ? 1 : BARRIER_SCALE));
    slot.polygon.setAttribute('fill', barrierFill ?? (territoryTile ? territoryFill(territoryTile.owner) : 'var(--bg-surface)'));
    slot.polygon.setAttribute('stroke', isSelected ? 'var(--text-head)' : barrierFill ?? 'var(--border)');
    slot.polygon.setAttribute('stroke-width', isSelected ? '2.5' : '1');
    slot.polygon.removeAttribute('stroke-dasharray');
    slot.detailLabel.textContent = '';
    slot.detailLabel.setAttribute('class', 'wg-hex-owner');
    slot.detailLabel.setAttribute('font-size', '12');
    slot.detailLabel.setAttribute('fill', 'var(--text-muted)');
    slot.unitGroup.replaceChildren();
    slot.controlGroup.replaceChildren();
    if (territoryTile) {
      renderTerritoryBorder(slot.terrainGroup, state, index, territoryTile.owner, slot.centerX, slot.centerY);
      renderImprovement(slot, territoryTile);
    }

    setHexDetailShown(slot, !isSpotlightActive || isSelected || territoryTile?.owner === spotlightSeatId);
  }

  function setHexDetailShown(slot: HexNodeSlot, isShown: boolean): void {
    const visibility = isShown ? 'visible' : 'hidden';
    slot.detailLabel.setAttribute('visibility', visibility);
    slot.unitGroup.setAttribute('visibility', visibility);
    slot.controlGroup.setAttribute('visibility', visibility);
  }

  function paintAllDisplayedSlots(
    state: MatchState,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void {
    for (let index = 0; index < slots.length; index += 1) {
      paintHexSlot(index, displayedVillages[index], state, pov, selectedHexIndex, spotlightSeatId);
    }
  }

  function boardVillagesOf(state: MatchState): (VillageState | null)[] {
    return state.villages.map(cloneVillage);
  }

  function fieldArmiesOf(state: MatchState) {
    return [...state.armies.values()].filter((army) => army.status === 'marching' || army.status === 'returning' || army.status === 'standing');
  }

  function armyLegOf(army: { status: string; currentHexIndex: number; originHexIndex: number; targetHexIndex: number }): { fromHexIndex: number; toHexIndex: number } {
    return {
      fromHexIndex: army.currentHexIndex,
      toHexIndex: army.status === 'returning' ? army.originHexIndex : army.targetHexIndex,
    };
  }

  function routePointsFor(state: MatchState, fromHexIndex: number, toHexIndex: number, labeledTargets: Set<number>): MarchRoutePoints {
    const route = marchRouteOf(state, fromHexIndex, toHexIndex);
    const centerOf = (hexIndex: number) => ({ x: slots[hexIndex]?.centerX ?? 0, y: slots[hexIndex]?.centerY ?? 0 });
    const showsTurnMarks = state.villages[toHexIndex] !== null || (latestSelectedHexIndex !== null && (latestSelectedHexIndex === fromHexIndex || latestSelectedHexIndex === toHexIndex));
    return {
      corners: route.hexIndices.slice(1, -1).map(centerOf),
      turnMarks: showsTurnMarks ? route.turnEndHexIndices.slice(0, -1).map(centerOf) : [],
      arrivalLabel: arrivalLabelFor(route, showsTurnMarks, toHexIndex, labeledTargets),
    };
  }

  function arrivalLabelFor(route: { reachesTarget: boolean; turnEndHexIndices: number[] }, showsTurnMarks: boolean, toHexIndex: number, labeledTargets: Set<number>): string | null {
    if (!showsTurnMarks || !route.reachesTarget || route.turnEndHexIndices.length === 0 || labeledTargets.has(toHexIndex)) return null;
    labeledTargets.add(toHexIndex);
    return `${route.turnEndHexIndices.length}T`;
  }

  function renderRouteNetwork(strokes: readonly RouteStroke[]): SVGElement {
    const network = createSvgShape('g', { class: 'wg-route-network' });
    const segmentsByStyle = new Map<string, { stroke: RouteStroke; troopsBySegment: Map<string, number>; finalSegments: Set<string>; firstSegments: Set<string> }>();
    for (const stroke of strokes) {
      const styleKey = `${stroke.owner}|${stroke.dash}|${stroke.lineClass}`;
      const style = segmentsByStyle.get(styleKey) ?? { stroke, troopsBySegment: new Map<string, number>(), finalSegments: new Set<string>(), firstSegments: new Set<string>() };
      segmentsByStyle.set(styleKey, style);
      const hexCount = stroke.hexIndices.length;
      if (hexCount < 2) continue;
      style.firstSegments.add(`${stroke.hexIndices[0]}>${stroke.hexIndices[1]}`);
      style.finalSegments.add(`${stroke.hexIndices[hexCount - 2]}>${stroke.hexIndices[hexCount - 1]}`);
      for (let index = 1; index < stroke.hexIndices.length; index += 1) {
        const segmentKey = `${stroke.hexIndices[index - 1]}>${stroke.hexIndices[index]}`;
        style.troopsBySegment.set(segmentKey, (style.troopsBySegment.get(segmentKey) ?? 0) + stroke.troopTotal);
      }
    }
    const seatsBySegmentPair = new Map<string, SeatId[]>();
    for (const style of segmentsByStyle.values()) {
      for (const segmentKey of style.troopsBySegment.keys()) {
        const [fromHex, toHex] = segmentKey.split('>').map(Number);
        const seats = seatsBySegmentPair.get(pairKeyOf(fromHex, toHex)) ?? [];
        if (!seats.includes(style.stroke.owner)) seats.push(style.stroke.owner);
        seatsBySegmentPair.set(pairKeyOf(fromHex, toHex), seats);
      }
    }
    for (const style of segmentsByStyle.values()) {
      for (const [segmentKey, troopTotal] of style.troopsBySegment) {
        const [fromHex, toHex] = segmentKey.split('>').map(Number);
        const fromSlot = slots[fromHex];
        const toSlot = slots[toHex];
        if (!fromSlot || !toSlot) continue;
        const seats = seatsBySegmentPair.get(pairKeyOf(fromHex, toHex)) ?? [style.stroke.owner];
        const lateral = lateralOffsetFor(seats.length, seats.indexOf(style.stroke.owner), fromHex, toHex, 10);
        const direction = unitVectorBetween(fromSlot.centerX, fromSlot.centerY, toSlot.centerX, toSlot.centerY);
        const offsetX = -direction.y * lateral;
        const offsetY = direction.x * lateral;
        const trims = arrowEndpointTrims(direction.length);
        const startTrim = style.firstSegments.has(segmentKey) ? trims.startTrim : 0;
        const endsAtTarget = style.finalSegments.has(segmentKey);
        const endTrim = endsAtTarget ? trims.endTrim : 0;
        network.append(createSvgShape('line', {
          x1: (fromSlot.centerX + direction.x * startTrim + offsetX).toFixed(1),
          y1: (fromSlot.centerY + direction.y * startTrim + offsetY).toFixed(1),
          x2: (toSlot.centerX - direction.x * endTrim + offsetX).toFixed(1),
          y2: (toSlot.centerY - direction.y * endTrim + offsetY).toFixed(1),
          stroke: SEAT_COLORS[style.stroke.owner],
          'stroke-width': routeWidthFor(troopTotal),
          'stroke-dasharray': style.stroke.dash,
          'stroke-linecap': 'round',
          ...(endsAtTarget ? { 'marker-end': `url(#wg-arrow-${style.stroke.owner})` } : {}),
          class: style.stroke.lineClass,
        }));
      }
    }
    return network;
  }

  function lateralOffsetFor(totalOnEdge: number, indexOnEdge: number, fromHexIndex: number, toHexIndex: number, spacing: number): number {
    if (totalOnEdge <= 1) return 0;
    const directionSign = fromHexIndex < toHexIndex ? 1 : -1;
    return (indexOnEdge - (totalOnEdge - 1) / 2) * spacing * directionSign;
  }

  function restingArmiesOf(state: MatchState, pov: WargamesPov, spotlightSeatId: SeatId | null) {
    if (isMatchOver(state)) return [];
    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    return fieldArmiesOf(state).filter((army) => !isSpotlightActive || army.owner === spotlightSeatId);
  }

  function armyPlacementsOf(armies: readonly { id: string; hexIndex: number; owner: SeatId; troops: TroopCounts }[]): ArmyPlacement[] {
    const placementByTileAndSeat = new Map<string, ArmyPlacement>();
    for (const army of armies) {
      const tileAndSeatKey = `${army.hexIndex}:${army.owner}`;
      const placement = placementByTileAndSeat.get(tileAndSeatKey) ?? { hexIndex: army.hexIndex, owner: army.owner, troops: { raider: 0, guard: 0, envoy: 0 }, armyIds: [] };
      addTroopCounts(placement.troops, army.troops);
      placement.armyIds.push(army.id);
      placementByTileAndSeat.set(tileAndSeatKey, placement);
    }
    return [...placementByTileAndSeat.values()];
  }

  let occupiedBoardBoxes: BoardBox[] = [];

  function resetOccupiedBoardBoxes(state: MatchState, villages: readonly (VillageState | null)[]): void {
    occupiedBoardBoxes = [];
    const isDenseMap = state.spec.mapRadius >= TERRAIN_MIN_RADIUS;
    slots.forEach((slot, hexIndex) => {
      const village = villages[hexIndex];
      if (village) {
        if (village.productionState !== 'barren') occupiedBoardBoxes.push(...garrisonBoxesOf(village.troops, slot.centerX, slot.centerY));
        if (village.loyalty < 100) occupiedBoardBoxes.push(boxAround(slot.centerX, slot.centerY + CONTROL_BADGE_OFFSET_Y, controlBadgeContentWidth(`${Math.round(village.loyalty)}%`) + 8, 13));
        if (!village.isBeacon && !(isDenseMap && village.owner === null)) occupiedBoardBoxes.push(boxAround(slot.centerX, slot.centerY + VILLAGE_INCOME_SLOT_Y + 2, VILLAGE_INCOME_HALF_WIDTH * 2, 19));
        return;
      }
      const tile = state.territory.get(hexIndex);
      if (tile?.improvement) occupiedBoardBoxes.push(boxAround(slot.centerX + 2, slot.centerY + IMPROVEMENT_SLOT_Y, 44, 16));
    });
  }

  function placeClear(centerX: number, centerY: number, width: number, height: number, spots: readonly { x: number; y: number }[]): { x: number; y: number } {
    const overlapCountOf = (spot: { x: number; y: number }) => occupiedBoardBoxes.filter((box) => boxesOverlap(box, boxAround(centerX + spot.x, centerY + spot.y, width, height))).length;
    const chosen = spots.reduce((best, spot) => (overlapCountOf(spot) < overlapCountOf(best) ? spot : best), spots[0]);
    const placed = { x: centerX + chosen.x, y: centerY + chosen.y };
    occupiedBoardBoxes.push(boxAround(placed.x, placed.y, width, height));
    return placed;
  }

  function renderArmyPlacements(layer: SVGElement, placements: readonly ArmyPlacement[], villages: readonly (VillageState | null)[], state: MatchState): void {
    const isHugeMap = isHugeMapOf(state);
    resetOccupiedBoardBoxes(state, villages);
    const placementsByHex = new Map<number, ArmyPlacement[]>();
    for (const placement of placements) {
      if (!slots[placement.hexIndex] || troopCountOf(placement.troops) === 0) continue;
      placementsByHex.set(placement.hexIndex, [...(placementsByHex.get(placement.hexIndex) ?? []), placement]);
    }
    const tilesVillagesLast = [...placementsByHex].sort(([leftHex], [rightHex]) => Number(villages[leftHex] != null) - Number(villages[rightHex] != null));
    for (const [hexIndex, tilePlacements] of tilesVillagesLast) {
      const isVillageTile = villages[hexIndex] != null;
      const isCompact = isHugeMap || isVillageTile || tilePlacements.length > 1;
      tilePlacements.forEach((placement) => {
        const slot = slots[hexIndex];
        const tokenWidth = tokenRowWidth(armyTokenContentOf(placement.troops, isCompact), UNIT_TOKEN_GAP) + ARMY_TOKEN_PADDING * 2;
        const center = placeClear(slot.centerX, slot.centerY, tokenWidth, ARMY_TOKEN_HEIGHT, isVillageTile ? VILLAGE_ARMY_SPOTS : SHARED_TILE_ARMY_SPOTS);
        const isLoneHolderOnOwnLand = tilePlacements.length === 1 && troopCountOf(placement.troops) === 1 && state.territory.get(hexIndex)?.owner === placement.owner;
        renderArmyToken(layer, center.x, center.y, placement.owner, placement.troops, isCompact, isLoneHolderOnOwnLand);
      });
    }
  }

  function isHugeMapOf(state: MatchState): boolean {
    return state.spec.mapRadius >= WARGAMES_MAX_HEX_RADIUS;
  }

  function renderActiveArmies(state: MatchState, pov: WargamesPov, spotlightSeatId: SeatId | null): void {
    armyLayer.replaceChildren();
    routeLayer.replaceChildren();
    glideLayer.replaceChildren();
    const armies = restingArmiesOf(state, pov, spotlightSeatId);
    const placements = armyPlacementsOf(armies.map((army) => ({ id: army.id, hexIndex: army.currentHexIndex, owner: army.owner, troops: army.troops })));
    renderArmyPlacements(armyLayer, placements, state.villages, state);
    const labeledArmyTargets = new Set<number>();
    const routeStrokes: RouteStroke[] = [];
    for (const army of [...armies].sort((left, right) => distanceInHexes(state, left.currentHexIndex, left.targetHexIndex) - distanceInHexes(state, right.currentHexIndex, right.targetHexIndex))) {
      if (army.status === 'standing') continue;
      const leg = armyLegOf(army);
      const toSlot = slots[leg.toHexIndex];
      if (!slots[leg.fromHexIndex] || !toSlot) continue;
      const isReturning = army.status === 'returning';
      routeStrokes.push({ owner: army.owner, troopTotal: troopTotalOf(army.troops), hexIndices: marchRouteOf(state, leg.fromHexIndex, leg.toHexIndex).hexIndices, dash: isReturning ? '2 4' : '6 3', lineClass: 'wg-army-line' });
      renderRouteMarks(armyLayer, toSlot, army.owner, routePointsFor(state, leg.fromHexIndex, leg.toHexIndex, labeledArmyTargets), 'wg-army-arrow', placeClear);
    }
    routeLayer.append(renderRouteNetwork(routeStrokes));
  }

  const animQueue = createBoardAnimationQueue({
    shouldSkip: () => !prefersMotion(),
    onDrain: () => {
      advanceOverlay('recap_drained');
      if (latestState) {
        displayedVillages = boardVillagesOf(latestState);
        paintAllDisplayedSlots(latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
        renderActiveArmies(latestState, latestPov, latestSpotlightSeatId);
      }
      renderOrderPreviews();
      diplomacyQueue.resume();
      onBoardSettled();
    },
  });

  let slots: HexNodeSlot[] = [];
  let viewBoxBounds: ViewBoxBounds = DEFAULT_VIEW_BOX_BOUNDS;

  function syncHexSlots(hexes: readonly MatchState['hexes'][number][]): void {
    if (hexes.length === slots.length && slots.length > 0) return;
    animQueue.clear();
    resetDiplomacyFx();
    hexLayer.replaceChildren();
    hexContentLayer.replaceChildren();
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    slots = hexes.map((tile) => {
      const { x, y } = hexCenter(tile.q, tile.r);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const group = createSvgShape('g', { class: 'wg-hex-cell' });
      const polygon = createSvgShape('polygon', {
        points: hexPolygonPoints(x, y),
        fill: 'var(--bg-surface)',
        stroke: 'var(--border)',
        'stroke-width': '1.2',
      });
      const indexLabel = createSvgShape('text', {
        x: x.toFixed(1),
        y: (y - 26).toFixed(1),
        'text-anchor': 'middle',
        'font-size': '9',
        class: 'wg-hex-index',
      });
      indexLabel.textContent = `#${tile.index}`;
      const detailLabel = createSvgShape('text', {
        x: x.toFixed(1),
        y: (y + 3.5).toFixed(1),
        'text-anchor': 'middle',
        'font-size': '10',
        class: 'wg-hex-detail',
      });
      const terrainGroup = createSvgShape('g', { class: 'wg-hex-terrain' });
      const unitGroup = createSvgShape('g', { class: 'wg-hex-units' });
      const controlGroup = createSvgShape('g', { class: 'wg-hex-control' });

      group.append(polygon, terrainGroup, indexLabel, detailLabel);
      hexContentLayer.append(unitGroup, controlGroup);
      group.addEventListener('click', () => onSelectHex(tile.index));
      hexLayer.append(group);
      return { group, polygon, indexLabel, detailLabel, terrainGroup, unitGroup, controlGroup, centerX: x, centerY: y };
    });
    const padX = HEX_EDGE_INSET + 16;
    const padY = HEX_SIZE + 10;
    const viewMinX = Math.floor(minX - padX);
    const viewMinY = Math.floor(minY - padY);
    const viewWidth = Math.ceil(maxX - minX + padX * 2);
    const viewHeight = Math.ceil(maxY - minY + padY * 2);
    fitView = { x: viewMinX, y: viewMinY, width: viewWidth, height: viewHeight };
    viewport.style.setProperty('--wg-map-aspect', `${viewWidth} / ${viewHeight}`);
    applyView(fitView);
    svg.setAttribute('aria-label', `Wargames ${hexes.length}-hex tactical map`);
    viewBoxBounds = {
      minX: viewMinX + 4,
      maxX: viewMinX + viewWidth - 4,
      minY: viewMinY + 8,
      maxY: viewMinY + viewHeight - 8,
    };
    lastVillageSnapshots = hexes.map(() => null);
    displayedVillages = hexes.map(() => null);
  }

  syncHexSlots(ALL_HEXES);

  function renderOrderPreviews(): void {
    previewLayer.replaceChildren();
    if (!latestState || isMatchOver(latestState) || overlayMode === 'recap' || animQueue.getState() !== 'idle') return;
    const isSpotlightActive = latestPov === 'god' && latestSpotlightSeatId !== null;
    const previewVectors: {
      seatId: SeatId;
      fromHexIndex: number;
      toHexIndex: number;
      troops: TroopCounts;
    }[] = [];
    const hexBadges = new Map<number, { seatId: SeatId; tokens: PreviewGlyphToken[] }>();

    const pushHexBadge = (hexIndex: number, seatId: SeatId, token: PreviewGlyphToken) => {
      const existing = hexBadges.get(hexIndex);
      if (existing) {
        if (existing.tokens.length < 2) existing.tokens.push(token);
        return;
      }
      hexBadges.set(hexIndex, { seatId, tokens: [token] });
    };

    for (const seat of latestState.seats) {
      const seatId = seat.config.seatId;
      if (latestPov !== 'god' && seatId !== latestPov) continue;
      for (const order of seat.sealedOrders) {
        if (order.kind === 'march') {
          previewVectors.push({ seatId, fromHexIndex: order.fromHexIndex, toHexIndex: order.toHexIndex, troops: order.troops });
          continue;
        }
        if (order.kind === 'build') {
          const building = buildingGlyphOf(order.building);
          pushHexBadge(order.hexIndex, seatId, { kind: 'build', path: building.path, color: building.color, count: null });
          continue;
        }
        if (order.kind === 'train') {
          const unit = unitGlyphOf(order.troop);
          pushHexBadge(order.hexIndex, seatId, { kind: 'train', path: unit.path, color: unit.color, count: order.count });
        }
      }
    }


    const showsEveryPlan = latestPov !== 'god';
    const isPlanShown = (seatId: SeatId, hexIndices: readonly number[]) => (
      (!isSpotlightActive || seatId === latestSpotlightSeatId)
      && (showsEveryPlan || (latestSelectedHexIndex !== null && hexIndices.includes(latestSelectedHexIndex)))
    );
    let renderedCount = 0;
    const labeledPreviewTargets = new Set<number>();
    const previewStrokes: RouteStroke[] = [];
    for (const entry of previewVectors) {
      if (!isPlanShown(entry.seatId, [entry.fromHexIndex, entry.toHexIndex])) continue;
      const fromSlot = slots[entry.fromHexIndex];
      const toSlot = slots[entry.toHexIndex];
      if (!fromSlot || !toSlot) continue;
      const isFriendlyReinforce = latestState.villages[entry.toHexIndex]?.owner === entry.seatId;
      previewStrokes.push({ owner: entry.seatId, troopTotal: troopTotalOf(entry.troops), hexIndices: marchRouteOf(latestState, entry.fromHexIndex, entry.toHexIndex).hexIndices, dash: previewDashOf(isFriendlyReinforce), lineClass: 'wg-preview-line' });
      renderRouteMarks(previewLayer, toSlot, entry.seatId, routePointsFor(latestState, entry.fromHexIndex, entry.toHexIndex, labeledPreviewTargets), 'wg-preview-arrow', placeClear);
      renderedCount += 1;
    }
    previewLayer.prepend(renderRouteNetwork(previewStrokes));

    for (const [hexIndex, entry] of hexBadges) {
      if (!isPlanShown(entry.seatId, [hexIndex])) continue;
      const slot = slots[hexIndex];
      if (!slot) continue;
      renderPreviewBadge(previewLayer, slot.centerX, slot.centerY, entry.tokens, SEAT_COLORS[entry.seatId]);
      renderedCount += 1;
    }

    advanceOverlay(renderedCount > 0 ? 'show_previews' : 'hide_previews');
  }

  function resetSlotsToBlank(): void {
    for (const slot of slots) {
      setHexDetailShown(slot, true);
      slot.polygon.setAttribute('fill', 'var(--bg-surface)');
      slot.polygon.setAttribute('stroke', 'var(--border)');
      slot.polygon.setAttribute('stroke-width', '1.2');
      slot.polygon.removeAttribute('stroke-dasharray');
      slot.detailLabel.textContent = '';
      slot.unitGroup.replaceChildren();
      slot.controlGroup.replaceChildren();
    }
  }

  function update(
    state: MatchState | null,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void {
    latestState = state;
    latestPov = pov;
    latestSelectedHexIndex = selectedHexIndex;
    latestSpotlightSeatId = spotlightSeatId;

    if (!state) {
      animQueue.clear();
      resetDiplomacyFx();
      armyLayer.replaceChildren();
      routeLayer.replaceChildren();
      glideLayer.replaceChildren();
      fxLayer.replaceChildren();
      previewLayer.replaceChildren();
      advanceOverlay('reset');
      lastRenderedMatchId = null;
      lastRenderedPov = null;
      lastResolvedTick = null;
      lastMessageCount = 0;
      lastNoteBySeat = new Map();
      lastVillageSnapshots = slots.map(() => null);
      displayedVillages = slots.map(() => null);
      lastArmySnapshots = new Map();
      resetSlotsToBlank();
      return;
    }

    syncHexSlots(state.hexes);

    const resolvedTick = latestResolvedTickOf(state.ordersByTick);
    const isSameView = lastRenderedMatchId === state.matchId && lastRenderedPov === pov;
    const isConsecutiveResolution = isSameView && lastResolvedTick !== null && resolvedTick === lastResolvedTick + 1;
    const isResolutionJump = isSameView && lastResolvedTick !== null && resolvedTick !== lastResolvedTick && !isConsecutiveResolution;
    const allowsMotion = prefersMotion();

    if (isSameView && resolvedTick === lastResolvedTick && overlayMode === 'recap') {
      paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
      emitLiveDiplomacyFx(state, pov);
      return;
    }

    const targetVillages = boardVillagesOf(state);
    const armies = fieldArmiesOf(state);
    const nextArmySnapshots = new Map(armies.map((army) => [army.id, {
      hexIndex: army.currentHexIndex,
      targetHexIndex: army.targetHexIndex,
      originHexIndex: army.originHexIndex,
      owner: army.owner,
      troops: { ...army.troops },
      status: army.status,
    }]));

    if (!isSameView || !allowsMotion || isResolutionJump || !isConsecutiveResolution) {
      if (!isSameView || !allowsMotion || isResolutionJump) {
        animQueue.clear();
        resetDiplomacyFx();
        fxLayer.replaceChildren();
        advanceOverlay('reset');
        syncDiplomacyTracking(state);
      }
      if (isSameView && allowsMotion && !isResolutionJump) {
        emitLiveDiplomacyFx(state, pov);
      }
      lastRenderedMatchId = state.matchId;
      lastRenderedPov = pov;
      lastResolvedTick = resolvedTick;
      lastVillageSnapshots = targetVillages.map(cloneVillage);
      displayedVillages = targetVillages.map(cloneVillage);
      lastArmySnapshots = nextArmySnapshots;
      paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
      renderActiveArmies(state, pov, spotlightSeatId);
      renderOrderPreviews();
      return;
    }

    if (overlayMode === 'recap') {
      animQueue.clear();
      fxLayer.replaceChildren();
      advanceOverlay('reset');
    }

    const previousVillages = lastVillageSnapshots.map(cloneVillage);
    displayedVillages = previousVillages.map(cloneVillage);
    paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
    previewLayer.replaceChildren();
    glideLayer.replaceChildren();

    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    const recapRestingArmies = new Map([...lastArmySnapshots].filter(([, army]) => !isSpotlightActive || army.owner === spotlightSeatId));
    routeLayer.replaceChildren();
    const renderRecapArmies = () => {
      armyLayer.replaceChildren();
      const recapArmies = [...recapRestingArmies].map(([id, army]) => ({ id, hexIndex: army.hexIndex, owner: army.owner, troops: army.troops }));
      renderArmyPlacements(armyLayer, armyPlacementsOf(recapArmies), displayedVillages, state);
    };
    renderRecapArmies();

    const glidesByDestHex = new Map<number, ArmyGlide[]>();
    const seenArmyIds = new Set<string>();
    const pushGlide = (destIndex: number, army: ArmySnapshot, armyId: string) => {
      const glide: ArmyGlide = { army, armyId, fromHexIndex: army.hexIndex, destHexIndex: destIndex };
      const existing = glidesByDestHex.get(destIndex);
      if (existing) {
        existing.push(glide);
        return;
      }
      glidesByDestHex.set(destIndex, [glide]);
    };

    const startArmyGlide = (glide: ArmyGlide, glideIndex: number, convergingCount: number, durationMs: number): { node: SVGElement | null; settle: () => void } => {
      recapRestingArmies.delete(glide.armyId);
      renderRecapArmies();
      const arrivedArmy = nextArmySnapshots.get(glide.armyId);
      const staysOnBoard = arrivedArmy !== undefined && arrivedArmy.hexIndex === glide.destHexIndex;
      const route = marchRouteOf(state, glide.fromHexIndex, glide.destHexIndex);
      const routeHexIndices = route.hexIndices.length >= 2 && route.hexIndices.at(-1) === glide.destHexIndex ? route.hexIndices : [glide.fromHexIndex, glide.destHexIndex];
      const lateralStep = convergingCount > 1 ? (glideIndex - (convergingCount - 1) / 2) * 14 : 0;
      const routePoints = routeHexIndices.map((hexIndex, pointIndex) => ({
        x: (slots[hexIndex]?.centerX ?? 0) + (pointIndex === routeHexIndices.length - 1 ? lateralStep : 0),
        y: (slots[hexIndex]?.centerY ?? 0) + ARMY_TOKEN_TILE_OFFSET_Y,
      }));
      const node = appendGlidingArmy(glideLayer, routePoints, glide.army, durationMs, { isCompact: true, fadesOnArrival: !staysOnBoard });
      return {
        node,
        settle: () => {
          if (!staysOnBoard || !arrivedArmy || !latestState || latestState.matchId !== state.matchId) return;
          recapRestingArmies.set(glide.armyId, arrivedArmy);
          renderRecapArmies();
        },
      };
    };

    const currentArmyById = new Map(armies.map((army) => [army.id, army]));
    for (const [armyId, prevArmy] of lastArmySnapshots) {
      seenArmyIds.add(armyId);
      const currentArmy = currentArmyById.get(armyId);
      const destIndex = currentArmy
        ? currentArmy.currentHexIndex
        : prevArmy.status === 'returning'
          ? prevArmy.originHexIndex
          : prevArmy.targetHexIndex;
      if (destIndex === prevArmy.hexIndex) continue;
      const fromSlot = slots[prevArmy.hexIndex];
      const toSlot = slots[destIndex];
      if (!fromSlot || !toSlot) continue;
      if (isSpotlightActive && prevArmy.owner !== spotlightSeatId) continue;
      pushGlide(destIndex, prevArmy, armyId);
    }

    for (const army of armies) {
      if (seenArmyIds.has(army.id)) continue;
      seenArmyIds.add(army.id);
      if (army.currentHexIndex === army.originHexIndex) continue;
      const fromSlot = slots[army.originHexIndex];
      const toSlot = slots[army.currentHexIndex];
      if (!fromSlot || !toSlot) continue;
      if (isSpotlightActive && army.owner !== spotlightSeatId) continue;
      pushGlide(army.currentHexIndex, {
        hexIndex: army.originHexIndex,
        targetHexIndex: army.targetHexIndex,
        originHexIndex: army.originHexIndex,
        owner: army.owner,
        troops: { ...army.troops },
        status: army.status,
      }, army.id);
    }

    const tickOrders = state.ordersByTick[resolvedTick];
    for (const army of state.armies.values()) {
      if (seenArmyIds.has(army.id) || army.departedTick !== resolvedTick) continue;
      if (army.targetHexIndex === army.originHexIndex) continue;
      const fromSlot = slots[army.originHexIndex];
      const toSlot = slots[army.targetHexIndex];
      if (!fromSlot || !toSlot) continue;
      if (isSpotlightActive && army.owner !== spotlightSeatId) continue;
      const displayTroops = troopCountOf(army.troops) > 0
        ? { ...army.troops }
        : findOrderTroopsForArmy(tickOrders, army.owner, army.originHexIndex, army.targetHexIndex);
      pushGlide(army.targetHexIndex, {
        hexIndex: army.originHexIndex,
        targetHexIndex: army.targetHexIndex,
        originHexIndex: army.originHexIndex,
        owner: army.owner,
        troops: displayTroops,
        status: army.status,
      }, army.id);
    }

    const deltasByHex = new Map<number, HexDeltaSummary>();
    for (let index = 0; index < slots.length; index += 1) {
      const prevVillage = previousVillages[index];
      const nextVillage = targetVillages[index];
      if (!prevVillage || !nextVillage) continue;
      const troopDelta = troopCountOf(nextVillage.troops) - troopCountOf(prevVillage.troops);
      const loyaltyDelta = nextVillage.loyalty - prevVillage.loyalty;
      const ownerChanged = nextVillage.owner !== null && prevVillage.owner !== nextVillage.owner;
      const buildingUpgrades = collectBuildingUpgrades(prevVillage.buildings, nextVillage.buildings);
      if (troopDelta !== 0 || loyaltyDelta < 0 || ownerChanged || buildingUpgrades.length > 0) {
        deltasByHex.set(index, {
          troopDelta,
          loyaltyDelta,
          ownerChanged,
          buildingUpgrades,
          targetVillage: cloneVillage(nextVillage) as VillageState,
        });
      }
    }

    lastResolvedTick = resolvedTick;
    lastVillageSnapshots = targetVillages.map(cloneVillage);
    lastArmySnapshots = nextArmySnapshots;
    const labelOf = (seatId: SeatId) => seatLabelOf(state, seatId);

    const beats: BoardAnimationBeat[] = [];
    const activeHexIndices = [...new Set([...glidesByDestHex.keys(), ...deltasByHex.keys()])]
      .sort((left, right) => left - right);

    const hexEvents = activeHexIndices.flatMap((hexIndex) => {
      const slot = slots[hexIndex];
      if (!slot) return [];
      const glides = glidesByDestHex.get(hexIndex) ?? [];
      const delta = deltasByHex.get(hexIndex) ?? null;
      const prevVillage = previousVillages[hexIndex];
      const hasIncomingGlide = glides.length > 0;
      const hasHostileGlide = prevVillage !== null && glides.some(
        (glide) => glide.army.targetHexIndex === hexIndex && glide.army.owner !== prevVillage.owner,
      );
      const actorKey = glides[0]?.army.owner ?? delta?.targetVillage.owner ?? prevVillage?.owner ?? 'neutral';
      return [{
        hexIndex,
        slot,
        glides,
        delta,
        actorKey,
        troopDelta: delta?.troopDelta ?? 0,
        loyaltyDelta: delta?.loyaltyDelta ?? 0,
        ownerChanged: delta?.ownerChanged ?? false,
        hasIncomingGlide,
        hasHostileGlide,
      }];
    });

    const { lowImpactBatches, highImpact } = directTurnEvents(hexEvents);

    for (let batchIndex = 0; batchIndex < lowImpactBatches.length; batchIndex += 1) {
      const batch = lowImpactBatches[batchIndex];
      const isQuietIndividualBeat = highImpact.length === 0 && batch.length === 1;
      beats.push({
        id: `low-impact-${resolvedTick}-${batchIndex}`,
        durationMs: isQuietIndividualBeat ? 1100 : 1050,
        start: (durationMs) => {
          const mounted: SVGElement[] = [];
          const deferredUpdates: (() => void)[] = [];
          if (isQuietIndividualBeat) {
            mounted.push(appendFocusRing(fxLayer, batch[0].slot.centerX, batch[0].slot.centerY));
          }
          for (const item of batch) {
            for (let glideIndex = 0; glideIndex < item.glides.length; glideIndex += 1) {
              const started = startArmyGlide(item.glides[glideIndex], glideIndex, item.glides.length, durationMs);
              if (started.node) mounted.push(started.node);
              deferredUpdates.push(started.settle);
            }
            if (item.delta) {
              const applyVillageUpdate = () => {
                if (!latestState || latestState.matchId !== state.matchId) return;
                displayedVillages[item.hexIndex] = cloneVillage(item.delta?.targetVillage ?? null);
                paintHexSlot(item.hexIndex, displayedVillages[item.hexIndex], latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
              };
              if (item.hasIncomingGlide) deferredUpdates.push(applyVillageUpdate);
              if (!item.hasIncomingGlide) applyVillageUpdate();
              if (item.delta.troopDelta !== 0) {
                const deltaLabel = item.delta.troopDelta > 0 ? `+${item.delta.troopDelta}` : String(item.delta.troopDelta);
                const deltaFill = item.delta.troopDelta > 0 ? 'var(--state-running)' : 'var(--text-dim)';
                mounted.push(appendDeltaCallout(fxLayer, item.slot.centerX, item.slot.centerY - 20, deltaLabel, deltaFill, durationMs));
              }
              if (item.delta.buildingUpgrades.length > 0) {
                const upgrade = item.delta.buildingUpgrades[0];
                const upgradeY = item.delta.troopDelta !== 0 ? item.slot.centerY - 38 : item.slot.centerY - 20;
                mounted.push(appendGlyphCallout(fxLayer, item.slot.centerX, upgradeY, {
                  prefix: '+',
                  glyphPath: upgrade.path,
                  glyphColor: upgrade.color,
                  label: `Lv ${upgrade.level}`,
                  stroke: 'var(--accent)',
                  durationMs,
                }));
              }
            }
          }
          return () => {
            for (const node of mounted) node.remove();
            for (const applyUpdate of deferredUpdates) applyUpdate();
          };
        },
      });
    }

    for (const item of highImpact) {
      const { hexIndex, slot, glides, delta } = item;
      if (glides.length > 0) {
        beats.push({
          id: `march-${resolvedTick}-${hexIndex}`,
          durationMs: 1250,
          start: (durationMs) => {
            const mounted: SVGElement[] = [appendFocusRing(fxLayer, slot.centerX, slot.centerY)];
            const settles: (() => void)[] = [];
            for (let glideIndex = 0; glideIndex < glides.length; glideIndex += 1) {
              const started = startArmyGlide(glides[glideIndex], glideIndex, glides.length, durationMs);
              if (started.node) mounted.push(started.node);
              settles.push(started.settle);
            }
            return () => {
              for (const node of mounted) node.remove();
              for (const settle of settles) settle();
            };
          },
        });
      }

      if (delta || item.hasHostileGlide) {
        const hexBattleReports = battleReportsForHex(state, pov, resolvedTick, hexIndex);
        beats.push({
          id: `impact-${resolvedTick}-${hexIndex}`,
          durationMs: hexBattleReports.length > 0 ? 2200 : 1500,
          start: (durationMs) => {
            if (delta) {
              const currentDisplayed = displayedVillages[hexIndex];
              if (currentDisplayed) {
                displayedVillages[hexIndex] = {
                  ...currentDisplayed,
                  troops: { ...delta.targetVillage.troops },
                  loyalty: delta.targetVillage.loyalty,
                  resources: { ...delta.targetVillage.resources },
                  buildings: { ...delta.targetVillage.buildings },
                };
                if (latestState) {
                  paintHexSlot(hexIndex, displayedVillages[hexIndex], latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
                }
              }
            }
            const mounted: SVGElement[] = [appendFocusRing(fxLayer, slot.centerX, slot.centerY)];
            const clashOwner = delta?.targetVillage.owner ?? null;
            const clashColor = clashOwner !== null ? SEAT_COLORS[clashOwner] : 'var(--state-failed)';
            mounted.push(appendCombatClash(fxLayer, slot.centerX, slot.centerY, clashColor, Math.min(1200, Math.round(durationMs * 0.6))));
            const bubbleNode = appendBattleBubble(fxLayer, slot.centerX, slot.centerY, hexBattleReports, labelOf, durationMs, viewBoxBounds);
            if (bubbleNode) mounted.push(bubbleNode);
            if (!bubbleNode && delta && delta.troopDelta !== 0) {
              const deltaLabel = delta.troopDelta > 0 ? `+${delta.troopDelta}` : String(delta.troopDelta);
              const deltaFill = delta.troopDelta > 0 ? 'var(--state-running)' : 'var(--state-failed)';
              mounted.push(appendDeltaCallout(fxLayer, slot.centerX, slot.centerY - 20, deltaLabel, deltaFill, durationMs));
            }
            if (!bubbleNode && delta && delta.loyaltyDelta < 0) {
              const loyaltyY = delta.troopDelta !== 0 ? slot.centerY - 38 : slot.centerY - 20;
              mounted.push(appendGlyphCallout(fxLayer, slot.centerX, loyaltyY, {
                prefix: '',
                glyphPath: CONTROL_FLAG_PATH,
                glyphColor: 'var(--state-waiting)',
                label: `${delta.loyaltyDelta}%`,
                stroke: 'var(--state-waiting)',
                durationMs,
              }));
            }
            return () => {
              for (const node of mounted) node.remove();
            };
          },
        });

        if (delta?.ownerChanged && delta.targetVillage.owner !== null) {
          const ownerColor = SEAT_COLORS[delta.targetVillage.owner];
          beats.push({
            id: `capture-${resolvedTick}-${hexIndex}`,
            durationMs: 1200,
            start: (durationMs) => {
              displayedVillages[hexIndex] = cloneVillage(delta.targetVillage);
              if (latestState) {
                paintHexSlot(hexIndex, displayedVillages[hexIndex], latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
              }
              const focusRing = appendFocusRing(fxLayer, slot.centerX, slot.centerY);
              const ring = createSvgShape('polygon', {
                points: hexPolygonPoints(slot.centerX, slot.centerY),
                fill: 'none',
                stroke: ownerColor,
                'stroke-width': '2.5',
                class: 'wg-capture-ring',
              });
              ring.style.transformOrigin = `${slot.centerX.toFixed(1)}px ${slot.centerY.toFixed(1)}px`;
              ring.style.animationDuration = `${durationMs}ms`;
              fxLayer.append(ring);
              return () => {
                focusRing.remove();
                ring.remove();
              };
            },
          });
        }
      }
    }

    if (beats.length > 0) {
      advanceOverlay('start_recap');
      diplomacyQueue.hold();
      animQueue.enqueueBatch(beats);
      emitLiveDiplomacyFx(state, pov);
      return;
    }

    diplomacyQueue.resume();
    emitLiveDiplomacyFx(state, pov);
    displayedVillages = targetVillages.map(cloneVillage);
    paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
    renderActiveArmies(state, pov, spotlightSeatId);
    renderOrderPreviews();
  }

  function dispose(): void {
    animQueue.dispose();
    glideLayer.replaceChildren();
    diplomacyQueue.dispose();
    commsLayer.replaceChildren();
    fxLayer.replaceChildren();
    previewLayer.replaceChildren();
    advanceOverlay('reset');
  }

  function isBoardSettled(): boolean {
    return overlayMode !== 'recap' && animQueue.getState() === 'idle';
  }

  return { element: svg, viewport, caption, update, isBoardSettled, dispose };
}
