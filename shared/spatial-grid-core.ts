interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SpatialGrid {
  readonly cellSize: number;
  readonly slotsByCell: Map<number, number[]>;
  minX: Float64Array;
  minY: Float64Array;
  maxX: Float64Array;
  maxY: Float64Array;
  isStored: Uint8Array;
  visitStamp: Uint32Array;
  currentStamp: number;
  readonly oversizedSlots: Set<number>;
}

const CELL_KEY_OFFSET = 1 << 20;
const CELL_KEY_STRIDE = 1 << 21;
const INITIAL_CAPACITY = 64;
const MAX_CELLS_PER_RECT = 256;

function createSpatialGrid(cellSize: number, capacity = INITIAL_CAPACITY): SpatialGrid {
  const initialCapacity = Math.max(1, capacity);
  return {
    cellSize,
    slotsByCell: new Map(),
    minX: new Float64Array(initialCapacity),
    minY: new Float64Array(initialCapacity),
    maxX: new Float64Array(initialCapacity),
    maxY: new Float64Array(initialCapacity),
    isStored: new Uint8Array(initialCapacity),
    visitStamp: new Uint32Array(initialCapacity),
    currentStamp: 0,
    oversizedSlots: new Set(),
  };
}

function grown<Values extends Float64Array | Uint8Array | Uint32Array>(values: Values, capacity: number, make: (length: number) => Values): Values {
  const larger = make(capacity);
  larger.set(values);
  return larger;
}

function ensureCapacity(grid: SpatialGrid, slot: number): void {
  if (slot < grid.minX.length) return;
  const capacity = Math.max(slot + 1, grid.minX.length * 2);
  grid.minX = grown(grid.minX, capacity, (length) => new Float64Array(length));
  grid.minY = grown(grid.minY, capacity, (length) => new Float64Array(length));
  grid.maxX = grown(grid.maxX, capacity, (length) => new Float64Array(length));
  grid.maxY = grown(grid.maxY, capacity, (length) => new Float64Array(length));
  grid.isStored = grown(grid.isStored, capacity, (length) => new Uint8Array(length));
  grid.visitStamp = grown(grid.visitStamp, capacity, (length) => new Uint32Array(length));
}

function cellIndexOf(grid: SpatialGrid, coordinate: number): number {
  return Math.floor(coordinate / grid.cellSize);
}

function cellKeyOf(cellX: number, cellY: number): number {
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellY + CELL_KEY_OFFSET);
}

function spannedCellCount(grid: SpatialGrid, minX: number, minY: number, maxX: number, maxY: number): number {
  return (cellIndexOf(grid, maxX) - cellIndexOf(grid, minX) + 1) * (cellIndexOf(grid, maxY) - cellIndexOf(grid, minY) + 1);
}

function isOversized(grid: SpatialGrid, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return !(spannedCellCount(grid, minX, minY, maxX, maxY) <= MAX_CELLS_PER_RECT);
}

function forEachCell(grid: SpatialGrid, minX: number, minY: number, maxX: number, maxY: number, visitCell: (cellKey: number) => void): void {
  const firstCellX = cellIndexOf(grid, minX);
  const lastCellX = cellIndexOf(grid, maxX);
  const firstCellY = cellIndexOf(grid, minY);
  const lastCellY = cellIndexOf(grid, maxY);
  for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
    for (let cellY = firstCellY; cellY <= lastCellY; cellY += 1) visitCell(cellKeyOf(cellX, cellY));
  }
}

function removeSlot(grid: SpatialGrid, slot: number): void {
  if (slot >= grid.isStored.length || grid.isStored[slot] === 0) return;
  grid.isStored[slot] = 0;
  if (grid.oversizedSlots.delete(slot)) return;
  forEachCell(grid, grid.minX[slot] ?? 0, grid.minY[slot] ?? 0, grid.maxX[slot] ?? 0, grid.maxY[slot] ?? 0, (cellKey) => {
    const slots = grid.slotsByCell.get(cellKey);
    if (!slots) return;
    const position = slots.indexOf(slot);
    if (position === -1) return;
    slots[position] = slots[slots.length - 1] ?? slot;
    slots.pop();
    if (slots.length === 0) grid.slotsByCell.delete(cellKey);
  });
}

function placeSlot(grid: SpatialGrid, slot: number, rect: GridRect): void {
  removeSlot(grid, slot);
  ensureCapacity(grid, slot);
  grid.minX[slot] = rect.x;
  grid.minY[slot] = rect.y;
  grid.maxX[slot] = rect.x + rect.width;
  grid.maxY[slot] = rect.y + rect.height;
  grid.isStored[slot] = 1;
  if (isOversized(grid, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height)) {
    grid.oversizedSlots.add(slot);
    return;
  }
  forEachCell(grid, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, (cellKey) => {
    const slots = grid.slotsByCell.get(cellKey);
    if (slots) {
      slots.push(slot);
      return;
    }
    grid.slotsByCell.set(cellKey, [slot]);
  });
}

function nextStamp(grid: SpatialGrid): number {
  grid.currentStamp += 1;
  if (grid.currentStamp < 0xffffffff) return grid.currentStamp;
  grid.visitStamp.fill(0);
  grid.currentStamp = 1;
  return grid.currentStamp;
}

function isSlotTouching(grid: SpatialGrid, slot: number, rect: GridRect): boolean {
  return (grid.minX[slot] ?? 0) <= rect.x + rect.width && rect.x <= (grid.maxX[slot] ?? 0) && (grid.minY[slot] ?? 0) <= rect.y + rect.height && rect.y <= (grid.maxY[slot] ?? 0);
}

function forEachStoredSlotTouching(grid: SpatialGrid, rect: GridRect, visitSlot: (slot: number) => unknown): void {
  for (let slot = 0; slot < grid.isStored.length; slot += 1) {
    if (grid.isStored[slot] === 1 && isSlotTouching(grid, slot, rect) && visitSlot(slot) === true) return;
  }
}

function forEachSlotTouching(grid: SpatialGrid, rect: GridRect, visitSlot: (slot: number) => unknown): void {
  const queryMaxX = rect.x + rect.width;
  const queryMaxY = rect.y + rect.height;
  if (isOversized(grid, rect.x, rect.y, queryMaxX, queryMaxY)) {
    forEachStoredSlotTouching(grid, rect, visitSlot);
    return;
  }
  const stamp = nextStamp(grid);
  for (const slot of grid.oversizedSlots) {
    grid.visitStamp[slot] = stamp;
    if (isSlotTouching(grid, slot, rect) && visitSlot(slot) === true) return;
  }
  const firstCellX = cellIndexOf(grid, rect.x);
  const lastCellX = cellIndexOf(grid, queryMaxX);
  const firstCellY = cellIndexOf(grid, rect.y);
  const lastCellY = cellIndexOf(grid, queryMaxY);
  for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
    for (let cellY = firstCellY; cellY <= lastCellY; cellY += 1) {
      const slots = grid.slotsByCell.get(cellKeyOf(cellX, cellY));
      if (!slots) continue;
      for (const slot of slots) {
        if (grid.visitStamp[slot] === stamp) continue;
        grid.visitStamp[slot] = stamp;
        if (isSlotTouching(grid, slot, rect) && visitSlot(slot) === true) return;
      }
    }
  }
}

function hasSlotTouching(grid: SpatialGrid, rect: GridRect, accepts: (slot: number) => boolean = () => true): boolean {
  let isFound = false;
  forEachSlotTouching(grid, rect, (slot) => {
    if (!accepts(slot)) return false;
    isFound = true;
    return true;
  });
  return isFound;
}

function gridOfRects(rects: readonly GridRect[], cellSize: number): SpatialGrid {
  const grid = createSpatialGrid(cellSize, rects.length);
  for (const [slot, rect] of rects.entries()) placeSlot(grid, slot, rect);
  return grid;
}

export { createSpatialGrid, forEachSlotTouching, gridOfRects, hasSlotTouching, placeSlot };
