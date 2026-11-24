import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Op } from '../shared/contracts/whiteboard.ts';
import type { ServerMessageOf } from '../shared/contracts/control-messages.ts';
import type { TileLod } from '../shared/contracts/whiteboard-tiles.ts';
import { createWhiteboardWiring } from '../server/whiteboard/whiteboard-wiring.ts';

test('a zoomed-out view over a dense cluster gets titles but never full detail past the in-view budget, even when one far box stretches the board bounds', async () => {
  const wiring = createWhiteboardWiring({ boardsRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-zoom-detail-')), logger: { warn: () => {} } });
  await wiring.loaded;
  const boardId = (await wiring.handleOperator.create('Dense cluster')).summary?.id ?? '';
  const clusterBoxes = Array.from({ length: 1200 }, (_, index) => ({ op: 'add', element: { kind: 'box', id: `cluster-${index}`, title: 'Card', place: { at: { x: (index % 40) * 300, y: Math.floor(index / 40) * 300 } } } }));
  const farBox = { op: 'add', element: { kind: 'box', id: 'far-away', title: 'Far', place: { at: { x: 400000, y: 0 } } } };
  assert.equal((await wiring.handleOperator.put(boardId, z.array(Op).parse([...clusterBoxes, farBox]))).ok, true);
  const clusterView = { x: -500, y: -500, width: 13000, height: 10000 };
  const answerAt = async (lod: TileLod) => {
    const sent: ServerMessageOf<'whiteboard-tiles'>[] = [];
    const viewer = { send: (message: ServerMessageOf<'whiteboard-tiles'> | ServerMessageOf<'whiteboard-tile-diff'>) => (message.type === 'whiteboard-tiles' ? sent.push(message) : 0) };
    await wiring.tiles.view(viewer, { boardId, view: clusterView, lod, scale: 0.06, knownVersion: null });
    const [answer] = sent;
    assert.ok(answer, `a ${lod} view gets a tiles reply`);
    return answer;
  };
  const full = await answerAt('full');
  assert.equal(full.elementsInView, 1200);
  assert.deepEqual(full.tiles, [], 'full detail is withheld for 1200 cards in view');
  const titles = await answerAt('titles');
  assert.ok(titles.tiles.some((tile) => tile.elements.length > 0), 'titles detail is served for the same view');
});
