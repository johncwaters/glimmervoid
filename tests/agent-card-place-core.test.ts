import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardPlacementAreaOf, cardSpotOf } from '../public/board-session/agent-card-place-core.ts';

const view = { x: 0, y: 0, width: 1600, height: 1000 };
const card = { width: 250, height: 90 };
const agentBox = { x: 40, y: 400, width: 220, height: 100 };
const coversAny = (spot: { x: number; y: number }, rects: readonly { x: number; y: number; width: number; height: number }[]) =>
  rects.some((rect) => spot.x < rect.x + rect.width && rect.x < spot.x + card.width && spot.y < rect.y + rect.height && rect.y < spot.y + card.height);

test('an agent card keeps right of its box at the box top when that spot covers nothing', () => {
  const spot = cardSpotOf(agentBox, card, cardPlacementAreaOf([agentBox], view), []);
  assert.deepEqual(spot, { x: 308, y: 400, side: 'right' });
});

test('an agent card moves off the code map box right of its own box', () => {
  const neighborBox = { x: 300, y: 380, width: 220, height: 140 };
  const mapRects = [agentBox, neighborBox];
  const spot = cardSpotOf(agentBox, card, cardPlacementAreaOf(mapRects, view), []);
  assert.equal(coversAny(spot, mapRects), false);
});

test('an agent card sits outside the code map bounds beside its box row, off the wire runs between boxes', () => {
  const rowBoxes = [agentBox, { x: 560, y: 400, width: 220, height: 100 }];
  const rowsAboveAndBelow = [{ x: 40, y: 100, width: 740, height: 100 }, { x: 40, y: 700, width: 740, height: 100 }];
  const mapRects = [...rowBoxes, ...rowsAboveAndBelow];
  const spot = cardSpotOf(agentBox, card, cardPlacementAreaOf(mapRects, view), []);
  assert.deepEqual(spot, { x: 828, y: 400, side: 'right' });
});
