import { boxIdsOfWire } from '#shared/contracts/whiteboard.ts';
import type { WireEnd } from '#shared/contracts/whiteboard.ts';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
type WireEnds = { from: WireEnd; to: WireEnd };

function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function liesToward(delta: Point, direction: Point): boolean {
  const isHorizontalStep = Math.abs(delta.x) >= Math.abs(delta.y);
  if (direction.x !== 0) return isHorizontalStep && Math.sign(delta.x) === Math.sign(direction.x);
  return !isHorizontalStep && Math.sign(delta.y) === Math.sign(direction.y);
}

export function nextWiredBoxId(shownBoxId: string, direction: Point, wires: Iterable<WireEnds>, boundsOfWalkable: (boxId: string) => Rect | null): string | null {
  const shownBounds = boundsOfWalkable(shownBoxId);
  if (!shownBounds) return null;
  const shownCentre = centreOf(shownBounds);
  let nearest: { boxId: string; distance: number } | null = null;
  for (const wire of wires) {
    const wiredBoxIds = boxIdsOfWire(wire);
    if (!wiredBoxIds.includes(shownBoxId)) continue;
    for (const neighbourId of wiredBoxIds) {
      if (neighbourId === shownBoxId) continue;
      const neighbourBounds = boundsOfWalkable(neighbourId);
      if (!neighbourBounds) continue;
      const neighbourCentre = centreOf(neighbourBounds);
      const delta = { x: neighbourCentre.x - shownCentre.x, y: neighbourCentre.y - shownCentre.y };
      if (!liesToward(delta, direction)) continue;
      const distance = Math.hypot(delta.x, delta.y);
      if (nearest && nearest.distance <= distance) continue;
      nearest = { boxId: neighbourId, distance };
    }
  }
  return nearest?.boxId ?? null;
}
