export type TerrainKind = 'plain' | 'mountain' | 'lake' | 'forest' | 'fertile' | 'ore';

export const TERRAIN_MIN_RADIUS = 6;
export const FOREST_DEFENSE_MULTIPLIER = 1.25;
export const BONUS_TILE_YIELD = 20;
const FOREST_MARCH_COST = 2;
const MAX_GENERATION_ATTEMPTS = 64;
const RIDGE_MOUNTAIN_CHANCE = 0.3;
const SCATTERED_MOUNTAIN_CHANCE = 0.04;
const LAKE_CHANCE = 0.04;
const FOREST_CHANCE = 0.14;
const BONUS_CHANCE = 0.05;

interface AxialCoord {
  q: number;
  r: number;
}

interface TerrainTile extends AxialCoord {
  ring: number;
}

interface TerrainRequest {
  tiles: readonly TerrainTile[];
  radius: number;
  seatCount: number;
  seed: number;
  protectedKeys: ReadonlySet<string>;
}

type AxialTransform = (coord: AxialCoord) => AxialCoord;

const NEIGHBOR_OFFSETS: readonly AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

const identity: AxialTransform = ({ q, r }) => ({ q, r });
const rotateSixty: AxialTransform = ({ q, r }) => ({ q: -r, r: q + r });
const rotateHalfTurn: AxialTransform = ({ q, r }) => ({ q: -q, r: -r });
const mirrorBetweenFirstCorners: AxialTransform = ({ q, r }) => ({ q, r: -q - r });

function composed(first: AxialTransform, second: AxialTransform): AxialTransform {
  return (coord) => second(first(coord));
}

function symmetryGroupFor(seatCount: number): AxialTransform[] {
  if (seatCount !== 6) {
    return [identity, rotateHalfTurn, mirrorBetweenFirstCorners, composed(mirrorBetweenFirstCorners, rotateHalfTurn)];
  }
  const rotations: AxialTransform[] = [identity];
  for (let turn = 1; turn < 6; turn += 1) rotations.push(composed(rotations[turn - 1], rotateSixty));
  return rotations;
}

export function tileKey({ q, r }: AxialCoord): string {
  return `${q},${r}`;
}

function orbitRepresentative(coord: AxialCoord, group: readonly AxialTransform[]): string {
  const images = group.map((transform) => transform(coord)).sort((left, right) => left.q - right.q || left.r - right.r);
  return tileKey(images[0]);
}

function hashToUnit(seed: number, salt: number, key: string): number {
  let hash = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) | 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x85ebca6b);
    hash ^= hash >>> 13;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

export function isPassable(kind: TerrainKind): boolean {
  return kind !== 'mountain' && kind !== 'lake';
}

export function marchCostOf(kind: TerrainKind): number {
  return kind === 'forest' ? FOREST_MARCH_COST : 1;
}

function isRidgeRing(ring: number, radius: number): boolean {
  const ridgeRing = Math.floor(radius / 2);
  return ring === ridgeRing || ring === ridgeRing + 1;
}

function kindFromRoll(roll: number, tile: TerrainTile, radius: number): TerrainKind {
  const mountainChance = isRidgeRing(tile.ring, radius) ? RIDGE_MOUNTAIN_CHANCE : SCATTERED_MOUNTAIN_CHANCE;
  if (roll < mountainChance) return 'mountain';
  const isInnerLand = tile.ring >= 1 && tile.ring <= radius - 2;
  const lakeLimit = mountainChance + (isInnerLand ? LAKE_CHANCE : 0);
  if (roll < lakeLimit) return 'lake';
  const forestLimit = lakeLimit + FOREST_CHANCE;
  if (roll < forestLimit) return 'forest';
  if (!isInnerLand) return 'plain';
  if (roll < forestLimit + BONUS_CHANCE) return 'fertile';
  if (roll < forestLimit + BONUS_CHANCE * 2) return 'ore';
  return 'plain';
}

function reachesEveryPassableTile(tiles: readonly TerrainTile[], kinds: readonly TerrainKind[], startIndex: number): boolean {
  const indexByKey = new Map(tiles.map((tile, index) => [tileKey(tile), index]));
  const visited = new Set<number>([startIndex]);
  const queue = [startIndex];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = tiles[queue[cursor]];
    for (const offset of NEIGHBOR_OFFSETS) {
      const neighbor = indexByKey.get(tileKey({ q: current.q + offset.q, r: current.r + offset.r }));
      if (neighbor === undefined || visited.has(neighbor) || !isPassable(kinds[neighbor])) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  return kinds.every((kind, index) => !isPassable(kind) || visited.has(index));
}

function plainTerrain(tileCount: number): TerrainKind[] {
  return Array.from({ length: tileCount }, () => 'plain' as const);
}

export function generateTerrain({ tiles, radius, seatCount, seed, protectedKeys }: TerrainRequest): TerrainKind[] {
  if (radius < TERRAIN_MIN_RADIUS) return plainTerrain(tiles.length);
  const group = symmetryGroupFor(seatCount);
  const startIndex = Math.max(0, tiles.findIndex((tile) => protectedKeys.has(tileKey(tile))));
  for (let salt = 0; salt < MAX_GENERATION_ATTEMPTS; salt += 1) {
    const kinds = tiles.map((tile) => {
      if (protectedKeys.has(tileKey(tile))) return 'plain' as const;
      return kindFromRoll(hashToUnit(seed, salt, orbitRepresentative(tile, group)), tile, radius);
    });
    if (reachesEveryPassableTile(tiles, kinds, startIndex)) return kinds;
  }
  return plainTerrain(tiles.length);
}

interface SparseSiteRequest {
  tiles: readonly TerrainTile[];
  seatCount: number;
  seed: number;
  protectedKeys: ReadonlySet<string>;
  kinds: readonly TerrainKind[];
  villageShare: number;
  beaconRings: readonly number[];
}

const BEACON_SALT = 101;
const SPARSE_VILLAGE_SALT = 211;

export function generateSparseSites({ tiles, seatCount, seed, protectedKeys, kinds, villageShare, beaconRings }: SparseSiteRequest): {
  villageKeys: Set<string>;
  beaconKeys: Set<string>;
} {
  const group = symmetryGroupFor(seatCount);
  const openTiles = tiles.filter((tile, index) => isPassable(kinds[index]) && !protectedKeys.has(tileKey(tile)));
  const beaconKeys = new Set<string>();
  for (const ring of beaconRings) {
    const ringTiles = openTiles.filter((tile) => tile.ring === ring);
    const pickedOrbit = ringTiles
      .map((tile) => orbitRepresentative(tile, group))
      .sort((left, right) => hashToUnit(seed, BEACON_SALT + ring, left) - hashToUnit(seed, BEACON_SALT + ring, right) || left.localeCompare(right))[0];
    if (pickedOrbit === undefined) continue;
    for (const tile of ringTiles) {
      if (orbitRepresentative(tile, group) === pickedOrbit) beaconKeys.add(tileKey(tile));
    }
  }
  const villageOrbits = [...new Set(openTiles.map((tile) => orbitRepresentative(tile, group)))]
    .filter((orbit) => !beaconKeys.has(orbit))
    .sort((left, right) => hashToUnit(seed, SPARSE_VILLAGE_SALT, left) - hashToUnit(seed, SPARSE_VILLAGE_SALT, right) || left.localeCompare(right));
  const chosenOrbits = new Set(villageOrbits.slice(0, Math.round(villageOrbits.length * villageShare)));
  const villageKeys = new Set<string>();
  for (const tile of openTiles) {
    const key = tileKey(tile);
    if (!beaconKeys.has(key) && chosenOrbits.has(orbitRepresentative(tile, group))) villageKeys.add(key);
  }
  return { villageKeys, beaconKeys };
}
