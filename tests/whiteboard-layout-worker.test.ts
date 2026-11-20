import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { benchmarkBoard } from '../harness/board-layout-cost.ts';
import { createLayoutClient } from '../server/whiteboard/layout-client.ts';
import { elementTableOf } from '../shared/whiteboard-element-table.ts';

test('a small board gets its tiles while a large board is still laying out in the worker', async () => {
  const client = createLayoutClient({ cachePath: null, onSavedLayoutWritten: () => {} });
  const largeBoard = benchmarkBoard(3000);
  const smallBoard = { ...benchmarkBoard(40), id: '00000000-0000-4000-8000-0000000000aa' };
  for (const board of [largeBoard, smallBoard]) await client.ask(board, { kind: 'cached-tiles', boardId: board.id, version: board.version, updatedAt: board.updatedAt, keys: [], withChrome: false });
  const settledBoards: string[] = [];
  const largeTiles = client.ask(largeBoard, { kind: 'tiles', boardId: largeBoard.id, keys: [], withChrome: true }).then(() => settledBoards.push('large'));
  const smallTiles = client.ask(smallBoard, { kind: 'tiles', boardId: smallBoard.id, keys: [], withChrome: true }).then(() => settledBoards.push('small'));
  await Promise.all([largeTiles, smallTiles]);
  assert.deepEqual(settledBoards, ['small', 'large']);
});

test('an edit made while a large board is still saving its first layout keeps the saved layout', async () => {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-layout-cache-')), 'layout.db');
  let wholeWriteCount = 0;
  const client = createLayoutClient({ cachePath, onSavedLayoutWritten: () => { wholeWriteCount += 1; } });
  const board = benchmarkBoard(3000);
  const movedBox = board.elements.get('b1');
  assert.ok(movedBox?.kind === 'box' && movedBox.place !== 'aside' && movedBox.place !== 'plan' && 'at' in movedBox.place);
  const afterMove = { ...movedBox, place: { at: { x: movedBox.place.at.x + 40, y: movedBox.place.at.y + 30 } } };
  const movedElements = elementTableOf();
  for (const element of board.elements.values()) movedElements.put(element.id === afterMove.id ? afterMove : element);
  const movedBoard = { ...board, version: board.version + 1, updatedAt: board.updatedAt + 1, elements: movedElements };
  const tiles = client.ask(board, { kind: 'tiles', boardId: board.id, keys: [], withChrome: true });
  await Promise.all([tiles, client.advance(movedBoard, [{ id: afterMove.id, after: afterMove, isAppended: false }], [])]);
  for (let waitedMs = 0; wholeWriteCount === 0 && waitedMs < 20000; waitedMs += 100) await delay(100);
  assert.equal(wholeWriteCount, 1);
});
