import { WARGAMES_SEAT_IDS, WARGAMES_SQUEEZE_TICK } from '#shared/contracts/wargames.ts';
import type { SeatId } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { createSvgShape } from '../svg-dom.ts';
import {
  createBoardAnimationQueue,
  transitionBoardOverlay,
} from './wargames-anim-queue.ts';
import type { BoardAnimationBeat, BoardOverlayMode } from './wargames-anim-queue.ts';
import type { WargamesPov } from './wargames-store.ts';

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

function renderArmyPill(
  armyGroup: SVGElement,
  midX: number,
  midY: number,
  owner: SeatId,
  troops: { raider: number; guard: number; envoy: number },
  color: string,
): void {
  const active = UNIT_GLYPH_PATHS
    .filter((unit) => troops[unit.key] > 0)
    .map((unit) => {
      const digits = String(troops[unit.key]);
      return { unit, digits, width: 6.4 + digits.length * 5.1 };
    });
  const ownerTag = owner.toUpperCase();
  const ownerWidth = ownerTag.length * 5.2;
  const gap = 4;
  const tokensWidth = active.reduce((sum, item) => sum + item.width, 0) + Math.max(0, active.length - 1) * gap;
  const contentWidth = active.length > 0 ? ownerWidth + gap + tokensWidth : ownerWidth;
  const pillWidth = Math.max(30, contentWidth + 10);
  const pillHeight = 16;

  armyGroup.append(createSvgShape('rect', {
    x: (midX - pillWidth / 2).toFixed(1),
    y: (midY - pillHeight / 2).toFixed(1),
    width: pillWidth.toFixed(1),
    height: String(pillHeight),
    rx: '2',
    fill: 'var(--bg)',
    stroke: color,
    'stroke-width': '1.2',
  }));

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

interface HexSnapshot {
  owner: SeatId | null;
  totalTroops: number;
  loyalty: number;
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

interface HexDeltaSummary {
  troopDelta: number;
  loyaltyDelta: number;
  ownerChanged: boolean;
  currentOwner: SeatId | null;
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
): SVGElement | null {
  const deltaX = fromSlot.centerX - toSlot.centerX;
  const deltaY = fromSlot.centerY - toSlot.centerY;
  if (Math.hypot(deltaX, deltaY) < 1) return null;
  const glideGroup = createSvgShape('g', { class: 'wg-army-glide' });
  glideGroup.style.setProperty('--wg-dx', `${deltaX.toFixed(1)}px`);
  glideGroup.style.setProperty('--wg-dy', `${deltaY.toFixed(1)}px`);
  glideGroup.style.animationDuration = `${durationMs}ms`;
  renderArmyPill(glideGroup, toSlot.centerX, toSlot.centerY, army.owner, army.troops, SEAT_COLORS[army.owner]);
  fxLayer.append(glideGroup);
  return glideGroup;
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
  },
): void {
  const deltaX = toSlot.centerX - fromSlot.centerX;
  const deltaY = toSlot.centerY - fromSlot.centerY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 1) return;

  const unitX = deltaX / distance;
  const unitY = deltaY / distance;
  const trim = Math.min(16, distance * 0.25);
  const startX = fromSlot.centerX + unitX * trim;
  const startY = fromSlot.centerY + unitY * trim;
  const endX = toSlot.centerX - unitX * trim;
  const endY = toSlot.centerY - unitY * trim;
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
  renderArmyPill(vectorGroup, midX, midY, owner, troops, color);
  layer.append(vectorGroup);
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
  svg.append(defs, hexLayer, previewLayer, armyLayer, fxLayer);

  let lastRenderedMatchId: string | null = null;
  let lastRenderedPov: WargamesPov | null = null;
  let lastRenderedTick: number | null = null;
  let overlayMode: BoardOverlayMode = 'idle';
  let latestState: MatchState | null = null;
  let latestPov: WargamesPov = 'god';
  let latestSpotlightSeatId: SeatId | null = null;
  let lastHexSnapshots: (HexSnapshot | null)[] = ALL_HEXES.map(() => null);
  let lastArmySnapshots = new Map<string, ArmySnapshot>();

  function prefersMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  }

  function advanceOverlay(event: Parameters<typeof transitionBoardOverlay>[1]): void {
    const nextMode = transitionBoardOverlay(overlayMode, event);
    if (nextMode !== null) overlayMode = nextMode;
  }

  const animQueue = createBoardAnimationQueue({
    shouldSkip: () => !prefersMotion(),
    onDrain: () => {
      advanceOverlay('recap_drained');
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
    let renderedCount = 0;
    for (const seat of latestState.seats) {
      const seatId = seat.config.seatId;
      if (latestPov !== 'god' && seatId !== latestPov) continue;
      for (const order of seat.sealedOrders) {
        if (order.kind !== 'march') continue;
        const fromSlot = slots[order.fromHexIndex];
        const toSlot = slots[order.toHexIndex];
        if (!fromSlot || !toSlot) continue;
        const opacity = !isSpotlightActive || seatId === latestSpotlightSeatId ? '0.78' : '0.18';
        renderMarchVector(previewLayer, fromSlot, toSlot, seatId, order.troops, {
          strokeDasharray: '2 4',
          strokeWidth: '1.8',
          opacity,
          groupClass: 'wg-preview-arrow',
          lineClass: 'wg-preview-line',
        });
        renderedCount += 1;
      }
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
    latestSpotlightSeatId = spotlightSeatId;
    armyLayer.replaceChildren();
    if (!state) {
      animQueue.clear();
      fxLayer.replaceChildren();
      previewLayer.replaceChildren();
      advanceOverlay('reset');
      lastRenderedMatchId = null;
      lastRenderedPov = null;
      lastRenderedTick = null;
      lastHexSnapshots = ALL_HEXES.map(() => null);
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

    const seatView = pov === 'god' ? null : projectSeatState(state, pov);
    const visibleVillageByHex = new Map(
      (seatView ? seatView.visibleVillages : state.villages.filter((village) => village !== null))
        .map((village) => [village.hexIndex, village]),
    );
    const armies = seatView
      ? seatView.visibleArmies
      : [...state.armies.values()].filter((army) => army.status === 'marching' || army.status === 'returning');
    const isSpotlightActive = pov === 'god' && spotlightSeatId !== null;
    const isOuterSqueezeActive = state.tick >= WARGAMES_SQUEEZE_TICK;
    const isSameView = lastRenderedMatchId === state.matchId && lastRenderedPov === pov;
    const isConsecutiveTick = isSameView && lastRenderedTick !== null && state.tick === lastRenderedTick + 1;
    const isTickJump = isSameView && lastRenderedTick !== null && state.tick !== lastRenderedTick && !isConsecutiveTick;
    const allowsMotion = prefersMotion();

    if (!isSameView || !allowsMotion || isTickJump) {
      animQueue.clear();
      fxLayer.replaceChildren();
      advanceOverlay('reset');
    }

    if (!isSameView) {
      lastRenderedMatchId = state.matchId;
      lastRenderedPov = pov;
      lastRenderedTick = state.tick;
      lastHexSnapshots = ALL_HEXES.map((_, idx) => {
        const currentVillage = visibleVillageByHex.get(idx);
        if (!currentVillage) return null;
        return {
          owner: currentVillage.owner,
          totalTroops: troopCountOf(currentVillage.troops),
          loyalty: currentVillage.loyalty,
        };
      });
      lastArmySnapshots = new Map(armies.map((army) => [army.id, {
        hexIndex: army.currentHexIndex,
        targetHexIndex: army.targetHexIndex,
        originHexIndex: army.originHexIndex,
        owner: army.owner,
        troops: { ...army.troops },
        status: army.status,
      }]));
    }

    const glidesByDestHex = new Map<number, { fromSlot: HexNodeSlot; toSlot: HexNodeSlot; army: ArmySnapshot }[]>();
    if (isConsecutiveTick && allowsMotion) {
      const currentArmyById = new Map(armies.map((army) => [army.id, army]));
      const pushGlide = (destIndex: number, fromSlot: HexNodeSlot, toSlot: HexNodeSlot, army: ArmySnapshot) => {
        const existing = glidesByDestHex.get(destIndex);
        if (existing) {
          existing.push({ fromSlot, toSlot, army });
          return;
        }
        glidesByDestHex.set(destIndex, [{ fromSlot, toSlot, army }]);
      };
      for (const [armyId, prevArmy] of lastArmySnapshots) {
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
        if (lastArmySnapshots.has(army.id)) continue;
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
    }

    const deltasByHex = new Map<number, HexDeltaSummary>();
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const tile = ALL_HEXES[index];
      const village = visibleVillageByHex.get(index) ?? null;
      const isSelected = selectedHexIndex === index;
      const isFogged = seatView !== null && state.villages[index] !== null && village === null;
      const isOuterRing = tile.ring === 3;
      const prevSnapshot = lastHexSnapshots[index];
      const currentSnapshot: HexSnapshot | null = village
        ? { owner: village.owner, totalTroops: troopCountOf(village.troops), loyalty: village.loyalty }
        : null;
      if (isConsecutiveTick && allowsMotion && currentSnapshot && prevSnapshot) {
        const troopDelta = currentSnapshot.totalTroops - prevSnapshot.totalTroops;
        const loyaltyDelta = currentSnapshot.loyalty - prevSnapshot.loyalty;
        const ownerChanged = currentSnapshot.owner !== null && prevSnapshot.owner !== currentSnapshot.owner;
        if (troopDelta !== 0 || loyaltyDelta < 0 || ownerChanged) {
          deltasByHex.set(index, {
            troopDelta,
            loyaltyDelta,
            ownerChanged,
            currentOwner: currentSnapshot.owner,
          });
        }
      }
      lastHexSnapshots[index] = currentSnapshot;

      if (village) {
        const isBarren = village.productionState === 'barren';
        const seatColor = village.owner !== null ? SEAT_COLORS[village.owner] : null;
        const stroke = isSelected ? 'var(--accent)' : seatColor ?? 'var(--border-hover)';
        slot.polygon.setAttribute('fill', villageFillColor(village.owner, isBarren));
        slot.polygon.setAttribute('stroke', stroke);
        slot.polygon.setAttribute('stroke-width', isSelected ? '3' : seatColor ? '2' : '1.5');
        if (isOuterRing && (isBarren || !isOuterSqueezeActive)) {
          slot.polygon.setAttribute('stroke-dasharray', isBarren ? '3 3' : '6 2');
        }
        if (!isOuterRing || (!isBarren && isOuterSqueezeActive)) {
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
        continue;
      }

      slot.polygon.setAttribute('fill', isFogged || isOuterRing ? 'var(--bg)' : 'var(--bg-surface)');
      slot.polygon.setAttribute('stroke', isSelected ? 'var(--accent)' : isOuterRing ? 'var(--border-dim)' : 'var(--border)');
      slot.polygon.setAttribute('stroke-width', isSelected ? '2.5' : '1');
      if (isOuterRing) slot.polygon.setAttribute('stroke-dasharray', '4 3');
      if (!isOuterRing) slot.polygon.removeAttribute('stroke-dasharray');

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

    lastRenderedTick = state.tick;
    lastArmySnapshots = new Map(armies.map((army) => [army.id, {
      hexIndex: army.currentHexIndex,
      targetHexIndex: army.targetHexIndex,
      originHexIndex: army.originHexIndex,
      owner: army.owner,
      troops: { ...army.troops },
      status: army.status,
    }]));

    for (const army of armies) {
      const fromSlot = slots[army.currentHexIndex];
      const targetIndex = army.status === 'returning' ? army.originHexIndex : army.targetHexIndex;
      const toSlot = slots[targetIndex];
      if (!fromSlot || !toSlot) continue;
      const armyOpacity = !isSpotlightActive || army.owner === spotlightSeatId ? '1' : '0.2';
      renderMarchVector(armyLayer, fromSlot, toSlot, army.owner, army.troops, {
        strokeDasharray: army.status === 'returning' ? '3 3' : '6 3',
        strokeWidth: '2.4',
        opacity: armyOpacity,
        groupClass: 'wg-army-arrow',
        lineClass: 'wg-army-line',
      });
    }

    if (isConsecutiveTick && allowsMotion) {
      const beats: BoardAnimationBeat[] = [];
      const activeHexIndices = [...new Set([...glidesByDestHex.keys(), ...deltasByHex.keys()])]
        .sort((left, right) => left - right);

      for (const hexIndex of activeHexIndices) {
        const slot = slots[hexIndex];
        if (!slot) continue;
        const glides = glidesByDestHex.get(hexIndex) ?? [];
        if (glides.length > 0) {
          beats.push({
            id: `march-${state.tick}-${hexIndex}`,
            durationMs: 520,
            start: (durationMs) => {
              const mounted: SVGElement[] = [];
              for (const glide of glides) {
                const node = appendGlidingArmy(fxLayer, glide.fromSlot, glide.toSlot, glide.army, durationMs);
                if (node) mounted.push(node);
              }
              return () => {
                for (const node of mounted) node.remove();
              };
            },
          });
        }

        const delta = deltasByHex.get(hexIndex);
        if (delta) {
          beats.push({
            id: `impact-${state.tick}-${hexIndex}`,
            durationMs: 820,
            start: (durationMs) => {
              const mounted: SVGElement[] = [];
              if (delta.troopDelta < 0 || delta.ownerChanged) {
                const clashColor = delta.currentOwner !== null ? SEAT_COLORS[delta.currentOwner] : 'var(--state-failed)';
                mounted.push(appendCombatClash(fxLayer, slot.centerX, slot.centerY, clashColor, Math.round(durationMs * 0.8)));
              }
              if (delta.troopDelta !== 0) {
                const deltaLabel = delta.troopDelta > 0 ? `+${delta.troopDelta}` : String(delta.troopDelta);
                const deltaFill = delta.troopDelta > 0 ? 'var(--state-running)' : 'var(--state-failed)';
                mounted.push(appendDeltaCallout(fxLayer, slot.centerX, slot.centerY - 4, deltaLabel, deltaFill, durationMs));
              }
              if (delta.loyaltyDelta < 0) {
                const loyaltyY = delta.troopDelta !== 0 ? slot.centerY + 11 : slot.centerY - 4;
                mounted.push(appendDeltaCallout(fxLayer, slot.centerX, loyaltyY, `${delta.loyaltyDelta}%`, 'var(--state-waiting)', durationMs));
              }
              return () => {
                for (const node of mounted) node.remove();
              };
            },
          });

          if (delta.ownerChanged && delta.currentOwner !== null) {
            const ownerColor = SEAT_COLORS[delta.currentOwner];
            beats.push({
              id: `capture-${state.tick}-${hexIndex}`,
              durationMs: 640,
              start: (durationMs) => {
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
                return () => ring.remove();
              },
            });
          }
        }
      }

      if (beats.length > 0) {
        advanceOverlay('start_recap');
        previewLayer.replaceChildren();
        animQueue.enqueueBatch(beats);
      }
      if (beats.length === 0) {
        animQueue.clear();
        advanceOverlay('reset');
      }
    }

    if (overlayMode !== 'recap' && animQueue.getState() === 'idle') {
      renderOrderPreviews();
    }
  }

  function dispose(): void {
    animQueue.dispose();
    fxLayer.replaceChildren();
    previewLayer.replaceChildren();
    advanceOverlay('reset');
  }

  return { element: svg, update, dispose };
}
