import type { CalmTier } from './calm-priority-core.ts';

export const NOW_RADIUS = 0.32;
export const NEXT_RADIUS = 0.60;
export const LATER_RADIUS = 0.88;
export const OUTER_BAND_MIN_RADIUS = 0.98;
export const OUTER_BAND_MAX_RADIUS = 1.12;

const FULL_TURN_RADIANS = 2 * Math.PI;
const RING_RADIUS_BY_TIER = { now: NOW_RADIUS, next: NEXT_RADIUS, later: LATER_RADIUS };

export function hashUnit(id: string, salt = 0): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

interface CalmLight {
  id: string;
  tier: CalmTier;
  angle: number;
  radius: number;
}

export function placeLights(entries: readonly { id: string; tier: CalmTier }[], minGapRadians: number): CalmLight[] {
  const lights: CalmLight[] = [];
  const rings: Record<keyof typeof RING_RADIUS_BY_TIER | 'outerBand', CalmLight[]> = { now: [], next: [], later: [], outerBand: [] };
  for (const { id, tier } of entries) {
    if (tier === 'resting') continue;
    const isOuterBand = tier === 'working' || tier === 'ready';
    const radius = isOuterBand
      ? OUTER_BAND_MIN_RADIUS + hashUnit(id, 1) * (OUTER_BAND_MAX_RADIUS - OUTER_BAND_MIN_RADIUS)
      : RING_RADIUS_BY_TIER[tier];
    const light = { id, tier, angle: hashUnit(id) * FULL_TURN_RADIANS, radius };
    lights.push(light);
    rings[isOuterBand ? 'outerBand' : tier].push(light);
  }
  for (const [ringName, ring] of Object.entries(rings)) {
    if (ring.length < 2) continue;
    ring.sort((first, second) => first.angle - second.angle);
    const requestedGapRadians = ringName === 'outerBand' ? FULL_TURN_RADIANS : minGapRadians;
    const gapRadians = Math.min(requestedGapRadians, FULL_TURN_RADIANS / ring.length);
    const firstAngle = ring.reduce((startAngle, light, index) => Math.max(
      startAngle, light.angle - FULL_TURN_RADIANS + (ring.length - index) * gapRadians,
    ), ring[0].angle);
    let previousAngle = firstAngle - gapRadians;
    for (const light of ring) {
      const spacedAngle = Math.max(light.angle, previousAngle + gapRadians);
      previousAngle = spacedAngle;
      light.angle = spacedAngle % FULL_TURN_RADIANS;
    }
  }
  return lights;
}

export function shouldShowLabels(fieldWidthPx: number): boolean {
  return fieldWidthPx > 640;
}
