import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { Op } from '../shared/contracts/whiteboard.ts';
import { createWhiteboardWiring } from '../server/whiteboard/whiteboard-wiring.ts';
import { createBoardStore } from '../server/whiteboard/board-store-client.ts';
import { generateBoardRecord } from '../harness/load-cost/whiteboard-board-generator.ts';
import { BOARD_STORE_SCHEMA } from '../server/whiteboard/board-store-core.ts';

function damagedStoreRoot(damagedObject: string): string {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-damaged-page-'));
  const databasePath = path.join(boardsRoot, 'boards.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(BOARD_STORE_SCHEMA);
  database.exec('PRAGMA journal_mode = DELETE');
  const insertBoard = database.prepare('INSERT INTO boards (id, head, cursors, created_by, version) VALUES (?, ?, ?, ?, ?)');
  const insertRect = database.prepare('INSERT INTO element_rects (slot, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)');
  for (let rowIndex = 0; rowIndex < 2000; rowIndex += 1) {
    insertBoard.run(`board-${rowIndex}`, 'x'.repeat(200), '{}', null, 1);
    insertRect.run(rowIndex + 1, rowIndex, rowIndex + 1, rowIndex, rowIndex + 1);
  }
  const pageRow = database.prepare('SELECT pageno FROM dbstat WHERE name = ? ORDER BY pageno DESC LIMIT 1').get(damagedObject);
  const pageSizeRow = database.prepare('PRAGMA page_size').get();
  database.close();
  const pageNumber = Number(pageRow?.['pageno']);
  const pageSize = Number(pageSizeRow?.['page_size']);
  const databaseHandle = fs.openSync(databasePath, 'r+');
  fs.writeSync(databaseHandle, Buffer.alloc(pageSize, 0xab), 0, pageSize, (pageNumber - 1) * pageSize);
  fs.closeSync(databaseHandle);
  return boardsRoot;
}

test('a JSON board moves into the board store once, keeps its edits across restarts and answers region and text queries', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-'));
  const legacy = generateBoardRecord({ elementCount: 200, seed: 7, boardId: 'legacy-board', title: 'Legacy plan', createdAt: 0 });
  fs.writeFileSync(path.join(boardsRoot, 'legacy-board.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(boardsRoot, 'broken.json'), '{ not json');

  const first = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await first.loaded;
  assert.deepEqual(first.snapshotMessage().boards.map((board) => board.id), ['legacy-board']);
  assert.ok(fs.existsSync(path.join(boardsRoot, 'migrated-json', 'legacy-board.json')));
  assert.ok(!fs.existsSync(path.join(boardsRoot, 'legacy-board.json')));
  assert.ok(fs.existsSync(path.join(boardsRoot, 'boards.json.corrupt-moved-to-boards-sqlite')), 'an older Glimmervoid started on this folder keeps every picture');
  assert.ok(fs.readdirSync(boardsRoot).some((filename) => filename.startsWith('broken.json')));

  const [firstBoxId] = Object.values(legacy.board.elements).flatMap((element) => (element.kind === 'box' ? [element.id] : []));
  assert.ok(firstBoxId);
  const renamed = await first.handleOperator.put('legacy-board', z.array(Op).parse([
    { op: 'set', id: firstBoxId, fields: { title: 'Renamed in sqlite' } },
    { op: 'add', element: { kind: 'note', id: 'fresh-note', on: firstBoxId, text: 'zebra crossing' } },
  ]));
  assert.equal(renamed.ok, true, renamed.error ?? '');
  const versionBeforeRestart = (await first.handleOperator.get('legacy-board')).board?.version;

  const restarted = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await restarted.loaded;
  const reloaded = await restarted.handleOperator.get('legacy-board');
  const elements = reloaded.board?.elements ?? {};
  assert.equal(Object.keys(elements).length, Object.keys(legacy.board.elements).length + 1);
  const renamedBox = elements[firstBoxId];
  assert.equal(renamedBox?.kind === 'box' ? renamedBox.title : null, 'Renamed in sqlite');
  assert.equal(reloaded.board?.version, versionBeforeRestart);

  const smallBoardId = (await restarted.handleOperator.create('Order')).summary?.id ?? '';
  const boxAt = (id: string) => ({ op: 'add', element: { kind: 'box', id, title: id, at: { x: 0, y: 0 } } });
  assert.equal((await restarted.handleOperator.put(smallBoardId, z.array(Op).parse([boxAt('a'), boxAt('b')]))).ok, true);
  const readded = await restarted.handleOperator.put(smallBoardId, z.array(Op).parse([boxAt('n'), { op: 'remove', id: 'b' }, boxAt('b'), { op: 'remove', id: 'a' }, boxAt('a')]));
  assert.equal(readded.ok, true, readded.error ?? '');
  assert.deepEqual(Object.keys((await restarted.handleOperator.get(smallBoardId)).board?.elements ?? {}), ['n', 'b', 'a']);
  const reordered = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await reordered.loaded;
  assert.deepEqual(Object.keys((await reordered.handleOperator.get(smallBoardId)).board?.elements ?? {}), ['n', 'b', 'a'], 'elements removed and added back in one put keep their new places after a restart');
  await restarted.handleOperator.remove(smallBoardId);

  const store = createBoardStore(boardsRoot);
  assert.deepEqual(await store.searchText('legacy-board', 'zebra', 5), ['fresh-note']);
  await store.setRects('legacy-board', { [firstBoxId]: { minX: 0, maxX: 100, minY: 0, maxY: 40 } });
  assert.deepEqual(await store.queryRegion('legacy-board', { minX: 90, maxX: 200, minY: 30, maxY: 60 }, 10), [firstBoxId]);
  assert.deepEqual(await store.queryRegion('legacy-board', { minX: 101, maxX: 200, minY: 0, maxY: 60 }, 10), []);

  const stuckFilePath = path.join(boardsRoot, 'legacy-board.json');
  fs.mkdirSync(path.join(stuckFilePath, 'held'), { recursive: true });
  const refused = await restarted.handleOperator.remove('legacy-board');
  assert.equal(refused.ok, false);
  assert.ok((await store.boardIds()).has('legacy-board'), 'a board file that cannot be removed leaves the whole board in the store');
  fs.rmSync(stuckFilePath, { recursive: true });

  fs.copyFileSync(path.join(boardsRoot, 'migrated-json', 'legacy-board.json'), stuckFilePath);
  const removed = await restarted.handleOperator.remove('legacy-board');
  assert.equal(removed.ok, true);
  assert.equal((await store.boardIds()).size, 0);
  assert.deepEqual(await store.searchText('legacy-board', 'zebra', 5), []);
  const afterDelete = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await afterDelete.loaded;
  assert.deepEqual(afterDelete.snapshotMessage().boards, [], 'a board file left behind by a failed move does not bring a deleted board back');

  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-fresh-'));
  await createWhiteboardWiring({ boardsRoot: freshRoot }).loaded;
  assert.ok(fs.existsSync(path.join(freshRoot, 'boards.json.corrupt-moved-to-boards-sqlite')), 'a fresh install guards its pictures from an older Glimmervoid too');

  const damagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-damaged-'));
  fs.writeFileSync(path.join(damagedRoot, 'boards.sqlite'), 'not a database at all');
  fs.writeFileSync(path.join(damagedRoot, 'legacy-board.json'), JSON.stringify(legacy));
  const recovered = createWhiteboardWiring({ boardsRoot: damagedRoot, logger: { warn: () => {} } });
  await recovered.loaded;
  assert.deepEqual(recovered.snapshotMessage().boards.map((board) => board.id), ['legacy-board'], 'a damaged board database is set aside and the boards still load');
  assert.ok(fs.readdirSync(damagedRoot).some((filename) => filename.startsWith('boards.sqlite.corrupt-')));
  assert.equal((await recovered.handleOperator.create('After damage')).ok, true);
  const warningsAfterRestart: string[] = [];
  await createWhiteboardWiring({ boardsRoot: damagedRoot, logger: { warn: (warning: string) => warningsAfterRestart.push(warning) } }).loaded;
  assert.ok(warningsAfterRestart.some((warning) => warning.includes('pictures are kept') && warning.includes('boards.sqlite.corrupt-')), 'a set-aside board database keeps its pictures on every later start');

  for (const damagedObject of ['boards', 'element_rects_node']) {
    const damagedPageRoot = damagedStoreRoot(damagedObject);
    fs.writeFileSync(path.join(damagedPageRoot, 'legacy-board.json'), JSON.stringify(legacy));
    const recoveredFromPage = createWhiteboardWiring({ boardsRoot: damagedPageRoot, logger: { warn: () => {} } });
    await recoveredFromPage.loaded;
    assert.deepEqual(recoveredFromPage.snapshotMessage().boards.map((board) => board.id), ['legacy-board'], `a board database with a damaged ${damagedObject} page is set aside and the boards still load`);
    assert.equal((await recoveredFromPage.handleOperator.create('After damaged page')).ok, true);
  }
});
