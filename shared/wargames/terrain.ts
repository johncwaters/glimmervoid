import type { WargamesBalance } from '../contracts/wargames.ts';

type WargamesTerrainRule = WargamesBalance['clusteredTerrain'];

export type TerrainKind = 'plain' | 'mountain' | 'lake' | 'forest' | 'fertile' | 'ore';

export const TERRAIN_MIN_RADIUS = 6;
export const FOREST_DEFENSE_MULTIPLIER = 1.25;
const FOREST_MARCH_COST = 2;
const MAX_GENERATION_ATTEMPTS = 64;

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

const ANCHOR_SALT = 307;
const SHAPE_SALT = 401;
const FOREST_SALT = 503;
const BONUS_SALT = 601;

interface ClusteredTerrainRequest extends TerrainRequest {
  passableKeys: ReadonlySet<string>;
  rule: WargamesTerrainRule;
}

interface TerrainBoard {
  tiles: readonly TerrainTile[];
  radius: number;
  indexByKey: ReadonlyMap<string, number>;
  group: readonly AxialTransform[];
  protectedKeys: ReadonlySet<string>;
  passableKeys: ReadonlySet<string>;
  rule: WargamesTerrainRule;
}

function neighborIndexOf(indexByKey: ReadonlyMap<string, number>, tile: AxialCoord, directionIndex: number): number | undefined {
  const offset = NEIGHBOR_OFFSETS[directionIndex % 6];
  return indexByKey.get(tileKey({ q: tile.q + offset.q, r: tile.r + offset.r }));
}

function isWallAt(kinds: readonly TerrainKind[], index: number | undefined): boolean {
  return index === undefined || !isPassable(kinds[index]);
}

export function widthRuleViolations(tiles: readonly TerrainTile[], kinds: readonly TerrainKind[]): number {
  const indexByKey = new Map(tiles.map((tile, index) => [tileKey(tile), index]));
  return tiles.filter((tile, index) => isPassable(kinds[index]) && isSqueezed(indexByKey, kinds, tile)).length;
}

function isSqueezed(indexByKey: ReadonlyMap<string, number>, kinds: readonly TerrainKind[], tile: AxialCoord): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (isWallAt(kinds, neighborIndexOf(indexByKey, tile, axis)) && isWallAt(kinds, neighborIndexOf(indexByKey, tile, axis + 3))) return true;
  }
  return false;
}

function rangeShape(anchor: AxialCoord, roll: (salt: number) => number, lengths: readonly number[]): AxialCoord[] {
  const length = lengths[Math.floor(roll(0) * lengths.length)];
  let direction = Math.floor(roll(1) * 6);
  const bendAt = roll(2) < 0.5 ? Math.floor(roll(3) * length) : -1;
  const bendTurn = roll(4) < 0.5 ? 1 : 5;
  const cells: AxialCoord[] = [anchor];
  for (let step = 1; step < length; step += 1) {
    if (step === bendAt) direction = (direction + bendTurn) % 6;
    const last = cells[cells.length - 1];
    cells.push({ q: last.q + NEIGHBOR_OFFSETS[direction].q, r: last.r + NEIGHBOR_OFFSETS[direction].r });
  }
  return cells;
}

function blobShape(anchor: AxialCoord, roll: (salt: number) => number, sizes: readonly number[]): AxialCoord[] {
  const size = sizes[Math.floor(roll(0) * sizes.length)];
  const cells: AxialCoord[] = [anchor];
  for (let grown = 1; cells.length < size && grown < size * 4; grown += 1) {
    const from = cells[Math.floor(roll(grown * 2) * cells.length)];
    const offset = NEIGHBOR_OFFSETS[Math.floor(roll(grown * 2 + 1) * 6)];
    const next = { q: from.q + offset.q, r: from.r + offset.r };
    if (!cells.some((cell) => cell.q === next.q && cell.r === next.r)) cells.push(next);
  }
  return cells;
}

function stampIndices(board: TerrainBoard, kinds: readonly TerrainKind[], shape: readonly AxialCoord[], kind: TerrainKind): number[] | null {
  const indices = new Set<number>();
  const isBlocking = !isPassable(kind);
  for (const transform of board.group) {
    for (const cell of shape) {
      const image = transform(cell);
      const key = tileKey(image);
      const index = board.indexByKey.get(key);
      if (index === undefined || board.protectedKeys.has(key) || kinds[index] !== 'plain') return null;
      if (isBlocking && board.passableKeys.has(key)) return null;
      indices.add(index);
    }
  }
  return [...indices];
}

function touchesKind(board: TerrainBoard, kinds: readonly TerrainKind[], indices: readonly number[], isMatch: (kind: TerrainKind) => boolean): boolean {
  return indices.some((index) => {
    for (let direction = 0; direction < 6; direction += 1) {
      const neighbor = neighborIndexOf(board.indexByKey, board.tiles[index], direction);
      if (neighbor !== undefined && isMatch(kinds[neighbor])) return true;
    }
    return false;
  });
}

function stampedWith(kinds: readonly TerrainKind[], indices: readonly number[], kind: TerrainKind): TerrainKind[] {
  const next = [...kinds];
  for (const index of indices) next[index] = kind;
  return next;
}

function anchorsBySalt(board: TerrainBoard, seed: number, salt: number): TerrainTile[] {
  const seen = new Set<string>();
  const anchors: { tile: TerrainTile; orbit: string }[] = [];
  for (const tile of board.tiles) {
    const orbit = orbitRepresentative(tile, board.group);
    if (seen.has(orbit) || board.protectedKeys.has(tileKey(tile))) continue;
    seen.add(orbit);
    anchors.push({ tile, orbit });
  }
  return anchors
    .sort((left, right) => hashToUnit(seed, salt, left.orbit) - hashToUnit(seed, salt, right.orbit) || left.orbit.localeCompare(right.orbit))
    .map(({ tile }) => tile);
}

function blockedFeatures(board: TerrainBoard, seed: number, salt: number, startIndex: number): TerrainKind[] | null {
  const tileCount = board.tiles.length;
  const minBlocked = Math.ceil(tileCount * board.rule.minBlockedShare);
  const maxBlocked = Math.floor(tileCount * board.rule.maxBlockedShare);
  let kinds = plainTerrain(tileCount);
  let blocked = 0;
  const anchors = anchorsBySalt(board, seed, ANCHOR_SALT + salt);
  const innerFirst = [...anchors.filter((anchor) => anchor.ring < board.radius), ...anchors.filter((anchor) => anchor.ring === board.radius)];
  for (const anchor of innerFirst) {
    if (blocked >= minBlocked) break;
    const anchorKey = tileKey(anchor);
    const roll = (shapeSalt: number) => hashToUnit(seed, SHAPE_SALT + salt * 31 + shapeSalt, anchorKey);
    const isLake = roll(97) < board.rule.lakeFeatureChance && anchor.ring >= 1;
    const shape = isLake ? blobShape(anchor, roll, board.rule.lakeSizes) : rangeShape(anchor, roll, board.rule.rangeLengths);
    const stamp = longestFittingStamp(board, kinds, shape, maxBlocked - blocked, isLake ? 'lake' : 'mountain', startIndex);
    if (stamp === null) continue;
    kinds = stamp.kinds;
    blocked += stamp.size;
  }
  return blocked >= minBlocked ? kinds : null;
}

function longestFittingStamp(
  board: TerrainBoard,
  kinds: readonly TerrainKind[],
  shape: readonly AxialCoord[],
  blockedBudget: number,
  kind: TerrainKind,
  startIndex: number,
): { kinds: TerrainKind[]; size: number } | null {
  for (let length = shape.length; length >= 2; length -= 1) {
    const indices = stampIndices(board, kinds, shape.slice(0, length), kind);
    if (indices === null || indices.length > blockedBudget) continue;
    if (touchesKind(board, kinds, indices, (neighborKind) => !isPassable(neighborKind))) continue;
    const candidate = stampedWith(kinds, indices, kind);
    if (board.tiles.some((tile, index) => isPassable(candidate[index]) && isSqueezed(board.indexByKey, candidate, tile))) continue;
    if (!reachesEveryPassableTile(board.tiles, candidate, startIndex)) continue;
    return { kinds: candidate, size: indices.length };
  }
  return null;
}

function withForestPatches(board: TerrainBoard, kinds: TerrainKind[], seed: number): TerrainKind[] {
  const targetForest = Math.round(board.tiles.length * board.rule.forestShare);
  const smallestPatch = Math.min(...board.rule.forestPatchSizes);
  let forested = 0;
  let next = kinds;
  for (const anchor of anchorsBySalt(board, seed, FOREST_SALT)) {
    if (forested >= targetForest) break;
    const anchorKey = tileKey(anchor);
    const patch = blobShape(anchor, (shapeSalt) => hashToUnit(seed, FOREST_SALT + shapeSalt, anchorKey), board.rule.forestPatchSizes);
    if (patch.length < smallestPatch) continue;
    const indices = stampIndices(board, next, patch, 'forest');
    if (indices === null || touchesKind(board, next, indices, (kind) => kind === 'forest') || forested + indices.length > targetForest + board.group.length) continue;
    next = stampedWith(next, indices, 'forest');
    forested += indices.length;
  }
  return next;
}

function withBonusTiles(board: TerrainBoard, kinds: readonly TerrainKind[], seed: number, radius: number): TerrainKind[] {
  return kinds.map((kind, index) => {
    const tile = board.tiles[index];
    const isInnerLand = tile.ring >= 1 && tile.ring <= radius - 2;
    if (kind !== 'plain' || !isInnerLand || board.protectedKeys.has(tileKey(tile))) return kind;
    const roll = hashToUnit(seed, BONUS_SALT, orbitRepresentative(tile, board.group));
    if (roll < board.rule.bonusChance) return 'fertile';
    if (roll < board.rule.bonusChance * 2) return 'ore';
    return 'plain';
  });
}

export function generateClusteredTerrain({ tiles, radius, seatCount, seed, protectedKeys, passableKeys, rule }: ClusteredTerrainRequest): TerrainKind[] {
  if (radius < TERRAIN_MIN_RADIUS) return plainTerrain(tiles.length);
  const indexByKey = new Map(tiles.map((tile, index) => [tileKey(tile), index]));
  const board: TerrainBoard = { tiles, radius, indexByKey, group: symmetryGroupFor(seatCount), protectedKeys, passableKeys, rule };
  const startIndex = Math.max(0, tiles.findIndex((tile) => protectedKeys.has(tileKey(tile))));
  for (let salt = 0; salt < MAX_GENERATION_ATTEMPTS; salt += 1) {
    const blockedKinds = blockedFeatures(board, seed, salt, startIndex);
    if (blockedKinds === null) continue;
    return withBonusTiles(board, withForestPatches(board, blockedKinds, seed), seed, radius);
  }
  return plainTerrain(tiles.length);
}

interface SparseSiteRequest {
  tiles: readonly TerrainTile[];
  seatCount: number;
  seed: number;
  protectedKeys: ReadonlySet<string>;
  kinds: readonly TerrainKind[];
}

interface BeaconRequest extends SparseSiteRequest {
  beaconRings: readonly number[];
}

interface VillageRequest extends SparseSiteRequest {
  beaconKeys: ReadonlySet<string>;
  villageShare: number;
  villageSpacing: number;
}

const BEACON_SALT = 101;
const SPARSE_VILLAGE_SALT = 211;

function openSiteTiles({ tiles, protectedKeys, kinds }: SparseSiteRequest): TerrainTile[] {
  return tiles.filter((tile, index) => isPassable(kinds[index]) && !protectedKeys.has(tileKey(tile)));
}

export function pickBeaconKeys(request: BeaconRequest): Set<string> {
  const group = symmetryGroupFor(request.seatCount);
  const openTiles = openSiteTiles(request);
  const beaconKeys = new Set<string>();
  for (const ring of request.beaconRings) {
    const ringTiles = openTiles.filter((tile) => tile.ring === ring);
    const pickedOrbit = ringTiles
      .map((tile) => orbitRepresentative(tile, group))
      .sort((left, right) => hashToUnit(request.seed, BEACON_SALT + ring, left) - hashToUnit(request.seed, BEACON_SALT + ring, right) || left.localeCompare(right))[0];
    if (pickedOrbit === undefined) continue;
    for (const tile of ringTiles) {
      if (orbitRepresentative(tile, group) === pickedOrbit) beaconKeys.add(tileKey(tile));
    }
  }
  return beaconKeys;
}

export function pickVillageKeys(request: VillageRequest): Set<string> {
  const { seed, beaconKeys, villageShare, villageSpacing } = request;
  const group = symmetryGroupFor(request.seatCount);
  const openTiles = openSiteTiles(request);
  const villageOrbits = [...new Set(openTiles.map((tile) => orbitRepresentative(tile, group)))]
    .filter((orbit) => !beaconKeys.has(orbit))
    .sort((left, right) => hashToUnit(seed, SPARSE_VILLAGE_SALT, left) - hashToUnit(seed, SPARSE_VILLAGE_SALT, right) || left.localeCompare(right));
  const villageTarget = Math.round(villageOrbits.length * villageShare);
  const siteTiles = openTiles.filter((tile) => beaconKeys.has(tileKey(tile)));
  const villageKeys = new Set<string>();
  let chosenOrbitCount = 0;
  for (const orbit of villageOrbits) {
    if (chosenOrbitCount >= villageTarget) break;
    const orbitTiles = openTiles.filter((tile) => !beaconKeys.has(tileKey(tile)) && orbitRepresentative(tile, group) === orbit);
    if (orbitTiles.some((tile, index) => [...siteTiles, ...orbitTiles.slice(0, index)].some((site) => hexDistance(site, tile) < villageSpacing))) continue;
    for (const tile of orbitTiles) villageKeys.add(tileKey(tile));
    siteTiles.push(...orbitTiles);
    chosenOrbitCount += 1;
  }
  return villageKeys;
}

function hexDistance(first: AxialCoord, second: AxialCoord): number {
  return Math.max(Math.abs(first.q - second.q), Math.abs(first.r - second.r), Math.abs(first.q + first.r - second.q - second.r));
}
