import type { SeatId } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { createSvgShape } from '../svg-dom.ts';
import type { WargamesPov } from './wargames-store.ts';

export const SEAT_COLORS: Readonly<Record<SeatId, string>> = Object.freeze({
  s1: '#38bdf8',
  s2: '#34d399',
  s3: '#f59e0b',
  s4: '#f87171',
  s5: '#a78bfa',
  s6: '#fb7185',
});

const HEX_SIZE = 28;
const SQRT_3 = Math.sqrt(3);

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
    const pointX = centerX + (HEX_SIZE - 2) * Math.cos(angle);
    const pointY = centerY + (HEX_SIZE - 2) * Math.sin(angle);
    points.push(`${pointX.toFixed(1)},${pointY.toFixed(1)}`);
  }
  return points.join(' ');
}

interface HexNodeSlot {
  group: SVGElement;
  polygon: SVGElement;
  ownerLabel: SVGElement;
  detailLabel: SVGElement;
  centerX: number;
  centerY: number;
}

interface WargamesMapView {
  readonly element: SVGSVGElement;
  update(state: MatchState | null, pov: WargamesPov, selectedHexIndex: number | null): void;
}

export function createWargamesMap(onSelectHex: (hexIndex: number) => void): WargamesMapView {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-220 -210 440 420');
  svg.setAttribute('class', 'wg-hex-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Wargames 37-hex tactical map');

  const hexLayer = createSvgShape('g', { class: 'wg-hex-layer' });
  const armyLayer = createSvgShape('g', { class: 'wg-army-layer' });
  svg.append(hexLayer, armyLayer);

  const slots: HexNodeSlot[] = ALL_HEXES.map((tile) => {
    const { x, y } = hexCenter(tile.q, tile.r);
    const group = createSvgShape('g', { class: 'wg-hex-cell' });
    const polygon = createSvgShape('polygon', {
      points: hexPolygonPoints(x, y),
      fill: 'var(--bg-surface)',
      stroke: 'var(--border)',
      'stroke-width': '1.2',
    });
    const ownerLabel = createSvgShape('text', {
      x: x.toFixed(1),
      y: (y - 2).toFixed(1),
      'text-anchor': 'middle',
      class: 'wg-hex-owner',
    });
    const detailLabel = createSvgShape('text', {
      x: x.toFixed(1),
      y: (y + 11).toFixed(1),
      'text-anchor': 'middle',
      class: 'wg-hex-detail',
    });
    group.append(polygon, ownerLabel, detailLabel);
    group.addEventListener('click', () => onSelectHex(tile.index));
    hexLayer.append(group);
    return { group, polygon, ownerLabel, detailLabel, centerX: x, centerY: y };
  });

  function update(state: MatchState | null, pov: WargamesPov, selectedHexIndex: number | null): void {
    armyLayer.replaceChildren();
    if (!state) {
      for (const slot of slots) {
        slot.polygon.setAttribute('fill', 'var(--bg-surface)');
        slot.polygon.setAttribute('stroke', 'var(--border)');
        slot.ownerLabel.textContent = '';
        slot.detailLabel.textContent = '';
      }
      return;
    }

    const seatView = pov === 'god' ? null : projectSeatState(state, pov);
    const visibleVillageByHex = new Map(
      (seatView ? seatView.visibleVillages : state.villages.filter((village) => village !== null))
        .map((village) => [village.hexIndex, village]),
    );

    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      const tile = ALL_HEXES[index];
      const village = visibleVillageByHex.get(index) ?? null;
      const isSelected = selectedHexIndex === index;
      const isFogged = seatView !== null && state.villages[index] !== null && village === null;

      if (village) {
        const stroke = isSelected
          ? 'var(--accent)'
          : village.owner !== null
            ? SEAT_COLORS[village.owner]
            : 'var(--border-hover)';
        slot.polygon.setAttribute('fill', village.productionState === 'barren' ? 'var(--bg)' : 'var(--bg-card)');
        slot.polygon.setAttribute('stroke', stroke);
        slot.polygon.setAttribute('stroke-width', isSelected ? '2.4' : '1.6');
        slot.ownerLabel.textContent = village.owner !== null ? village.owner.toUpperCase() : 'BARB';
        const troopTotal = village.troops.raider + village.troops.guard + village.troops.envoy;
        slot.detailLabel.textContent = village.productionState === 'barren' ? 'BARREN' : `T${troopTotal} L${village.loyalty}`;
        continue;
      }

      slot.polygon.setAttribute('fill', isFogged ? 'var(--bg)' : 'var(--bg-surface)');
      slot.polygon.setAttribute('stroke', isSelected ? 'var(--accent)' : tile.ring === 3 ? 'var(--border-dim)' : 'var(--border)');
      slot.polygon.setAttribute('stroke-width', isSelected ? '2' : '1');
      slot.ownerLabel.textContent = isFogged ? '?' : '';
      slot.detailLabel.textContent = '';
    }

    const armies = seatView ? seatView.visibleArmies : [...state.armies.values()].filter((army) => army.status === 'marching' || army.status === 'returning');
    for (const army of armies) {
      const fromSlot = slots[army.currentHexIndex];
      const targetIndex = army.status === 'returning' ? army.originHexIndex : army.targetHexIndex;
      const toSlot = slots[targetIndex];
      if (!fromSlot || !toSlot) continue;
      const color = SEAT_COLORS[army.owner];
      armyLayer.append(
        createSvgShape('line', {
          x1: fromSlot.centerX.toFixed(1),
          y1: fromSlot.centerY.toFixed(1),
          x2: toSlot.centerX.toFixed(1),
          y2: toSlot.centerY.toFixed(1),
          stroke: color,
          'stroke-width': '2',
          'stroke-dasharray': '4 3',
        }),
        createSvgShape('circle', {
          cx: fromSlot.centerX.toFixed(1),
          cy: fromSlot.centerY.toFixed(1),
          r: '4',
          fill: color,
        }),
      );
    }
  }

  return { element: svg, update };
}
