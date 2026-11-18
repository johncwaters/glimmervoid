import { boxIdOfEnd, boxIdsOfWire } from '#shared/contracts/whiteboard.ts';
import type { WireEnd } from '#shared/contracts/whiteboard.ts';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type WireEnds = { from: WireEnd; to: WireEnd };
type BoundsOf = (boxId: string) => Rect | null;
type AcceptsNeighbour = (wire: WireEnds, neighbourId: string, delta: Point) => boolean;

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function liesToward(delta: Point, direction: Point): boolean {
  const isHorizontalStep = Math.abs(delta.x) >= Math.abs(delta.y);
  if (direction.x !== 0) return isHorizontalStep && Math.sign(delta.x) === Math.sign(direction.x);
  return !isHorizontalStep && Math.sign(delta.y) === Math.sign(direction.y);
}

function nearestWiredBoxId(shownBoxId: string, wires: Iterable<WireEnds>, boundsOf: BoundsOf, acceptsNeighbour: AcceptsNeighbour): string | null {
  const shownBounds = boundsOf(shownBoxId);
  if (!shownBounds) return null;
  const shownCentre = centreOf(shownBounds);
  let nearest: { boxId: string; distance: number } | null = null;
  for (const wire of wires) {
    const wiredBoxIds = boxIdsOfWire(wire);
    if (!wiredBoxIds.includes(shownBoxId)) continue;
    for (const neighbourId of wiredBoxIds) {
      if (neighbourId === shownBoxId) continue;
      const neighbourBounds = boundsOf(neighbourId);
      if (!neighbourBounds) continue;
      const neighbourCentre = centreOf(neighbourBounds);
      const delta = { x: neighbourCentre.x - shownCentre.x, y: neighbourCentre.y - shownCentre.y };
      if (!acceptsNeighbour(wire, neighbourId, delta)) continue;
      const distance = Math.hypot(delta.x, delta.y);
      if (nearest && nearest.distance <= distance) continue;
      nearest = { boxId: neighbourId, distance };
    }
  }
  return nearest?.boxId ?? null;
}

export function nextWiredBoxId(shownBoxId: string, direction: Point, wires: Iterable<WireEnds>, boundsOfWalkable: BoundsOf): string | null {
  return nearestWiredBoxId(shownBoxId, wires, boundsOfWalkable, (_wire, _neighbourId, delta) => liesToward(delta, direction));
}

export function presentedBoxIdAfter(shownBoxId: string, step: 1 | -1, wires: Iterable<WireEnds>, boundsOf: BoundsOf): string | null {
  const neighbourEnd = step === 1 ? 'to' : 'from';
  return nearestWiredBoxId(shownBoxId, wires, boundsOf, (wire, neighbourId) => boxIdOfEnd(wire[neighbourEnd]) === neighbourId);
}

function readsBefore(first: Rect, second: Rect): boolean {
  if (first.y !== second.y) return first.y < second.y;
  return first.x < second.x;
}

export function firstPresentedBoxId(wires: Iterable<WireEnds>, boundsOf: BoundsOf): string | null {
  const wiredFromIds = new Set<string>();
  const wiredToIds = new Set<string>();
  for (const wire of wires) {
    const fromId = boxIdOfEnd(wire.from);
    const toId = boxIdOfEnd(wire.to);
    if (!fromId || !toId || fromId === toId) continue;
    wiredFromIds.add(fromId);
    wiredToIds.add(toId);
  }
  let first: { boxId: string; bounds: Rect } | null = null;
  for (const boxId of wiredFromIds) {
    if (wiredToIds.has(boxId)) continue;
    const bounds = boundsOf(boxId);
    if (!bounds || (first && !readsBefore(bounds, first.bounds))) continue;
    first = { boxId, bounds };
  }
  return first?.boxId ?? null;
}
