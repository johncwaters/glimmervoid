import { WARGAMES_SEAT_IDS, WARGAMES_SQUEEZE_TICK } from '#shared/contracts/wargames.ts';
import type { SeatId } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { createSvgShape } from '../svg-dom.ts';
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

function appendDeltaCallout(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  label: string,
  fill: string,
): void {
  const pillWidth = Math.max(24, label.length * 6.5 + 8);
  const group = createSvgShape('g', { class: 'wg-delta-callout' });
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
  group.addEventListener('animationend', () => group.remove());
  fxLayer.append(group);
}

function appendCombatClash(
  fxLayer: SVGElement,
  centerX: number,
  centerY: number,
  strokeColor: string,
): void {
  const clash = createSvgShape('g', { class: 'wg-combat-clash' });
  clash.style.transformOrigin = `${centerX.toFixed(1)}px ${centerY.toFixed(1)}px`;
  clash.append(
    createSvgShape('path', {
      d: `M ${(centerX - 9).toFixed(1)} ${(centerY - 9).toFixed(1)} L ${(centerX + 9).toFixed(1)} ${(centerY + 9).toFixed(1)} M ${(centerX + 9).toFixed(1)} ${(centerY - 9).toFixed(1)} L ${(centerX - 9).toFixed(1)} ${(centerY + 9).toFixed(1)}`,
      stroke: strokeColor,
      'stroke-width': '2.6',
      'stroke-linecap': 'square',
      fill: 'none',
    }),
  );
  clash.addEventListener('animationend', () => clash.remove());
  fxLayer.append(clash);
}

function appendGlidingArmy(
  fxLayer: SVGElement,
  fromSlot: HexNodeSlot,
  toSlot: HexNodeSlot,
  army: ArmySnapshot,
): void {
  const deltaX = fromSlot.centerX - toSlot.centerX;
  const deltaY = fromSlot.centerY - toSlot.centerY;
  if (Math.hypot(deltaX, deltaY) < 1) return;
  const glideGroup = createSvgShape('g', { class: 'wg-army-glide' });
  glideGroup.style.setProperty('--wg-dx', `${deltaX.toFixed(1)}px`);
  glideGroup.style.setProperty('--wg-dy', `${deltaY.toFixed(1)}px`);
  renderArmyPill(glideGroup, toSlot.centerX, toSlot.centerY, army.owner, army.troops, SEAT_COLORS[army.owner]);
  glideGroup.addEventListener('animationend', () => glideGroup.remove());
  fxLayer.append(glideGroup);
}

interface WargamesMapView {
  readonly element: SVGSVGElement;
  update(
    state: MatchState | null,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void;
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
  const armyLayer = createSvgShape('g', { class: 'wg-army-layer' });
  const fxLayer = createSvgShape('g', { class: 'wg-fx-layer' });
  svg.append(defs, hexLayer, armyLayer, fxLayer);
  let lastRenderedMatchId: string | null = null;
  let lastRenderedPov: WargamesPov | null = null;
  let lastHexSnapshots: (HexSnapshot | null)[] = ALL_HEXES.map(() => null);
  let lastArmySnapshots = new Map<string, ArmySnapshot>();

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

  function update(
    state: MatchState | null,
    pov: WargamesPov,
    selectedHexIndex: number | null,
    spotlightSeatId: SeatId | null,
  ): void {
    armyLayer.replaceChildren();
    if (!state) {
      fxLayer.replaceChildren();
      lastRenderedMatchId = null;
      lastRenderedPov = null;
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
    const allowsMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
    if (!isSameView) {
      fxLayer.replaceChildren();
      lastRenderedMatchId = state.matchId;
      lastRenderedPov = pov;
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

    if (isSameView && allowsMotion) {
      const currentArmyById = new Map(armies.map((army) => [army.id, army]));
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
        appendGlidingArmy(fxLayer, fromSlot, toSlot, prevArmy);
      }
      for (const army of armies) {
        if (lastArmySnapshots.has(army.id)) continue;
        if (army.currentHexIndex === army.originHexIndex) continue;
        const fromSlot = slots[army.originHexIndex];
        const toSlot = slots[army.currentHexIndex];
        if (!fromSlot || !toSlot) continue;
        if (isSpotlightActive && army.owner !== spotlightSeatId) continue;
        appendGlidingArmy(fxLayer, fromSlot, toSlot, {
          hexIndex: army.originHexIndex,
          targetHexIndex: army.targetHexIndex,
          originHexIndex: army.originHexIndex,
          owner: army.owner,
          troops: { ...army.troops },
          status: army.status,
        });
      }
    }

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
      if (isSameView && allowsMotion && currentSnapshot && prevSnapshot) {
        const troopDelta = currentSnapshot.totalTroops - prevSnapshot.totalTroops;
        const ownerChanged = currentSnapshot.owner !== null && prevSnapshot.owner !== currentSnapshot.owner;
        if (troopDelta < 0 || ownerChanged) {
          const clashColor = currentSnapshot.owner !== null ? SEAT_COLORS[currentSnapshot.owner] : 'var(--state-failed)';
          appendCombatClash(fxLayer, slot.centerX, slot.centerY, clashColor);
        }
        if (troopDelta !== 0) {
          const deltaLabel = troopDelta > 0 ? `+${troopDelta}` : String(troopDelta);
          const deltaFill = troopDelta > 0 ? 'var(--state-running)' : 'var(--state-failed)';
          appendDeltaCallout(fxLayer, slot.centerX, slot.centerY - 4, deltaLabel, deltaFill);
        }
        const loyaltyDelta = currentSnapshot.loyalty - prevSnapshot.loyalty;
        if (loyaltyDelta < 0) {
          const loyaltyY = troopDelta !== 0 ? slot.centerY + 11 : slot.centerY - 4;
          appendDeltaCallout(fxLayer, slot.centerX, loyaltyY, `${loyaltyDelta}%`, 'var(--state-waiting)');
        }
        if (ownerChanged && currentSnapshot.owner !== null) {
          const ring = createSvgShape('polygon', {
            points: hexPolygonPoints(slot.centerX, slot.centerY),
            fill: 'none',
            stroke: SEAT_COLORS[currentSnapshot.owner],
            'stroke-width': '2.5',
            class: 'wg-capture-ring',
          });
          ring.style.transformOrigin = `${slot.centerX.toFixed(1)}px ${slot.centerY.toFixed(1)}px`;
          ring.addEventListener('animationend', () => ring.remove());
          fxLayer.append(ring);
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

      const deltaX = toSlot.centerX - fromSlot.centerX;
      const deltaY = toSlot.centerY - fromSlot.centerY;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance < 1) continue;

      const unitX = deltaX / distance;
      const unitY = deltaY / distance;
      const trim = Math.min(16, distance * 0.25);
      const startX = fromSlot.centerX + unitX * trim;
      const startY = fromSlot.centerY + unitY * trim;
      const endX = toSlot.centerX - unitX * trim;
      const endY = toSlot.centerY - unitY * trim;
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;

      const color = SEAT_COLORS[army.owner];
      const armyOpacity = !isSpotlightActive || army.owner === spotlightSeatId ? '1' : '0.2';

      const armyGroup = createSvgShape('g', { class: 'wg-army-arrow', opacity: armyOpacity });
      armyGroup.append(
        createSvgShape('line', {
          x1: startX.toFixed(1),
          y1: startY.toFixed(1),
          x2: endX.toFixed(1),
          y2: endY.toFixed(1),
          stroke: color,
          'stroke-width': '2.4',
          'stroke-dasharray': army.status === 'returning' ? '3 3' : '6 3',
          'marker-end': `url(#wg-arrow-${army.owner})`,
          class: 'wg-army-line',
        }),
      );
      renderArmyPill(armyGroup, midX, midY, army.owner, army.troops, color);
      armyLayer.append(armyGroup);
    }
  }

  return { element: svg, update };
}
