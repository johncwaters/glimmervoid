import { forEachSlotTouching, gridOfRects } from '#shared/spatial-grid-core.ts';
import type { SpatialGrid } from '#shared/spatial-grid-core.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';
import { rectsOverlap } from '#shared/whiteboard-route-core.ts';

export type CardSide = 'right' | 'left' | 'below' | 'above';

interface CardSpot {
  x: number;
  y: number;
  side: CardSide;
}

interface CardPlacementArea {
  mapRects: readonly Rect[];
  mapGrid: SpatialGrid;
  view: Rect;
}

interface CardSize {
  width: number;
  height: number;
}

const SIDE_OFFSET_PX = 48;
const STACK_GAP_PX = 10;
const GRID_CELL_PX = 256;
const SIDES: readonly CardSide[] = ['right', 'left', 'below', 'above'];

function overlapAreaOf(first: Rect, second: Rect): number {
  const width = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
  const height = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function gappedRectOf(rect: Rect): Rect {
  return { x: rect.x - STACK_GAP_PX, y: rect.y - STACK_GAP_PX, width: rect.width + STACK_GAP_PX * 2, height: rect.height + STACK_GAP_PX * 2 };
}

function alignedSpotsOf(anchor: Rect, card: CardSize, side: CardSide): CardSpot[] {
  if (side === 'right' || side === 'left') {
    const cardLeft = side === 'right' ? anchor.x + anchor.width + SIDE_OFFSET_PX : anchor.x - SIDE_OFFSET_PX - card.width;
    const cardTops = [anchor.y, anchor.y + anchor.height / 2 - card.height / 2, anchor.y + anchor.height - card.height];
    return cardTops.map((cardTop) => ({ x: cardLeft, y: cardTop, side }));
  }
  const cardTop = side === 'below' ? anchor.y + anchor.height + SIDE_OFFSET_PX : anchor.y - SIDE_OFFSET_PX - card.height;
  const cardLefts = [anchor.x, anchor.x + anchor.width / 2 - card.width / 2, anchor.x + anchor.width - card.width];
  return cardLefts.map((cardLeft) => ({ x: cardLeft, y: cardTop, side }));
}

function spotRectOf(spot: CardSpot, card: CardSize): Rect {
  return { x: spot.x, y: spot.y, width: card.width, height: card.height };
}

function slidSpotsOf(spot: CardSpot, card: CardSize, hardObstacles: readonly Rect[]): CardSpot[] {
  const isAcross = spot.side === 'right' || spot.side === 'left';
  const slidSpots: CardSpot[] = [];
  for (const direction of [1, -1]) {
    let moving = spot;
    for (let attempt = 0; attempt < hardObstacles.length; attempt += 1) {
      const blocker = hardObstacles.find((obstacle) => rectsOverlap(spotRectOf(moving, card), gappedRectOf(obstacle)));
      if (blocker === undefined) break;
      const gapped = gappedRectOf(blocker);
      if (isAcross) moving = { ...moving, y: direction > 0 ? gapped.y + gapped.height : gapped.y - card.height };
      if (!isAcross) moving = { ...moving, x: direction > 0 ? gapped.x + gapped.width : gapped.x - card.width };
    }
    if (moving !== spot) slidSpots.push(moving);
  }
  return slidSpots;
}

function costOf(spot: CardSpot, anchor: Rect, card: CardSize, area: CardPlacementArea, hardObstacles: readonly Rect[]): readonly number[] {
  const rect = spotRectOf(spot, card);
  const hardOverlap = hardObstacles.reduce((sum, obstacle) => sum + overlapAreaOf(rect, gappedRectOf(obstacle)), 0);
  const offViewArea = card.width * card.height - overlapAreaOf(rect, area.view);
  let mapOverlap = 0;
  forEachSlotTouching(area.mapGrid, rect, (slot) => {
    const mapRect = area.mapRects[slot];
    if (mapRect !== undefined) mapOverlap += overlapAreaOf(rect, mapRect);
  });
  const gapAcross = Math.max(0, anchor.x - (rect.x + rect.width), rect.x - (anchor.x + anchor.width));
  const gapAlong = Math.max(0, anchor.y - (rect.y + rect.height), rect.y - (anchor.y + anchor.height));
  return [hardOverlap + offViewArea, mapOverlap, Math.hypot(gapAcross, gapAlong)];
}

function isCheaper(candidateCost: readonly number[], bestCost: readonly number[]): boolean {
  for (const [index, value] of candidateCost.entries()) {
    const bestValue = bestCost[index] ?? 0;
    if (value !== bestValue) return value < bestValue;
  }
  return false;
}

export function cardPlacementAreaOf(mapRects: readonly Rect[], view: Rect): CardPlacementArea {
  return { mapRects, mapGrid: gridOfRects(mapRects, GRID_CELL_PX), view };
}

export function cardSpotOf(anchor: Rect, card: CardSize, area: CardPlacementArea, hardObstacles: readonly Rect[]): CardSpot {
  const alignedSpots = SIDES.flatMap((side) => alignedSpotsOf(anchor, card, side));
  const candidates = alignedSpots.flatMap((spot) => [spot, ...slidSpotsOf(spot, card, hardObstacles)]);
  let bestSpot: CardSpot = candidates[0] ?? { x: anchor.x + anchor.width + SIDE_OFFSET_PX, y: anchor.y, side: 'right' };
  let bestCost = costOf(bestSpot, anchor, card, area, hardObstacles);
  for (const candidate of candidates.slice(1)) {
    const cost = costOf(candidate, anchor, card, area, hardObstacles);
    if (!isCheaper(cost, bestCost)) continue;
    bestSpot = candidate;
    bestCost = cost;
  }
  return clampedIntoView(bestSpot, card, area.view);
}

function clampedIntoView(spot: CardSpot, card: CardSize, view: Rect): CardSpot {
  const clampedLeft = Math.max(view.x, Math.min(spot.x, view.x + view.width - card.width));
  const clampedTop = Math.max(view.y, Math.min(spot.y, view.y + view.height - card.height));
  return { ...spot, x: clampedLeft, y: clampedTop };
}
