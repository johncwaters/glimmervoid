import { WARGAMES_SEAT_IDS } from '#shared/contracts/wargames.ts';
import type { OrderItem, SeatId, TroopCounts } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { createSvgShape } from '../svg-dom.ts';
import {
  createBoardAnimationQueue,
  directTurnEvents,
  transitionBoardOverlay,
} from './wargames-anim-queue.ts';
import type { BoardAnimationBeat, BoardOverlayMode } from './wargames-anim-queue.ts';
import type { WargamesPov } from './wargames-store.ts';

type VillageState = NonNullable<MatchState['villages'][number]>;

export function latestResolvedTickOf(ordersByTick: Readonly<Record<number, unknown>>): number {
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
const LOYALTY_BAR_WIDTH = 36;
const LOYALTY_BAR_HEIGHT = 3;
const SQRT_3 = Math.sqrt(3);

export const UNIT_GLYPH_PATHS: readonly { key: 'raider' | 'guard' | 'envoy'; label: string; path: string }[] = [
  { key: 'raider', label: 'Raider', path: 'M -2.4 -2.4 L 2.6 0 L -2.4 2.4 L -1 0 Z' },
  { key: 'guard', label: 'Guard', path: 'M -2.2 -2.4 L 2.2 -2.4 L 2.2 0.2 L 0 2.6 L -2.2 0.2 Z' },
  { key: 'envoy', label: 'Envoy', path: 'M 0 -2.6 L 2.4 0 L 0 2.6 L -2.4 0 Z' },
];

export const BUILDING_GLYPH_PATHS: readonly { key: 'farm' | 'mine' | 'barracks' | 'wall'; label: string; path: string }[] = [
  { key: 'farm', label: 'Farm', path: 'M 0 -2.6 C 2 -1.2 2.4 0.8 0 2.6 C -2.4 0.8 -2 -1.2 0 -2.6 Z' },
  { key: 'mine', label: 'Mine', path: 'M 0 -2.6 L 2.4 -1.2 L 2.4 1.2 L 0 2.6 L -2.4 1.2 L -2.4 -1.2 Z' },
  { key: 'barracks', label: 'Barracks', path: 'M 0 -2.6 L 2.6 -0.2 H 1.8 V 2.4 H -1.8 V -0.2 H -2.6 Z' },
  { key: 'wall', label: 'Wall', path: 'M -2.6 -2 H -1.2 V -0.6 H -0.4 V -2 H 0.4 V -0.6 H 1.2 V -2 H 2.6 V 2 H -2.6 Z' },
];

function renderArmyPill(
  armyGroup: SVGElement,
  midX: number,
  midY: number,
  owner: SeatId,
  troops: { raider: number; guard: number; envoy: number },
  color: string,
  isReturning = false,
): void {
  const active = UNIT_GLYPH_PATHS
    .filter((unit) => troops[unit.key] > 0)
    .map((unit) => {
      const digits = String(troops[unit.key]);
      return { unit, digits, width: 6.4 + digits.length * 5.1 };
    });
  const ownerTag = isReturning ? `RET ${owner.toUpperCase()}` : owner.toUpperCase();
  const ownerWidth = ownerTag.length * 5.2;
  const gap = 4;
  const tokensWidth = active.reduce((sum, item) => sum + item.width, 0) + Math.max(0, active.length - 1) * gap;
  const contentWidth = active.length > 0 ? ownerWidth + gap + tokensWidth : ownerWidth;
  const pillWidth = Math.max(30, contentWidth + 10);
  const pillHeight = 16;

  const pillAttrs: Record<string, string> = {
    x: (midX - pillWidth / 2).toFixed(1),
    y: (midY - pillHeight / 2).toFixed(1),
    width: pillWidth.toFixed(1),
    height: String(pillHeight),
    rx: '2',
    fill: 'var(--bg)',
    stroke: color,
    'stroke-width': '1.2',
  };
  if (isReturning) pillAttrs['stroke-dasharray'] = '3 2';
  armyGroup.append(createSvgShape('rect', pillAttrs));

  let cursorX = midX - contentWidth / 2;
  const baselineY = midY + 3;
  const ownerText = createSvgShape('text', {
    x: cursorX.toFixed(1),
    y: baselineY.toFixed(1),
    'text-anchor': 'start',
    'font-size': '8.5',
    fill: color,
    class: 'wg-army-pill-text',
  });
  ownerText.textContent = ownerTag;
  armyGroup.append(ownerText);
  cursorX += ownerWidth + gap;

  for (const item of active) {
    const iconGroup = createSvgShape('g', {
      transform: `translate(${(cursorX + 2.6).toFixed(1)}, ${(baselineY - 2.6).toFixed(1)})`,
    });
    iconGroup.append(createSvgShape('path', { d: item.unit.path, fill: color }));
    const countText = createSvgShape('text', {
      x: (cursorX + 6.4).toFixed(1),
      y: baselineY.toFixed(1),
      'text-anchor': 'start',
      'font-size': '8.5',
      fill: 'var(--text-head)',
      class: 'wg-army-pill-text',
    });
    countText.textContent = item.digits;
    armyGroup.append(iconGroup, countText);
    cursorX += item.width + gap;
  }
}

function renderHexUnitTokens(
  container: SVGElement,
  centerX: number,
  centerY: number,
  troops: { raider: number; guard: number; envoy: number },
  fillColor: string,
): boolean {
  container.replaceChildren();
  container.removeAttribute('transform');
  const active = UNIT_GLYPH_PATHS
    .filter((unit) => troops[unit.key] > 0)
    .map((unit) => {
      const digits = String(troops[unit.key]);
      return { unit, digits, width: 6.4 + digits.length * 5.1 };
    });
  if (active.length === 0) return false;
  const gap = 3.5;
  const totalWidth = active.reduce((sum, item) => sum + item.width, 0) + gap * (active.length - 1);
  const baselineY = centerY + 13;
  let cursorX = centerX - totalWidth / 2;
  for (const item of active) {
    const iconCenterX = cursorX + 2.6;
    const iconGroup = createSvgShape('g', {
      transform: `translate(${iconCenterX.toFixed(1)}, ${(baselineY - 2.6).toFixed(1)})`,
    });
    iconGroup.append(createSvgShape('path', { d: item.unit.path, fill: fillColor }));
    const countText = createSvgShape('text', {
      x: (cursorX + 6.4).toFixed(1),
      y: baselineY.toFixed(1),
      'text-anchor': 'start',
      'font-size': '8.5',
      fill: 'var(--text-head)',
      class: 'wg-hex-detail',
    });
    countText.textContent = item.digits;
    container.append(iconGroup, countText);
    cursorX += item.width + gap;
  }
  const maxUsableWidth = 56;
  if (totalWidth > maxUsableWidth) {
    const scale = maxUsableWidth / totalWidth;
    container.setAttribute(
      'transform',
      `translate(${centerX.toFixed(1)}, ${baselineY.toFixed(1)}) scale(${scale.toFixed(3)}) translate(${(-centerX).toFixed(1)}, ${(-baselineY).toFixed(1)})`,
    );
  }
  return true;
}

function hexCenter(axialQ: number, axialR: number): { x: number; y: number } {
  return {
    x: HEX_SIZE * (SQRT_3 * axialQ + (SQRT_3 / 2) * axialR),
    y: HEX_SIZE * (1.5 * axialR),
  };
}

function hexPolygonPoints(centerX: number, centerY: number): string {
  const points: string[] = [];
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * (60 * corner - 30);
    const pointX = centerX + HEX_INNER_RADIUS * Math.cos(angle);
    const pointY = centerY + HEX_INNER_RADIUS * Math.sin(angle);
    points.push(`${pointX.toFixed(1)},${pointY.toFixed(1)}`);
  }
  return points.join(' ');
}

function loyaltyFillColor(loyalty: number, owner: SeatId | null): string {
  if (loyalty <= 35) return 'var(--state-failed)';
  if (loyalty <= 65) return 'var(--state-waiting)';
  if (owner !== null) return SEAT_COLORS[owner];
  return 'var(--text-dim)';
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
  ownerBadge: SVGElement;
  ownerLabel: SVGElement;
  detailLabel: SVGElement;
  unitGroup: SVGElement;
  loyaltyTrack: SVGElement;
  loyaltyFill: SVGElement;
  centerX: number;
  centerY: number;
}

interface ArmySnapshot {
  hexIndex: number;
  targetHexIndex: number;
  originHexIndex: number;
  owner: SeatId;
  troops: { raider: number; guard: number; envoy: number };
  status: string;
}

function troopCountOf(troops: { raider: number; guard: number; envoy: number }): number {
  return troops.raider + troops.guard + troops.envoy;
}

interface BuildingUpgradeCallout {
  path: string;
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
      upgrades.push({ path: entry.path, level: next[entry.key] });
    }
  }
  return upgrades;
}

function appendDiplomacyArc(
  fxLayer: SVGElement,
  fromSlot: HexNodeSlot,
  toSlot: HexNodeSlot,
  options: {
    stroke: string;
    dasharray: string;
    label: string;
    durationMs: number;
  },
): SVGElement | null {
  const vectorX = toSlot.centerX - fromSlot.centerX;
  const vectorY = toSlot.centerY - fromSlot.centerY;
  const distance = Math.hypot(vectorX, vectorY);
  if (distance < 1) return null;

  const midX = (fromSlot.centerX + toSlot.centerX) / 2;
  const midY = (fromSlot.centerY + toSlot.centerY) / 2;
  const curveLift = Math.min(44, distance * 0.24);
  const controlX = midX - (vectorY / distance) * curveLift;
  const controlY = midY + (vectorX / distance) * curveLift;
  const peakX = (fromSlot.centerX + 2 * controlX + toSlot.centerX) / 4;
  const peakY = (fromSlot.centerY + 2 * controlY + toSlot.centerY) / 4;

  const group = createSvgShape('g', { class: 'wg-diplomacy-arc' });
  group.style.animationDuration = `${options.durationMs}ms`;
  group.append(
    createSvgShape('path', {
      d: `M ${fromSlot.centerX.toFixed(1)} ${fromSlot.centerY.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${toSlot.centerX.toFixed(1)} ${toSlot.centerY.toFixed(1)}`,
      fill: 'none',
      stroke: options.stroke,
      'stroke-width': '2',
      'stroke-dasharray': options.dasharray,
    }),
  );

  const pillWidth = Math.max(26, options.label.length * 6.2 + 10);
  group.append(
    createSvgShape('rect', {
      x: (peakX - pillWidth / 2).toFixed(1),
      y: (peakY - 7).toFixed(1),
      width: pillWidth.toFixed(1),
      height: '14',
      rx: '2',
      fill: 'var(--bg)',
      stroke: options.stroke,
      'stroke-width': '1',
    }),
  );
  const tag = createSvgShape('text', {
    x: peakX.toFixed(1),
    y: (peakY + 3).toFixed(1),
    'text-anchor': 'middle',
    'font-size': '8.5',
    fill: options.stroke,
    class: 'wg-delta-text',
  });
  tag.textContent = options.label;
  group.append(tag);
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
  const pillWidth = Math.max(24, label.length * 6.5 + 8);
  const group = createSvgShape('g', { class: 'wg-delta-callout' });
  group.style.animationDuration = `${durationMs}ms`;
  group.append(
    createSvgShape('rect', {
      x: (centerX - pillWidth / 2).toFixed(1),
      y: (centerY - 10).toFixed(1),
      width: pillWidth.toFixed(1),
      height: '14',
      rx: '2',
      fill: 'var(--bg)',
      stroke: fill,
      'stroke-width': '1',
    }),
  );
  const callout = createSvgShape('text', {
    x: centerX.toFixed(1),
    y: (centerY + 0.5).toFixed(1),
    'text-anchor': 'middle',
    'font-size': '9.5',
    fill,
    class: 'wg-delta-text',
  });
  callout.textContent = label;
  group.append(callout);
  fxLayer.append(group);
  return group;
}

function appendGlyphCallout(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  glyphPath: string,
  level: number,
  fill: string,
  durationMs: number,
): SVGElement {
  const digits = String(level);
  const contentWidth = 14 + digits.length * 5.8;
  const pillWidth = Math.max(26, contentWidth + 8);
  const group = createSvgShape('g', { class: 'wg-delta-callout' });
  group.style.animationDuration = `${durationMs}ms`;
  group.append(
    createSvgShape('rect', {
      x: (centerX - pillWidth / 2).toFixed(1),
      y: (centerY - 10).toFixed(1),
      width: pillWidth.toFixed(1),
      height: '14',
      rx: '2',
      fill: 'var(--bg)',
      stroke: fill,
      'stroke-width': '1',
    }),
  );
  const startX = centerX - contentWidth / 2;
  const plusText = createSvgShape('text', {
    x: startX.toFixed(1),
    y: (centerY + 0.5).toFixed(1),
    'text-anchor': 'start',
    'font-size': '9',
    fill,
    class: 'wg-delta-text',
  });
  plusText.textContent = '+';
  const iconGroup = createSvgShape('g', {
    transform: `translate(${(startX + 8.5).toFixed(1)}, ${(centerY - 3).toFixed(1)})`,
  });
  iconGroup.append(createSvgShape('path', { d: glyphPath, fill }));
  const levelText = createSvgShape('text', {
    x: (startX + 13).toFixed(1),
    y: (centerY + 0.5).toFixed(1),
    'text-anchor': 'start',
    'font-size': '9',
    fill,
    class: 'wg-delta-text',
  });
  levelText.textContent = digits;
  group.append(plusText, iconGroup, levelText);
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

function appendGlidingArmy(
  fxLayer: SVGElement,
  fromSlot: HexNodeSlot,
  toSlot: HexNodeSlot,
  army: ArmySnapshot,
  durationMs: number,
  slotOffsetIndex = 0,
  totalConverging = 1,
  mode: 'glide' | 'lunge' = 'glide',
): SVGElement | null {
  const vectorX = toSlot.centerX - fromSlot.centerX;
  const vectorY = toSlot.centerY - fromSlot.centerY;
  const distance = Math.hypot(vectorX, vectorY);
  if (distance < 1) return null;

  const unitX = vectorX / distance;
  const unitY = vectorY / distance;
  const pullback = totalConverging > 1 || mode === 'lunge' ? Math.min(22, distance * 0.34) : 0;
  const lateralStep = totalConverging > 1 ? (slotOffsetIndex - (totalConverging - 1) / 2) * 10 : 0;
  const landX = toSlot.centerX - unitX * pullback - unitY * lateralStep;
  const landY = toSlot.centerY - unitY * pullback + unitX * lateralStep;
  const deltaX = mode === 'lunge' ? unitX * 14 : fromSlot.centerX - landX;
  const deltaY = mode === 'lunge' ? unitY * 14 : fromSlot.centerY - landY;

  const wrapper = createSvgShape('g', {});
  if (mode === 'glide' && totalConverging > 1) {
    const trim = Math.min(16, distance * 0.25);
    wrapper.append(
      createSvgShape('line', {
        x1: (fromSlot.centerX + unitX * trim).toFixed(1),
        y1: (fromSlot.centerY + unitY * trim).toFixed(1),
        x2: (toSlot.centerX - unitX * trim).toFixed(1),
        y2: (toSlot.centerY - unitY * trim).toFixed(1),
        stroke: SEAT_COLORS[army.owner],
        'stroke-width': '2',
        'stroke-dasharray': '5 3',
        opacity: '0.85',
        'marker-end': `url(#wg-arrow-${army.owner})`,
      }),
    );
  }

  const animClass = mode === 'lunge' ? 'wg-battle-lunge' : 'wg-army-glide';
  const glideGroup = createSvgShape('g', { class: animClass });
  glideGroup.style.setProperty('--wg-dx', `${deltaX.toFixed(1)}px`);
  glideGroup.style.setProperty('--wg-dy', `${deltaY.toFixed(1)}px`);
  glideGroup.style.animationDuration = `${durationMs}ms`;
  renderArmyPill(glideGroup, landX, landY, army.owner, army.troops, SEAT_COLORS[army.owner]);
  wrapper.append(glideGroup);
  fxLayer.append(wrapper);
  return wrapper;
}

function renderMarchVector(
  layer: SVGElement,
  fromSlot: HexNodeSlot,
  toSlot: HexNodeSlot,
  owner: SeatId,
  troops: { raider: number; guard: number; envoy: number },
  options: {
    strokeDasharray: string;
    strokeWidth: string;
    opacity: string;
    groupClass: string;
    lineClass: string;
    showPill?: boolean;
    lateralOffset?: number;
    isReturning?: boolean;
  },
): void {
  const deltaX = toSlot.centerX - fromSlot.centerX;
  const deltaY = toSlot.centerY - fromSlot.centerY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 1) return;

  const unitX = deltaX / distance;
  const unitY = deltaY / distance;
  const lateral = options.lateralOffset ?? 0;
  const offsetX = -unitY * lateral;
  const offsetY = unitX * lateral;
  const trim = Math.min(16, distance * 0.25);
  const startX = fromSlot.centerX + unitX * trim + offsetX;
  const startY = fromSlot.centerY + unitY * trim + offsetY;
  const endX = toSlot.centerX - unitX * trim + offsetX;
  const endY = toSlot.centerY - unitY * trim + offsetY;
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;

  const color = SEAT_COLORS[owner];
  const vectorGroup = createSvgShape('g', { class: options.groupClass, opacity: options.opacity });
  vectorGroup.append(
    createSvgShape('line', {
      x1: startX.toFixed(1),
      y1: startY.toFixed(1),
      x2: endX.toFixed(1),
      y2: endY.toFixed(1),
      stroke: color,
      'stroke-width': options.strokeWidth,
      'stroke-dasharray': options.strokeDasharray,
      'marker-end': `url(#wg-arrow-${owner})`,
      class: options.lineClass,
    }),
  );
  if (options.showPill !== false) {
    renderArmyPill(vectorGroup, midX, midY, owner, troops, color, options.isReturning);
  }
  layer.append(vectorGroup);
}

interface PreviewGlyphToken {
  path: string;
  count: number | null;
}

function glyphPathForUnit(troop: 'raider' | 'guard' | 'envoy'): string {
  return UNIT_GLYPH_PATHS.find((entry) => entry.key === troop)?.path ?? UNIT_GLYPH_PATHS[0].path;
}

function glyphPathForBuilding(building: 'farm' | 'mine' | 'barracks' | 'wall'): string {
  return BUILDING_GLYPH_PATHS.find((entry) => entry.key === building)?.path ?? BUILDING_GLYPH_PATHS[0].path;
}

function truncateCalloutText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function appendBoardCallout(
  fxLayer: SVGElement,
  anchorX: number,
  anchorY: number,
  options: { label: string; color: string; isThought: boolean; durationMs: number },
): SVGElement {
  const clipped = truncateCalloutText(options.label, 42);
  const pillWidth = Math.min(204, Math.max(54, clipped.length * 4.8 + 14));
  const pillHeight = 16;
  const preferredY = anchorY < -195 ? anchorY + 26 : anchorY - 26;
  const clampedX = Math.max(-266 + pillWidth / 2, Math.min(266 - pillWidth / 2, anchorX));
  const clampedY = Math.max(-232 + pillHeight / 2, Math.min(232 - pillHeight / 2, preferredY));

  const group = createSvgShape('g', { class: 'wg-board-callout' });
  group.style.animationDuration = `${options.durationMs}ms`;
  const rectAttrs: Record<string, string> = {
    x: (clampedX - pillWidth / 2).toFixed(1),
    y: (clampedY - pillHeight / 2).toFixed(1),
    width: pillWidth.toFixed(1),
    height: String(pillHeight),
    rx: '2',
    fill: 'var(--bg)',
    stroke: options.color,
    'stroke-width': '1.2',
  };
  if (options.isThought) rectAttrs['stroke-dasharray'] = '3 2';
  group.append(createSvgShape('rect', rectAttrs));

  const textNode = createSvgShape('text', {
    x: clampedX.toFixed(1),
    y: (clampedY + 2.8).toFixed(1),
    'text-anchor': 'middle',
    'font-size': '8',
    fill: 'var(--text-head)',
    class: 'wg-army-pill-text',
  });
  textNode.textContent = clipped;
  group.append(textNode);
  fxLayer.append(group);
  return group;
}

function renderPreviewBadge(
  layer: SVGElement,
  centerX: number,
  centerY: number,
  tokens: readonly PreviewGlyphToken[],
  color: string,
  opacity: string,
): void {
  const measured = tokens.map((token) => {
    const digits = token.count === null ? '' : String(token.count);
    return { path: token.path, digits, width: 11.2 + digits.length * 4.7 };
  });
  const gap = 3.5;
  const contentWidth = measured.reduce((sum, item) => sum + item.width, 0) + Math.max(0, measured.length - 1) * gap;
  const badgeWidth = Math.max(20, contentWidth + 8);
  const badgeHeight = 13;
  const badgeX = centerX + 14;
  const badgeY = centerY - 15;
  const group = createSvgShape('g', { opacity });
  group.append(createSvgShape('rect', {
    x: (badgeX - badgeWidth / 2).toFixed(1),
    y: (badgeY - badgeHeight / 2).toFixed(1),
    width: badgeWidth.toFixed(1),
    height: String(badgeHeight),
    rx: '2',
    fill: 'var(--bg)',
    stroke: color,
    'stroke-width': '1',
    'stroke-dasharray': '2 2',
  }));
  let cursorX = badgeX - contentWidth / 2;
  for (const item of measured) {
    const plusText = createSvgShape('text', {
      x: cursorX.toFixed(1),
      y: (badgeY + 2.6).toFixed(1),
      'text-anchor': 'start',
      'font-size': '7.5',
      fill: color,
      class: 'wg-army-pill-text',
    });
    plusText.textContent = '+';
    const iconGroup = createSvgShape('g', {
      transform: `translate(${(cursorX + 7.2).toFixed(1)}, ${badgeY.toFixed(1)}) scale(0.88)`,
    });
    iconGroup.append(createSvgShape('path', { d: item.path, fill: color }));
    group.append(plusText, iconGroup);
    if (item.digits.length > 0) {
      const countText = createSvgShape('text', {
        x: (cursorX + 10.6).toFixed(1),
        y: (badgeY + 2.6).toFixed(1),
        'text-anchor': 'start',
        'font-size': '7.5',
        fill: color,
        class: 'wg-army-pill-text',
      });
      countText.textContent = item.digits;
      group.append(countText);
    }
    cursorX += item.width + gap;
  }
  layer.append(group);
}

interface WargamesMapView {
  readonly element: SVGSVGElement;
  update(
    state: MatchState | null,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void;
  dispose(): void;
}

export function createWargamesMap(onSelectHex: (hexIndex: number) => void): WargamesMapView {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-270 -240 540 480');
  svg.setAttribute('class', 'wg-hex-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Wargames 37-hex tactical map');

  const defs = createSvgShape('defs', {});
  for (const seatId of WARGAMES_SEAT_IDS) {
    const marker = createSvgShape('marker', {
      id: `wg-arrow-${seatId}`,
      viewBox: '0 0 10 10',
      refX: '8',
      refY: '5',
      markerWidth: '6',
      markerHeight: '6',
      orient: 'auto',
    });
    marker.append(createSvgShape('path', {
      d: 'M 0 1 L 10 5 L 0 9 z',
      fill: SEAT_COLORS[seatId],
    }));
    defs.append(marker);
  }

  const hexLayer = createSvgShape('g', { class: 'wg-hex-layer' });
  const previewLayer = createSvgShape('g', { class: 'wg-preview-layer' });
  const armyLayer = createSvgShape('g', { class: 'wg-army-layer' });
  const fxLayer = createSvgShape('g', { class: 'wg-fx-layer' });
  const commsLayer = createSvgShape('g', { class: 'wg-fx-layer' });
  svg.append(defs, hexLayer, previewLayer, armyLayer, fxLayer, commsLayer);

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
  let lastActiveContractIds = new Set<string>();
  let lastLedgerCount = 0;
  let lastNoteBySeat = new Map<SeatId, string>();
  const transientFxTimers = new Set<ReturnType<typeof setTimeout>>();
  const activeCalloutBySeat = new Map<SeatId, { node: SVGElement; timer: ReturnType<typeof setTimeout> }>();

  function clearTransientFx(): void {
    for (const handle of transientFxTimers) clearTimeout(handle);
    transientFxTimers.clear();
    for (const entry of activeCalloutBySeat.values()) {
      clearTimeout(entry.timer);
      entry.node.remove();
    }
    activeCalloutBySeat.clear();
    commsLayer.replaceChildren();
  }

  function seatAnchorSlot(state: MatchState, pov: WargamesPov, seatId: SeatId): HexNodeSlot | null {
    const owned = visibleVillagesArray(state, pov).find((village) => village?.owner === seatId);
    if (!owned) return null;
    return slots[owned.hexIndex] ?? null;
  }

  function mountSeatBoardCallout(
    seatId: SeatId,
    anchorSlot: HexNodeSlot | null,
    options: { label: string; color: string; isThought: boolean; durationMs: number },
  ): void {
    if (!anchorSlot) return;
    const previous = activeCalloutBySeat.get(seatId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.node.remove();
      activeCalloutBySeat.delete(seatId);
    }
    const node = appendBoardCallout(commsLayer, anchorSlot.centerX, anchorSlot.centerY, options);
    const timer = setTimeout(() => {
      activeCalloutBySeat.delete(seatId);
      node.remove();
    }, options.durationMs);
    activeCalloutBySeat.set(seatId, { node, timer });
  }

  function mountTransientDiplomacyArc(
    fromSlot: HexNodeSlot | null,
    toSlot: HexNodeSlot | null,
    options: { stroke: string; dasharray: string; label: string; durationMs: number },
  ): void {
    if (!fromSlot || !toSlot) return;
    const node = appendDiplomacyArc(commsLayer, fromSlot, toSlot, options);
    if (!node) return;
    const handle = setTimeout(() => {
      transientFxTimers.delete(handle);
      node.remove();
    }, options.durationMs);
    transientFxTimers.add(handle);
  }

  function syncDiplomacyTracking(state: MatchState): void {
    lastMessageCount = state.messages.length;
    lastActiveContractIds = new Set(
      [...state.contracts.values()].filter((contract) => contract.status === 'active').map((contract) => contract.id),
    );
    lastLedgerCount = state.ledger.length;
    lastNoteBySeat = new Map(state.seats.map((seat) => [seat.config.seatId, seat.note]));
  }

  function emitLiveDiplomacyFx(state: MatchState, pov: WargamesPov): void {
    const allowsMotion = prefersMotion();
    const newMessages = state.messages.slice(lastMessageCount);
    const activeContracts = [...state.contracts.values()].filter((contract) => contract.status === 'active');
    const newlyAccepted = activeContracts.filter((contract) => !lastActiveContractIds.has(contract.id));
    const newBreaches = state.ledger.slice(lastLedgerCount);
    const updatedNotes: { seatId: SeatId; note: string }[] = [];
    for (const seat of state.seats) {
      const seatId = seat.config.seatId;
      const previousNote = lastNoteBySeat.get(seatId) ?? '';
      if (seat.note.trim().length > 0 && seat.note !== previousNote) {
        updatedNotes.push({ seatId, note: seat.note });
      }
    }
    syncDiplomacyTracking(state);

    if (!allowsMotion) return;
    const povSeat = pov === 'god' ? null : state.seats.find((candidate) => candidate.config.seatId === pov) ?? null;
    for (const message of newMessages) {
      const isVisible = pov === 'god'
        || message.from === pov
        || message.to === pov
        || (message.channel === 'tribe' && povSeat !== null && povSeat.tribeId !== null && povSeat.tribeId === message.tribeId);
      if (!isVisible) continue;
      if (message.channel === 'dm' && message.to !== null) {
        mountTransientDiplomacyArc(seatAnchorSlot(state, pov, message.from), seatAnchorSlot(state, pov, message.to), {
          stroke: SEAT_COLORS[message.from],
          dasharray: '4 4',
          label: `${message.from.toUpperCase()}->${message.to.toUpperCase()} DM`,
          durationMs: 3800,
        });
      }
      const prefix = message.to ? `${message.from.toUpperCase()}->${message.to.toUpperCase()}` : message.from.toUpperCase();
      mountSeatBoardCallout(message.from, seatAnchorSlot(state, pov, message.from), {
        label: `${prefix}: ${message.text}`,
        color: SEAT_COLORS[message.from],
        isThought: false,
        durationMs: 4500,
      });
    }
    for (const entry of updatedNotes) {
      if (pov !== 'god' && entry.seatId !== pov) continue;
      mountSeatBoardCallout(entry.seatId, seatAnchorSlot(state, pov, entry.seatId), {
        label: `${entry.seatId.toUpperCase()}: ${entry.note}`,
        color: SEAT_COLORS[entry.seatId],
        isThought: true,
        durationMs: 4500,
      });
    }
    for (const contract of newlyAccepted) {
      if (pov !== 'god' && contract.proposer !== pov && contract.counterparty !== pov) continue;
      mountTransientDiplomacyArc(seatAnchorSlot(state, pov, contract.proposer), seatAnchorSlot(state, pov, contract.counterparty), {
        stroke: 'var(--state-running)',
        dasharray: 'none',
        label: 'PACT',
        durationMs: 4200,
      });
    }
    for (const breach of newBreaches) {
      mountTransientDiplomacyArc(seatAnchorSlot(state, pov, breach.breacher), seatAnchorSlot(state, pov, breach.victim), {
        stroke: 'var(--state-failed)',
        dasharray: '6 3',
        label: 'BREACH',
        durationMs: 4800,
      });
    }
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
    const isSelected = selectedHexIndex === index;
    const isFogged = pov !== 'god' && state.villages[index] !== null && village === null;
    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;

    if (village) {
      const isBarren = village.productionState === 'barren';
      const seatColor = village.owner !== null ? SEAT_COLORS[village.owner] : null;
      const stroke = isSelected ? 'var(--accent)' : seatColor ?? 'var(--border-hover)';
      slot.polygon.setAttribute('fill', villageFillColor(village.owner, isBarren));
      slot.polygon.setAttribute('stroke', stroke);
      slot.polygon.setAttribute('stroke-width', isSelected ? '3' : seatColor ? '2' : '1.5');
      if (isBarren) {
        slot.polygon.setAttribute('stroke-dasharray', '3 3');
      }
      if (!isBarren) {
        slot.polygon.removeAttribute('stroke-dasharray');
      }

      if (village.owner !== null) {
        slot.ownerBadge.setAttribute('visibility', 'hidden');
        slot.ownerLabel.textContent = '';
      }
      if (village.owner === null) {
        slot.ownerBadge.setAttribute('visibility', 'visible');
        slot.ownerBadge.setAttribute('fill', 'var(--bg-surface)');
        slot.ownerBadge.setAttribute('stroke', 'var(--border-hover)');
        slot.ownerBadge.setAttribute('stroke-width', '1');
        slot.ownerLabel.textContent = 'BARB';
        slot.ownerLabel.setAttribute('fill', 'var(--text-dim)');
      }

      if (isBarren) {
        slot.unitGroup.replaceChildren();
        slot.detailLabel.textContent = 'BARREN';
        slot.detailLabel.setAttribute('fill', 'var(--text-muted)');
      }
      if (!isBarren) {
        const hasUnits = renderHexUnitTokens(
          slot.unitGroup,
          slot.centerX,
          slot.centerY,
          village.troops,
          seatColor ?? 'var(--text-dim)',
        );
        slot.detailLabel.textContent = hasUnits ? '' : '0';
        slot.detailLabel.setAttribute('fill', 'var(--text-muted)');
      }

      const clampedLoyalty = Math.max(0, Math.min(100, village.loyalty));
      slot.loyaltyTrack.setAttribute('visibility', 'visible');
      slot.loyaltyFill.setAttribute('visibility', 'visible');
      slot.loyaltyFill.setAttribute('width', String(Math.round((clampedLoyalty / 100) * LOYALTY_BAR_WIDTH)));
      slot.loyaltyFill.setAttribute('fill', loyaltyFillColor(clampedLoyalty, village.owner));

      const matchesSpotlight = !isSpotlightActive || isSelected || village.owner === spotlightSeatId;
      slot.group.setAttribute('opacity', matchesSpotlight ? '1' : '0.28');
      return;
    }

    slot.polygon.setAttribute('fill', isFogged ? 'var(--bg)' : 'var(--bg-surface)');
    slot.polygon.setAttribute('stroke', isSelected ? 'var(--accent)' : 'var(--border)');
    slot.polygon.setAttribute('stroke-width', isSelected ? '2.5' : '1');
    slot.polygon.removeAttribute('stroke-dasharray');

    slot.ownerBadge.setAttribute('visibility', 'hidden');
    slot.ownerLabel.textContent = isFogged ? '?' : '';
    slot.ownerLabel.setAttribute('fill', 'var(--text-muted)');
    slot.detailLabel.textContent = '';
    slot.unitGroup.replaceChildren();
    slot.loyaltyTrack.setAttribute('visibility', 'hidden');
    slot.loyaltyFill.setAttribute('visibility', 'hidden');

    const matchesEmptySpotlight = !isSpotlightActive || isSelected;
    slot.group.setAttribute('opacity', matchesEmptySpotlight ? '1' : '0.28');
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

  function visibleVillagesArray(state: MatchState, pov: WargamesPov): (VillageState | null)[] {
    if (pov === 'god') return state.villages.map(cloneVillage);
    const seatView = projectSeatState(state, pov);
    const byHex = new Map(seatView.visibleVillages.map((village) => [village.hexIndex, village]));
    return ALL_HEXES.map((_, index) => cloneVillage(byHex.get(index) ?? null));
  }

  function visibleActiveArmies(state: MatchState, pov: WargamesPov) {
    if (pov === 'god') {
      return [...state.armies.values()].filter((army) => army.status === 'marching' || army.status === 'returning');
    }
    return projectSeatState(state, pov).visibleArmies;
  }

  function renderActiveArmies(state: MatchState, pov: WargamesPov, spotlightSeatId: SeatId | null): void {
    armyLayer.replaceChildren();
    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    for (const army of visibleActiveArmies(state, pov)) {
      const fromSlot = slots[army.currentHexIndex];
      const targetIndex = army.status === 'returning' ? army.originHexIndex : army.targetHexIndex;
      const toSlot = slots[targetIndex];
      if (!fromSlot || !toSlot) continue;
      const baseOpacity = army.status === 'returning' ? '0.88' : '1';
      const armyOpacity = !isSpotlightActive || army.owner === spotlightSeatId ? baseOpacity : '0.2';
      renderMarchVector(armyLayer, fromSlot, toSlot, army.owner, army.troops, {
        strokeDasharray: army.status === 'returning' ? '3 3' : '6 3',
        strokeWidth: '2.4',
        opacity: armyOpacity,
        groupClass: 'wg-army-arrow',
        lineClass: 'wg-army-line',
        isReturning: army.status === 'returning',
      });
    }
  }

  const animQueue = createBoardAnimationQueue({
    shouldSkip: () => !prefersMotion(),
    onDrain: () => {
      advanceOverlay('recap_drained');
      if (latestState) {
        displayedVillages = visibleVillagesArray(latestState, latestPov);
        paintAllDisplayedSlots(latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
        renderActiveArmies(latestState, latestPov, latestSpotlightSeatId);
      }
      renderOrderPreviews();
    },
  });

  const slots: HexNodeSlot[] = ALL_HEXES.map((tile) => {
    const { x, y } = hexCenter(tile.q, tile.r);
    const group = createSvgShape('g', { class: 'wg-hex-cell' });
    const polygon = createSvgShape('polygon', {
      points: hexPolygonPoints(x, y),
      fill: 'var(--bg-surface)',
      stroke: 'var(--border)',
      'stroke-width': '1.2',
    });
    const indexLabel = createSvgShape('text', {
      x: x.toFixed(1),
      y: (y - 16).toFixed(1),
      'text-anchor': 'middle',
      'font-size': '8.5',
      class: 'wg-hex-index',
    });
    indexLabel.textContent = `#${tile.index}`;

    const ownerBadge = createSvgShape('rect', {
      x: (x - 16).toFixed(1),
      y: (y - 11).toFixed(1),
      width: '32',
      height: '15',
      rx: '2',
      visibility: 'hidden',
    });
    const ownerLabel = createSvgShape('text', {
      x: x.toFixed(1),
      y: (y + 0.5).toFixed(1),
      'text-anchor': 'middle',
      'font-size': '10.5',
      class: 'wg-hex-owner',
    });
    const detailLabel = createSvgShape('text', {
      x: x.toFixed(1),
      y: (y + 15).toFixed(1),
      'text-anchor': 'middle',
      'font-size': '9.5',
      class: 'wg-hex-detail',
    });
    const unitGroup = createSvgShape('g', { class: 'wg-hex-units' });
    const loyaltyTrack = createSvgShape('rect', {
      x: (x - LOYALTY_BAR_WIDTH / 2).toFixed(1),
      y: (y + 20).toFixed(1),
      width: String(LOYALTY_BAR_WIDTH),
      height: String(LOYALTY_BAR_HEIGHT),
      fill: 'var(--bg)',
      visibility: 'hidden',
    });
    const loyaltyFill = createSvgShape('rect', {
      x: (x - LOYALTY_BAR_WIDTH / 2).toFixed(1),
      y: (y + 20).toFixed(1),
      width: '0',
      height: String(LOYALTY_BAR_HEIGHT),
      fill: 'var(--text-dim)',
      class: 'wg-loyalty-fill',
      visibility: 'hidden',
    });

    group.append(polygon, indexLabel, ownerBadge, ownerLabel, detailLabel, unitGroup, loyaltyTrack, loyaltyFill);
    group.addEventListener('click', () => onSelectHex(tile.index));
    hexLayer.append(group);
    return {
      group,
      polygon,
      indexLabel,
      ownerBadge,
      ownerLabel,
      detailLabel,
      unitGroup,
      loyaltyTrack,
      loyaltyFill,
      centerX: x,
      centerY: y,
    };
  });

  function renderOrderPreviews(): void {
    previewLayer.replaceChildren();
    if (!latestState || overlayMode === 'recap' || animQueue.getState() !== 'idle') return;
    const isSpotlightActive = latestPov === 'god' && latestSpotlightSeatId !== null;
    const previewVectors: {
      seatId: SeatId;
      fromHexIndex: number;
      toHexIndex: number;
      troops: TroopCounts;
      kind: 'march' | 'scout';
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
          previewVectors.push({
            seatId,
            fromHexIndex: order.fromHexIndex,
            toHexIndex: order.toHexIndex,
            troops: order.troops,
            kind: 'march',
          });
          continue;
        }
        if (order.kind === 'scout') {
          previewVectors.push({
            seatId,
            fromHexIndex: order.fromHexIndex,
            toHexIndex: order.toHexIndex,
            troops: { raider: 0, guard: 0, envoy: 0 },
            kind: 'scout',
          });
          continue;
        }
        if (order.kind === 'build') {
          pushHexBadge(order.hexIndex, seatId, { path: glyphPathForBuilding(order.building), count: null });
          continue;
        }
        if (order.kind === 'train') {
          pushHexBadge(order.hexIndex, seatId, { path: glyphPathForUnit(order.troop), count: order.count });
        }
      }
    }

    const countsByPair = new Map<string, number>();
    const seenByPair = new Map<string, number>();
    for (const entry of previewVectors) {
      const pairKey = `${Math.min(entry.fromHexIndex, entry.toHexIndex)}-${Math.max(entry.fromHexIndex, entry.toHexIndex)}`;
      countsByPair.set(pairKey, (countsByPair.get(pairKey) ?? 0) + 1);
    }

    let renderedCount = 0;
    for (const entry of previewVectors) {
      const fromSlot = slots[entry.fromHexIndex];
      const toSlot = slots[entry.toHexIndex];
      if (!fromSlot || !toSlot) continue;
      const pairKey = `${Math.min(entry.fromHexIndex, entry.toHexIndex)}-${Math.max(entry.fromHexIndex, entry.toHexIndex)}`;
      const totalForPair = countsByPair.get(pairKey) ?? 1;
      const indexForPair = seenByPair.get(pairKey) ?? 0;
      seenByPair.set(pairKey, indexForPair + 1);
      const directionSign = entry.fromHexIndex < entry.toHexIndex ? 1 : -1;
      const lateralOffset = totalForPair > 1 ? (indexForPair - (totalForPair - 1) / 2) * 6 * directionSign : 0;
      const opacity = !isSpotlightActive || entry.seatId === latestSpotlightSeatId ? '0.8' : '0.18';
      renderMarchVector(previewLayer, fromSlot, toSlot, entry.seatId, entry.troops, {
        strokeDasharray: entry.kind === 'scout' ? '1 3' : '2 4',
        strokeWidth: entry.kind === 'scout' ? '1.4' : '1.8',
        opacity,
        groupClass: 'wg-preview-arrow',
        lineClass: 'wg-preview-line',
        showPill: false,
        lateralOffset,
      });
      renderedCount += 1;
    }

    for (const [hexIndex, entry] of hexBadges) {
      const slot = slots[hexIndex];
      if (!slot) continue;
      const opacity = !isSpotlightActive || entry.seatId === latestSpotlightSeatId ? '0.9' : '0.2';
      renderPreviewBadge(previewLayer, slot.centerX, slot.centerY, entry.tokens, SEAT_COLORS[entry.seatId], opacity);
      renderedCount += 1;
    }

    advanceOverlay(renderedCount > 0 ? 'show_previews' : 'hide_previews');
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
      clearTransientFx();
      armyLayer.replaceChildren();
      fxLayer.replaceChildren();
      previewLayer.replaceChildren();
      advanceOverlay('reset');
      lastRenderedMatchId = null;
      lastRenderedPov = null;
      lastResolvedTick = null;
      lastMessageCount = 0;
      lastActiveContractIds = new Set();
      lastLedgerCount = 0;
      lastNoteBySeat = new Map();
      lastVillageSnapshots = ALL_HEXES.map(() => null);
      displayedVillages = ALL_HEXES.map(() => null);
      lastArmySnapshots = new Map();
      for (const slot of slots) {
        slot.group.setAttribute('opacity', '1');
        slot.polygon.setAttribute('fill', 'var(--bg-surface)');
        slot.polygon.setAttribute('stroke', 'var(--border)');
        slot.polygon.setAttribute('stroke-width', '1.2');
        slot.polygon.removeAttribute('stroke-dasharray');
        slot.ownerBadge.setAttribute('visibility', 'hidden');
        slot.ownerLabel.textContent = '';
        slot.detailLabel.textContent = '';
        slot.unitGroup.replaceChildren();
        slot.loyaltyTrack.setAttribute('visibility', 'hidden');
        slot.loyaltyFill.setAttribute('visibility', 'hidden');
      }
      return;
    }

    const resolvedTick = latestResolvedTickOf(state.ordersByTick);
    const isSameView = lastRenderedMatchId === state.matchId && lastRenderedPov === pov;
    const isConsecutiveResolution = isSameView && lastResolvedTick !== null && resolvedTick === lastResolvedTick + 1;
    const isResolutionJump = isSameView && lastResolvedTick !== null && resolvedTick !== lastResolvedTick && !isConsecutiveResolution;
    const allowsMotion = prefersMotion();

    if (isSameView && resolvedTick === lastResolvedTick && overlayMode === 'recap') {
      paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
      return;
    }

    const targetVillages = visibleVillagesArray(state, pov);
    const armies = visibleActiveArmies(state, pov);
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
        clearTransientFx();
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
    armyLayer.replaceChildren();
    previewLayer.replaceChildren();

    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    const glidesByDestHex = new Map<number, { fromSlot: HexNodeSlot; toSlot: HexNodeSlot; army: ArmySnapshot }[]>();
    const seenArmyIds = new Set<string>();
    const pushGlide = (destIndex: number, fromSlot: HexNodeSlot, toSlot: HexNodeSlot, army: ArmySnapshot) => {
      const existing = glidesByDestHex.get(destIndex);
      if (existing) {
        existing.push({ fromSlot, toSlot, army });
        return;
      }
      glidesByDestHex.set(destIndex, [{ fromSlot, toSlot, army }]);
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
      pushGlide(destIndex, fromSlot, toSlot, prevArmy);
    }

    for (const army of armies) {
      if (seenArmyIds.has(army.id)) continue;
      seenArmyIds.add(army.id);
      if (army.currentHexIndex === army.originHexIndex) continue;
      const fromSlot = slots[army.originHexIndex];
      const toSlot = slots[army.currentHexIndex];
      if (!fromSlot || !toSlot) continue;
      if (isSpotlightActive && army.owner !== spotlightSeatId) continue;
      pushGlide(army.currentHexIndex, fromSlot, toSlot, {
        hexIndex: army.originHexIndex,
        targetHexIndex: army.targetHexIndex,
        originHexIndex: army.originHexIndex,
        owner: army.owner,
        troops: { ...army.troops },
        status: army.status,
      });
    }

    const tickOrders = state.ordersByTick[resolvedTick];
    for (const army of state.armies.values()) {
      if (seenArmyIds.has(army.id) || army.departedTick !== resolvedTick) continue;
      if (pov !== 'god' && army.owner !== pov && !army.scoutedBy.includes(pov)) continue;
      if (army.targetHexIndex === army.originHexIndex) continue;
      const fromSlot = slots[army.originHexIndex];
      const toSlot = slots[army.targetHexIndex];
      if (!fromSlot || !toSlot) continue;
      if (isSpotlightActive && army.owner !== spotlightSeatId) continue;
      const displayTroops = troopCountOf(army.troops) > 0
        ? { ...army.troops }
        : findOrderTroopsForArmy(tickOrders, army.owner, army.originHexIndex, army.targetHexIndex);
      pushGlide(army.targetHexIndex, fromSlot, toSlot, {
        hexIndex: army.originHexIndex,
        targetHexIndex: army.targetHexIndex,
        originHexIndex: army.originHexIndex,
        owner: army.owner,
        troops: displayTroops,
        status: army.status,
      });
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
    emitLiveDiplomacyFx(state, pov);

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
      return [{
        hexIndex,
        slot,
        glides,
        delta,
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
        durationMs: isQuietIndividualBeat ? 1100 : 1400,
        start: (durationMs) => {
          const mounted: SVGElement[] = [];
          const deferredUpdates: (() => void)[] = [];
          if (isQuietIndividualBeat) {
            mounted.push(appendFocusRing(fxLayer, batch[0].slot.centerX, batch[0].slot.centerY));
          }
          for (const item of batch) {
            for (let glideIndex = 0; glideIndex < item.glides.length; glideIndex += 1) {
              const glide = item.glides[glideIndex];
              const node = appendGlidingArmy(
                fxLayer,
                glide.fromSlot,
                glide.toSlot,
                glide.army,
                durationMs,
                glideIndex,
                item.glides.length,
              );
              if (node) mounted.push(node);
            }
            if (item.delta) {
              const applyVillageUpdate = () => {
                displayedVillages[item.hexIndex] = cloneVillage(item.delta?.targetVillage ?? null);
                if (latestState) {
                  paintHexSlot(item.hexIndex, displayedVillages[item.hexIndex], latestState, latestPov, latestSelectedHexIndex, latestSpotlightSeatId);
                }
              };
              if (item.hasIncomingGlide) {
                deferredUpdates.push(applyVillageUpdate);
              }
              if (!item.hasIncomingGlide) {
                applyVillageUpdate();
              }
              if (item.delta.troopDelta !== 0) {
                const deltaLabel = item.delta.troopDelta > 0 ? `+${item.delta.troopDelta}` : String(item.delta.troopDelta);
                const deltaFill = item.delta.troopDelta > 0 ? 'var(--state-running)' : 'var(--text-dim)';
                mounted.push(appendDeltaCallout(fxLayer, item.slot.centerX, item.slot.centerY - 4, deltaLabel, deltaFill, durationMs));
              }
              if (item.delta.buildingUpgrades.length > 0) {
                const upgrade = item.delta.buildingUpgrades[0];
                const upgradeY = item.delta.troopDelta !== 0 ? item.slot.centerY + 11 : item.slot.centerY - 4;
                mounted.push(appendGlyphCallout(fxLayer, item.slot.centerX, upgradeY, upgrade.path, upgrade.level, 'var(--accent)', durationMs));
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
            for (let glideIndex = 0; glideIndex < glides.length; glideIndex += 1) {
              const glide = glides[glideIndex];
              const node = appendGlidingArmy(
                fxLayer,
                glide.fromSlot,
                glide.toSlot,
                glide.army,
                durationMs,
                glideIndex,
                glides.length,
              );
              if (node) mounted.push(node);
            }
            return () => {
              for (const node of mounted) node.remove();
            };
          },
        });
      }

      if (delta || item.hasHostileGlide) {
        beats.push({
          id: `impact-${resolvedTick}-${hexIndex}`,
          durationMs: 1500,
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
            for (let glideIndex = 0; glideIndex < glides.length; glideIndex += 1) {
              const glide = glides[glideIndex];
              const lungeNode = appendGlidingArmy(
                fxLayer,
                glide.fromSlot,
                glide.toSlot,
                glide.army,
                durationMs,
                glideIndex,
                glides.length,
                'lunge',
              );
              if (lungeNode) mounted.push(lungeNode);
            }
            const clashOwner = delta?.targetVillage.owner ?? null;
            const clashColor = clashOwner !== null ? SEAT_COLORS[clashOwner] : 'var(--state-failed)';
            mounted.push(appendCombatClash(fxLayer, slot.centerX, slot.centerY, clashColor, Math.round(durationMs * 0.8)));
            if (delta && delta.troopDelta !== 0) {
              const deltaLabel = delta.troopDelta > 0 ? `+${delta.troopDelta}` : String(delta.troopDelta);
              const deltaFill = delta.troopDelta > 0 ? 'var(--state-running)' : 'var(--state-failed)';
              mounted.push(appendDeltaCallout(fxLayer, slot.centerX, slot.centerY - 4, deltaLabel, deltaFill, durationMs));
            }
            if (delta && delta.loyaltyDelta < 0) {
              const loyaltyY = delta.troopDelta !== 0 ? slot.centerY + 11 : slot.centerY - 4;
              mounted.push(appendDeltaCallout(fxLayer, slot.centerX, loyaltyY, `${delta.loyaltyDelta}%`, 'var(--state-waiting)', durationMs));
            }
            return () => {
              for (const node of mounted) node.remove();
            };
          },
        });

        if (delta && delta.ownerChanged && delta.targetVillage.owner !== null) {
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
      animQueue.enqueueBatch(beats);
      return;
    }

    displayedVillages = targetVillages.map(cloneVillage);
    paintAllDisplayedSlots(state, pov, selectedHexIndex, spotlightSeatId);
    renderActiveArmies(state, pov, spotlightSeatId);
    renderOrderPreviews();
  }

  function dispose(): void {
    animQueue.dispose();
    clearTransientFx();
    fxLayer.replaceChildren();
    previewLayer.replaceChildren();
    advanceOverlay('reset');
  }

  return { element: svg, update, dispose };
}
