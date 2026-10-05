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

function radiusOf(id: string, tier: Exclude<CalmTier, 'resting'>): number {
  if (tier === 'working' || tier === 'ready') return OUTER_BAND_MIN_RADIUS + hashUnit(id, 1) * (OUTER_BAND_MAX_RADIUS - OUTER_BAND_MIN_RADIUS);
  return RING_RADIUS_BY_TIER[tier];
}

export function placeLights(entries: readonly { id: string; tier: CalmTier }[]): CalmLight[] {
  const lights: CalmLight[] = [];
  for (const { id, tier } of entries) {
    if (tier === 'resting') continue;
    lights.push({ id, tier, angle: hashUnit(id) * FULL_TURN_RADIANS, radius: radiusOf(id, tier) });
  }
  if (lights.length < 2) return lights;
  const lightsByAngle = [...lights].sort((first, second) => first.angle - second.angle);
  const gapRadians = FULL_TURN_RADIANS / lightsByAngle.length;
  const firstAngle = lightsByAngle.reduce((startAngle, light, index) => Math.max(
    startAngle, light.angle - FULL_TURN_RADIANS + (lightsByAngle.length - index) * gapRadians,
  ), lightsByAngle[0].angle);
  lightsByAngle.forEach((light, index) => {
    light.angle = (firstAngle + index * gapRadians) % FULL_TURN_RADIANS;
  });
  return lights;
}

export function shouldShowLabels(fieldWidthPx: number): boolean {
  return fieldWidthPx > 640;
}
