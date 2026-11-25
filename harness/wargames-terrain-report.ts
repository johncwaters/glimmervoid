import { WARGAMES_SEAT_IDS, WargamesMatchSpec } from '../shared/contracts/wargames.ts';
import { createInitialMatchState } from '../shared/wargames/engine.ts';
import type { MatchState } from '../shared/wargames/engine.ts';
import { isPassable, widthRuleViolations } from '../shared/wargames/terrain.ts';

const SEED_COUNT = 50;
const MIN_BLOCKED_SHARE = 0.08;
const MAX_BLOCKED_SHARE = 0.12;
const MAP_SIZES = [{ name: 'Large', mapRadius: 6 }, { name: 'Huge', mapRadius: 8 }] as const;
const SEAT_COUNTS = [4, 6] as const;
const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;

function specFor(mapRadius: number, seatCount: number, seed: number): WargamesMatchSpec {
  return WargamesMatchSpec.parse({
    version: 1,
    title: 'Terrain report',
    seed,
    tickDeadlineSeconds: 60,
    maxTicks: 40,
    mapRadius,
    seats: WARGAMES_SEAT_IDS.slice(0, seatCount).map((seatId, index) => ({
      seatId,
      label: `Seat ${index + 1}`,
      controllerKind: 'local-agent',
      modelDisplay: 'model',
      setup: { agent: 'claude-code', model: 'model', options: [], instructions: '' },
    })),
  });
}

function seedAt(index: number): number {
  return 20261124 + index * 7919;
}

function neighborIndices(state: MatchState, hexIndex: number): number[] {
  const tile = state.hexes[hexIndex];
  return DIRECTIONS.flatMap(([deltaQ, deltaR]) => {
    const neighbor = state.hexes.find((other) => other.q === tile.q + deltaQ && other.r === tile.r + deltaR);
    return neighbor === undefined ? [] : [neighbor.index];
  });
}

function blockedFeatureSizes(state: MatchState): number[] {
  const seen = new Set<number>();
  const sizes: number[] = [];
  for (const tile of state.hexes) {
    if (isPassable(state.terrain[tile.index]) || seen.has(tile.index)) continue;
    const queue = [tile.index];
    seen.add(tile.index);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const neighbor of neighborIndices(state, queue[cursor])) {
        if (seen.has(neighbor) || isPassable(state.terrain[neighbor])) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    sizes.push(queue.length);
  }
  return sizes;
}

function blockedNextToSite(state: MatchState): number {
  const siteIndices = state.villages.flatMap((village) => (village !== null && (village.isBeacon || village.owner !== null) ? [village.hexIndex] : []));
  return siteIndices.filter((siteIndex) => neighborIndices(state, siteIndex).some((neighbor) => !isPassable(state.terrain[neighbor]))).length;
}

let failures = 0;
console.log(`${SEED_COUNT} seeds per row`);
console.log('size   seats  blocked share min/mean/max  width violations  largest feature  lone blockers  blocked next to home or beacon');
for (const { name, mapRadius } of MAP_SIZES) {
  for (const seatCount of SEAT_COUNTS) {
    const shares: number[] = [];
    let violations = 0;
    let largest = 0;
    let loneBlockers = 0;
    let crowdedSites = 0;
    for (let index = 0; index < SEED_COUNT; index += 1) {
      const state = createInitialMatchState('report', 0, specFor(mapRadius, seatCount, seedAt(index)));
      shares.push(state.terrain.filter((kind) => !isPassable(kind)).length / state.terrain.length);
      violations += widthRuleViolations(state.hexes, state.terrain);
      const featureSizes = blockedFeatureSizes(state);
      largest = Math.max(largest, ...featureSizes);
      loneBlockers += featureSizes.filter((size) => size === 1).length;
      crowdedSites += blockedNextToSite(state);
    }
    const mean = shares.reduce((sum, share) => sum + share, 0) / shares.length;
    const outOfBand = shares.filter((share) => share < MIN_BLOCKED_SHARE || share > MAX_BLOCKED_SHARE).length;
    failures += violations + outOfBand + crowdedSites + loneBlockers;
    const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(6)} ${String(seatCount).padEnd(6)} ${`${percent(Math.min(...shares))} / ${percent(mean)} / ${percent(Math.max(...shares))}`.padEnd(29)} ${String(violations).padEnd(17)} ${String(largest).padEnd(16)} ${String(loneBlockers).padEnd(14)} ${crowdedSites}${outOfBand > 0 ? `  (${outOfBand} seeds outside 8-12%)` : ''}`);
  }
}
process.exitCode = failures === 0 ? 0 : 1;
