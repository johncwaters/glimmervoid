import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { Op } from '../shared/contracts/whiteboard.ts';
import { layoutBoard, nearPosition } from '../shared/whiteboard-layout-core.ts';
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

  const [firstBoxId] = [...legacy.board.elements.values()].flatMap((element) => (element.kind === 'box' ? [element.id] : []));
  assert.ok(firstBoxId);
  const renamed = await first.handleOperator.put('legacy-board', z.array(Op).parse([
    { op: 'set', id: firstBoxId, fields: { title: 'Renamed in sqlite' } },
    { op: 'add', element: { kind: 'box', id: 'fresh-note', shape: 'note', title: 'zebra crossing', at: { x: 9000, y: 40 } } },
  ]));
  assert.equal(renamed.ok, true, renamed.error ?? '');
  const boardBeforeRestart = (await first.handleOperator.get('legacy-board')).board;
  const versionBeforeRestart = boardBeforeRestart?.version;
  const storeWrittenBeforeCompactRows = new DatabaseSync(path.join(boardsRoot, 'boards.sqlite'));
  storeWrittenBeforeCompactRows.prepare(`UPDATE boards SET head = json_set(head, '$.columns', json('[]'), '$.lanes', json('[]')) WHERE id = ?`).run('legacy-board');
  const writeJsonRow = storeWrittenBeforeCompactRows.prepare('UPDATE elements SET body = ?, kind = NULL, asset_id = NULL, linked_board_id = NULL WHERE board_id = ? AND element_id = ?');
  const writeCompactRow = storeWrittenBeforeCompactRows.prepare("UPDATE elements SET body = ?, kind = 'box' WHERE board_id = ? AND element_id = ?");
  const boxIds = [...boardBeforeRestart?.elements.values() ?? []].flatMap((element) => (element.kind === 'box' ? [element.id] : []));
  const near = { side: 'bottom', gap: 30 } as const;
  const nearOfByBoxId = new Map([[boxIds[2] ?? '', boxIds[1] ?? ''], [boxIds[3] ?? '', boxIds[2] ?? '']]);
  const drawnBeforeRestart = new Map(layoutBoard(boardBeforeRestart ?? legacy.board).elements.flatMap((drawn) => (drawn.kind === 'box' ? [[drawn.id, drawn] as const] : [])));
  const expectedRectById = new Map(drawnBeforeRestart);
  for (const [boxId, targetId] of nearOfByBoxId) {
    const target = expectedRectById.get(targetId);
    const drawn = drawnBeforeRestart.get(boxId);
    assert.ok(target && drawn);
    const position = nearPosition(target, { of: targetId, ...near }, drawn);
    expectedRectById.set(boxId, { ...drawn, x: Math.round(position.x), y: Math.round(position.y) });
  }
  for (const element of boardBeforeRestart?.elements.values() ?? []) {
    const bodyBeforeFreeCanvas = element.id === firstBoxId ? { ...element, lane: null, column: null } : element;
    const targetId = nearOfByBoxId.get(element.id);
    const storedBody = targetId ? { ...bodyBeforeFreeCanvas, at: null, near: { of: targetId, ...near } } : bodyBeforeFreeCanvas;
    if (element.id === boxIds[3]) {
      const { id: _id, kind: _kind, ...compactBody } = storedBody;
      writeCompactRow.run(JSON.stringify(compactBody), 'legacy-board', element.id);
      continue;
    }
    writeJsonRow.run(JSON.stringify(storedBody), 'legacy-board', element.id);
  }
  const writeOldNoteRow = storeWrittenBeforeCompactRows.prepare('INSERT INTO elements (board_id, element_id, revision, body, kind) VALUES (?, ?, ?, ?, ?)');
  writeOldNoteRow.run('legacy-board', 'old-note', 1, JSON.stringify({ kind: 'note', id: 'old-note', on: firstBoxId, text: 'what about retries?', author: 'agent-a', resolvedBy: 'operator' }), null);
  writeOldNoteRow.run('legacy-board', 'old-compact-note', 1, JSON.stringify({ on: firstBoxId, text: 'and drafts', author: 'agent-b' }), 'note');
  writeOldNoteRow.run('legacy-board', 'old-blank-note', 1, JSON.stringify({ on: firstBoxId, text: '   ', author: 'agent-c' }), 'note');
  storeWrittenBeforeCompactRows.exec('PRAGMA user_version = 0');
  storeWrittenBeforeCompactRows.close();

  const restarted = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await restarted.loaded;
  const reloaded = await restarted.handleOperator.get('legacy-board');
  const oldNoteIds = ['old-note', 'old-compact-note', 'old-blank-note'];
  const oldNoteWireIds = oldNoteIds.map((noteId) => `${noteId}-to-${firstBoxId}`);
  assert.equal(reloaded.board?.elements.size, legacy.board.elements.size + 1 + oldNoteIds.length + oldNoteWireIds.length);
  const [upgradedNote, upgradedCompactNote, upgradedBlankNote] = oldNoteIds.map((noteId) => reloaded.board?.elements.get(noteId));
  assert.ok(upgradedNote?.kind === 'box' && upgradedCompactNote?.kind === 'box');
  assert.deepEqual([upgradedNote.shape, upgradedNote.title, (upgradedNote.lines ?? []).map((line) => [line.text, line.muted])], ['note', 'what about retries?', [['resolved by operator', true], ['from agent-a', true]]], 'an old resolved note upgrades to a note box keeping its text, resolver and author');
  assert.equal(upgradedCompactNote.shape, 'note');
  assert.equal(upgradedBlankNote?.kind === 'box' && upgradedBlankNote.title, 'Note', 'an old note of only spaces upgrades to a readable note box');
  assert.equal(upgradedCompactNote.at?.x, upgradedNote.at?.x);
  assert.ok((upgradedCompactNote.at?.y ?? 0) > (upgradedNote.at?.y ?? 0), 'old notes on one box stack down beside it');
  assert.deepEqual(oldNoteWireIds.map((wireId) => {
    const wire = reloaded.board?.elements.get(wireId);
    return wire?.kind === 'wire' ? [wire.from, wire.to, wire.dashed] : null;
  }), oldNoteIds.map((noteId) => [noteId, firstBoxId, true]), 'each old note is wired dashed to the box it was pinned to');
  const renamedBox = reloaded.board?.elements.get(firstBoxId);
  assert.equal(renamedBox?.kind === 'box' ? renamedBox.title : null, 'Renamed in sqlite');
  assert.equal(reloaded.board?.version, versionBeforeRestart);
  assert.deepEqual([...reloaded.board?.elements.keys() ?? []].filter((elementId) => !oldNoteIds.includes(elementId) && !oldNoteWireIds.includes(elementId)), [...boardBeforeRestart?.elements.keys() ?? []], 'a store written before compact rows keeps its element order after the upgrade');
  const drawnAfterRestart = new Map(layoutBoard(reloaded.board ?? legacy.board).elements.flatMap((drawn) => (drawn.kind === 'box' ? [[drawn.id, [drawn.x, drawn.y]] as const] : [])));
  const chainIds = [...nearOfByBoxId.keys()];
  assert.deepEqual(chainIds.map((boxId) => drawnAfterRestart.get(boxId)), chainIds.map((boxId) => [expectedRectById.get(boxId)?.x, expectedRectById.get(boxId)?.y]), 'a stored near chain is pinned where it was drawn, from a JSON row and from a compact row alike');

  const smallBoardId = (await restarted.handleOperator.create('Order')).summary?.id ?? '';
  const boxAt = (id: string) => ({ op: 'add', element: { kind: 'box', id, title: id, at: { x: 0, y: 0 } } });
  assert.equal((await restarted.handleOperator.put(smallBoardId, z.array(Op).parse([boxAt('a'), boxAt('b')]))).ok, true);
  const readded = await restarted.handleOperator.put(smallBoardId, z.array(Op).parse([boxAt('n'), { op: 'remove', id: 'b' }, boxAt('b'), { op: 'remove', id: 'a' }, boxAt('a')]));
  assert.equal(readded.ok, true, readded.error ?? '');
  assert.deepEqual([...(await restarted.handleOperator.get(smallBoardId)).board?.elements.keys() ?? []], ['n', 'b', 'a']);
  const reordered = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await reordered.loaded;
  assert.deepEqual([...(await reordered.handleOperator.get(smallBoardId)).board?.elements.keys() ?? []], ['n', 'b', 'a'], 'elements removed and added back in one put keep their new places after a restart');
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

test('a restart lists stored boards without reading their elements, answers a view sent before it finished loading, and a board with a damaged element row refuses only its own reads', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-lazy-'));
  const first = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await first.loaded;
  const boxOf = (id: string) => z.array(Op).parse([{ op: 'add', element: { kind: 'box', id, title: id, at: { x: 0, y: 0 } } }]);
  const damagedId = (await first.handleOperator.create('Damaged rows')).summary?.id ?? '';
  const healthyId = (await first.handleOperator.create('Healthy rows')).summary?.id ?? '';
  assert.equal((await first.handleOperator.put(damagedId, boxOf('a'))).ok, true);
  assert.equal((await first.handleOperator.put(healthyId, boxOf('b'))).ok, true);
  const database = new DatabaseSync(path.join(boardsRoot, 'boards.sqlite'));
  database.prepare('UPDATE elements SET body = ? WHERE board_id = ?').run('{ not json', damagedId);
  database.close();

  const restarted = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  const sentTypes: unknown[] = [];
  await restarted.tiles.view({ send: (message) => sentTypes.push(message.type) }, { boardId: healthyId, view: { x: -100, y: -100, width: 800, height: 600 }, lod: 'full', knownVersion: null });
  assert.deepEqual(sentTypes, ['whiteboard-tiles']);
  assert.deepEqual(restarted.snapshotMessage().boards.map((board) => board.title).sort(), ['Damaged rows', 'Healthy rows']);
  const damagedRead = await restarted.handleOperator.get(damagedId);
  assert.equal(damagedRead.ok, false);
  assert.match(damagedRead.error ?? '', /cannot be read/);
  assert.equal((await restarted.handleOperator.put(damagedId, boxOf('c'))).ok, false);
  assert.deepEqual([...(await restarted.handleOperator.get(healthyId)).board?.elements.keys() ?? []], ['b']);
});

test('an upgrade that cannot read a board keeps that board listed with its pictures, and a damaged elements page refuses only the boards it holds', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-upgrade-damage-'));
  const pictureAssetId = 'a'.repeat(64);
  const first = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await first.loaded;
  fs.mkdirSync(path.join(boardsRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(boardsRoot, 'assets', `${pictureAssetId}.png`), 'png');
  const picturesId = (await first.handleOperator.create('Pictures')).summary?.id ?? '';
  const healthyId = (await first.handleOperator.create('Healthy')).summary?.id ?? '';
  const damagedPageId = (await first.handleOperator.create('Damaged page')).summary?.id ?? '';
  assert.equal((await first.handleOperator.put(healthyId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'h', title: 'h', at: { x: 0, y: 0 } } }]))).ok, true);
  const databasePath = path.join(boardsRoot, 'boards.sqlite');
  const storeWrittenBeforeCompactRows = new DatabaseSync(databasePath);
  const insertJsonRow = storeWrittenBeforeCompactRows.prepare('INSERT INTO elements (board_id, element_id, revision, body) VALUES (?, ?, 1, ?)');
  insertJsonRow.run(picturesId, 'pictured', JSON.stringify({ kind: 'box', id: 'pictured', title: 'p', at: { x: 0, y: 0 }, media: { kind: 'image', asset: pictureAssetId, mime: 'image/png', width: 10, height: 10, alt: '', hasPreview: false } }));
  insertJsonRow.run(picturesId, 'unreadable', '{ not json');
  storeWrittenBeforeCompactRows.exec('BEGIN');
  for (let rowIndex = 0; rowIndex < 3000; rowIndex += 1) insertJsonRow.run(damagedPageId, `e${rowIndex}`, JSON.stringify({ kind: 'box', id: `e${rowIndex}`, title: 'x'.repeat(40), at: { x: rowIndex, y: 0 } }));
  storeWrittenBeforeCompactRows.exec('COMMIT');
  storeWrittenBeforeCompactRows.exec('PRAGMA user_version = 0');
  storeWrittenBeforeCompactRows.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const lastElementsPage = storeWrittenBeforeCompactRows.prepare("SELECT pageno FROM dbstat WHERE name = 'elements' AND pagetype = 'leaf' ORDER BY pageno DESC LIMIT 1").get();
  const pageSize = Number(storeWrittenBeforeCompactRows.prepare('PRAGMA page_size').get()?.['page_size']);
  storeWrittenBeforeCompactRows.close();
  const databaseHandle = fs.openSync(databasePath, 'r+');
  fs.writeSync(databaseHandle, Buffer.alloc(pageSize, 0xab), 0, pageSize, (Number(lastElementsPage?.['pageno']) - 1) * pageSize);
  fs.closeSync(databaseHandle);

  const restarted = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await restarted.loaded;
  assert.deepEqual(restarted.snapshotMessage().boards.map((board) => board.title).sort(), ['Damaged page', 'Healthy', 'Pictures']);
  assert.equal(fs.existsSync(path.join(boardsRoot, 'assets', `${pictureAssetId}.png`)), true);
  assert.equal((await restarted.handleOperator.get(picturesId)).ok, false);
  assert.deepEqual([...(await restarted.handleOperator.get(healthyId)).board?.elements.keys() ?? []], ['h']);
});

test('a session closing while its board loads after a restart keeps the loaded elements', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-store-close-during-load-'));
  const first = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await first.loaded;
  const created = await first.handleAgent({ id: 'closing-agent', name: 'closing', project: boardsRoot }, { sub: 'new', title: 'Shared plan' });
  assert.equal(created.body.ok, true);
  const boardId = first.snapshotMessage().boards[0]?.id ?? '';
  const boxes = Array.from({ length: 2000 }, (_, index) => ({ op: 'add', element: { kind: 'box', id: `box-${index}`, title: `box ${index}`, at: { x: index * 300, y: 0 } } }));
  assert.equal((await first.handleOperator.connect(boardId, 'staying-agent')).ok, true);
  assert.equal((await first.handleOperator.put(boardId, z.array(Op).parse(boxes))).ok, true);

  const restarted = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await restarted.loaded;
  const firstRead = restarted.handleOperator.get(boardId);
  await new Promise((resolve) => setImmediate(resolve));
  await restarted.forgetSession('closing-agent');
  assert.equal((await firstRead).board?.elements.size, 2000);
  assert.equal((await restarted.handleOperator.get(boardId)).board?.elements.size, 2000);
});

test('a restart draws a viewed board from its saved layout and edits it without laying it out again, and a layout saved by other code, for a lost edit, or unreadable is laid out again', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-layout-cache-'));
  const cachePath = path.join(boardsRoot, 'layout-cache.sqlite');
  const boardView = { view: { x: -200, y: -200, width: 4000, height: 3000 }, lod: 'full' as const, knownVersion: null };
  const tilesSeenBy = async (wiring: ReturnType<typeof createWhiteboardWiring>, boardId: string): Promise<unknown[]> => {
    const sent: unknown[] = [];
    await wiring.loaded;
    await wiring.tiles.view({ send: (message) => sent.push(message.type === 'whiteboard-tiles' ? { version: message.version, chrome: message.chrome, tiles: message.tiles } : message.type) }, { boardId, ...boardView });
    return sent;
  };
  const restartIn = (root: string) => createWhiteboardWiring({ boardsRoot: root, logger: { warn: () => {} } });
  const boxesFrom = (first: number, count: number) => z.array(Op).parse(Array.from({ length: count }, (_, index) => ({ op: 'add', element: { kind: 'box', id: `box-${first + index}`, title: `box ${first + index}`, at: { x: (first + index) * 260, y: 0 } } })));
  const retitle = (id: string, title: string) => z.array(Op).parse([{ op: 'set', id, fields: { title } }]);
  const editCache = (sql: string) => {
    const cache = new DatabaseSync(cachePath, { timeout: 5000 });
    cache.exec(sql);
    cache.close();
  };
  const isSavedLayoutWritten = (): boolean => {
    try {
      const cache = new DatabaseSync(cachePath, { readOnly: true });
      const head = cache.prepare(`SELECT count(*) AS heads FROM layout_head WHERE code_stamp != 'older layout code'`).get();
      cache.close();
      return Number(head?.heads ?? 0) > 0;
    } catch {
      return false;
    }
  };
  const savedLayoutWritten = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400 && !isSavedLayoutWritten(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(isSavedLayoutWritten(), true);
  };
  const copyFiles = (fromRoot: string, toRoot: string, filename: string) => {
    for (const suffix of ['', '-wal']) {
      if (fs.existsSync(path.join(fromRoot, `${filename}${suffix}`))) fs.copyFileSync(path.join(fromRoot, `${filename}${suffix}`), path.join(toRoot, `${filename}${suffix}`));
    }
  };

  const first = restartIn(boardsRoot);
  await first.loaded;
  const boardId = (await first.handleOperator.create('Cached plan')).summary?.id ?? '';
  assert.equal((await first.handleOperator.put(boardId, boxesFrom(0, 2000))).ok, true);
  const drawnBeforeRestart = await tilesSeenBy(first, boardId);
  await savedLayoutWritten();
  const writeAheadLogBytes = (filename: string): number => (fs.existsSync(path.join(boardsRoot, `${filename}-wal`)) ? fs.statSync(path.join(boardsRoot, `${filename}-wal`)).size : 0);
  for (let attempt = 0; attempt < 400 && writeAheadLogBytes('boards.sqlite') + writeAheadLogBytes('layout-cache.sqlite') > 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual([writeAheadLogBytes('boards.sqlite'), writeAheadLogBytes('layout-cache.sqlite')], [0, 0], 'a bulk save leaves no write-ahead log for the next start to copy again');

  const restarted = restartIn(boardsRoot);
  assert.deepEqual(await tilesSeenBy(restarted, boardId), drawnBeforeRestart);
  editCache(`UPDATE placed SET body = json_set(body, '$.element.x', 1800) WHERE element_id = 'box-1'`);
  assert.match(JSON.stringify(await tilesSeenBy(restartIn(boardsRoot), boardId)), /"x":1800/);
  editCache(`UPDATE layout_head SET code_stamp = 'older layout code'`);
  assert.deepEqual(await tilesSeenBy(restartIn(boardsRoot), boardId), drawnBeforeRestart);
  await savedLayoutWritten();

  const storeBeforeLostEdit = fs.mkdtempSync(path.join(os.tmpdir(), 'whiteboard-layout-cache-lost-'));
  copyFiles(boardsRoot, storeBeforeLostEdit, 'boards.sqlite');
  const editing = restartIn(boardsRoot);
  assert.equal((await editing.handleOperator.put(boardId, retitle('box-1', 'lost edit'))).ok, true);
  await tilesSeenBy(editing, boardId);
  copyFiles(boardsRoot, storeBeforeLostEdit, 'layout-cache.sqlite');
  const afterLostEdit = restartIn(storeBeforeLostEdit);
  await afterLostEdit.loaded;
  assert.equal((await afterLostEdit.handleOperator.put(boardId, retitle('box-0', 'kept edit'))).ok, true);
  const drawnAfterLostEdit = JSON.stringify(await tilesSeenBy(afterLostEdit, boardId));
  assert.match(drawnAfterLostEdit, /kept edit/);
  assert.doesNotMatch(drawnAfterLostEdit, /lost edit/);

  assert.equal((await editing.handleOperator.put(boardId, boxesFrom(2000, 2))).ok, true);
  assert.equal((await editing.handleOperator.put(boardId, retitle('box-1', 'renamed after restart'))).ok, true);
  const drawnFromCache = await tilesSeenBy(restartIn(boardsRoot), boardId);
  fs.writeFileSync(cachePath, 'not a database');
  const drawnFromFullLayout = await tilesSeenBy(restartIn(boardsRoot), boardId);
  await savedLayoutWritten();
  assert.deepEqual(drawnFromCache, drawnFromFullLayout);
  assert.match(JSON.stringify(drawnFromCache), /renamed after restart/);

  editCache(`UPDATE placed SET body = json_set(body, '$.element.x', 1800) WHERE element_id = 'box-3'`);
  const resuming = restartIn(boardsRoot);
  await resuming.loaded;
  assert.equal((await resuming.handleOperator.put(boardId, retitle('box-7', 'put after restart'))).ok, true);
  const drawnAfterResumedPut = JSON.stringify(await tilesSeenBy(resuming, boardId));
  assert.match(drawnAfterResumedPut, /put after restart/);
  assert.match(drawnAfterResumedPut, /"x":1800/);
});
