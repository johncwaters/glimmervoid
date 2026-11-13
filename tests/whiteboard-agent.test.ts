import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import type { Server } from 'node:http';
import { z } from 'zod';

import { createBackend } from '../server/backend/backend.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { Board, BOARD_PAGE_ESCAPE_MESSAGE, BOARD_PAGE_GESTURE_MESSAGE, BOARD_PAGE_PARAMS_MESSAGE, BoardOutline, BoardRegion, BoxMedia, Element, Op, pointOfBox, sparseElement, WHITEBOARD_LIMITS } from '../shared/contracts/whiteboard.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { Backend } from './helpers/lanes.ts';
import { agentIngressBase, settleBackendShutdown } from './helpers/lanes.ts';
import { createWhiteboardWiring } from '../server/whiteboard/whiteboard-wiring.ts';
import { createTaskTitleRefiner } from '../server/task-title-refiner.ts';
import { createBoardStore } from '../server/whiteboard/board-store-client.ts';
import { planSteps } from '../shared/whiteboard-plan-core.ts';
import { boardIndexOf, copyOfElements, dropElement } from '../shared/whiteboard-board-index.ts';
import { layoutBoard } from '../shared/whiteboard-layout-core.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import { resolveFfmpegPath, stableLauncherPath } from '../server/runtime-paths.ts';
import { waitFor } from './helpers/wait-for.ts';

const PLANNER_ID = 'whiteboard-planner';
const BUILDER_ID = 'whiteboard-builder';
const LEAVER_ID = 'whiteboard-leaver';

interface BootedBackend {
  server: Server;
  backend: Backend;
  base: string;
  agentBase: string;
}

const fixture: { tmpDir: string; configPath: string; prevEnv: string | undefined; booted: BootedBackend | null } = {
  tmpDir: '', configPath: '', prevEnv: undefined, booted: null,
};

async function boot(): Promise<BootedBackend> {
  process.env.GLIMMERVOID_CONFIG = fixture.configPath;
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  return { server, backend, base: `http://127.0.0.1:${boundPort(server)}`, agentBase: await agentIngressBase(backend) };
}

async function shutDown(booted: BootedBackend | null): Promise<void> {
  if (!booted) return;
  await settleBackendShutdown(booted.backend);
  booted.server.closeAllConnections();
  await closeServer(booted.server);
}

function running(): BootedBackend {
  if (!fixture.booted) throw new Error('the backend was never booted');
  return fixture.booted;
}

async function whiteboard(sessionId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { agentBase, backend } = running();
  const token = backend.getSession(sessionId)?.agentToken;
  assert.ok(token, `${sessionId} was minted an agent token`);
  const response = await fetch(`${agentBase}/agent/${sessionId}/whiteboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const reply: Record<string, unknown> = await response.json();
  assert.ok(AGENT_REPLY_SCHEMAS.whiteboard.safeParse(reply).success, `the reply keeps its contract: ${JSON.stringify(reply)}`);
  return { status: response.status, body: reply };
}

function pointOfStored(element: Record<string, unknown> | undefined): unknown {
  const place = element?.place;
  return typeof place === 'object' && place !== null && 'at' in place ? place.at : null;
}

async function boardOf(sessionId: string, boardId: string) {
  const reply = await whiteboard(sessionId, { sub: 'get', board: boardId });
  assert.equal(reply.status, 200);
  const body = reply.body as { board: unknown; changes: { summary: string }[] };
  const parsed = Board.parse(body.board);
  const board: { version: number; elements: Record<string, Record<string, unknown>> } = { ...parsed, elements: parsed.elements.toJSON() };
  return { ...body, board };
}

async function newBoard(title: string): Promise<string> {
  const created = await whiteboard(PLANNER_ID, { sub: 'new', title });
  assert.equal(created.status, 200);
  const board = created.body.board as { id: string };
  return board.id;
}

test.before(async () => {
  fixture.prevEnv = process.env.GLIMMERVOID_CONFIG;
  fixture.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-whiteboard-'));
  const projects = [PLANNER_ID, BUILDER_ID, LEAVER_ID].map((id) => {
    const projectDir = path.join(fixture.tmpDir, id);
    fs.mkdirSync(projectDir);
    return { id, name: id, path: projectDir };
  });
  fixture.configPath = path.join(fixture.tmpDir, 'config.json');
  fs.writeFileSync(fixture.configPath, JSON.stringify({ projects, repoRoots: [], autoResume: false }, null, 2), 'utf8');
  fixture.booted = await boot();
});

test.after(async () => {
  await shutDown(fixture.booted);
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  if (fixture.prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
  if (fixture.prevEnv != null) process.env.GLIMMERVOID_CONFIG = fixture.prevEnv;
});

test('an agent builds a board of boxes, wires, frames, notes and boxes marked added, and removing a box takes its wires but leaves the note boxes about it', async () => {
  const boardId = await newBoard('knowledge writer');
  const built = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 234 } }, lines: [{ text: 'reads the feed' }, { text: 'skips drafts', muted: true }] } },
    { op: 'add', element: { kind: 'box', id: 'store', title: 'Store', place: { at: { x: 350, y: 110 } } } },
    { op: 'add', element: { kind: 'box', id: 'later', title: 'Later', place: { near: { of: 'store', side: 'bottom', gap: 30 } }, change: 'added' } },
    { op: 'add', element: { kind: 'wire', id: 'w1', from: 'parse', to: 'store', dashed: true, label: 'on retry' } },
    { op: 'add', element: { kind: 'frame', id: 'core', title: 'Core', contains: ['parse', 'store'] } },
    { op: 'add', element: { kind: 'box', id: 'n1', shape: 'note', title: 'what about retries?', place: { at: { x: 594, y: 110 } } } },
    { op: 'add', element: { kind: 'wire', id: 'n1-to-store', from: 'n1', to: 'store', dashed: true } },
    { op: 'add', element: { kind: 'box', id: 'aside', shape: 'note', title: 'retry budget?', place: { at: { x: 700, y: 500 } } } },
    { op: 'set', id: 'parse', fields: { place: { at: { x: 40, y: 234 } } } },
  ] });
  assert.equal(built.status, 200);
  assert.equal(built.body.warnings, undefined);

  const blocked = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'later', fields: { place: { at: { x: 250, y: 110 } } } }] });
  assert.equal(blocked.status, 200);
  assert.ok((blocked.body.warnings as string[] | undefined)?.includes('wire w1 runs through box later'), JSON.stringify(blocked.body));

  const removed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'remove', id: 'store' }] });
  assert.equal(removed.status, 200);
  const { board } = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(Object.keys(board.elements).sort(), ['aside', 'core', 'later', 'n1', 'parse']);
  assert.equal(board.elements.aside?.shape, 'note');
  assert.deepEqual([board.elements.aside?.author, board.elements.aside?.lines ?? []], [PLANNER_ID, []], 'a note box an agent adds carries its author and keeps its lines its own');
  assert.deepEqual(board.elements.core?.contains, ['parse']);
  assert.deepEqual(board.elements.parse?.place, { at: { x: 40, y: 234 } });
  assert.equal(board.elements.later?.change, 'added');
});

test('two writers keep both different fields, the later write of one field wins, and the overwritten writer gets every change to the element in one line', async () => {
  const boardId = await newBoard('shared edits');
  assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);
  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } } } }] });
  await boardOf(PLANNER_ID, boardId);
  await boardOf(BUILDER_ID, boardId);

  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { title: 'Parse feed' } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { lines: [{ text: 'by the builder' }] } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { title: 'Parse and store' } }] });

  const plannerView = await boardOf(PLANNER_ID, boardId);
  assert.equal(plannerView.board.elements.parse?.title, 'Parse and store');
  assert.deepEqual(plannerView.board.elements.parse?.lines, [{ text: 'by the builder', muted: false, style: 'text', key: null }]);
  assert.deepEqual(plannerView.changes.map((change) => change.summary), [
    `${BUILDER_ID} changed lines of "Parse feed"; ${BUILDER_ID} renamed "Parse feed" to "Parse and store"`,
  ]);
  assert.deepEqual((await boardOf(PLANNER_ID, boardId)).changes, [], 'a get marks the summaries read');

  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'n1', shape: 'note', title: 'keep prod', place: { at: { x: 400, y: 400 } } } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'n1', fields: { title: 'drop prod' } }] });
  const rewritten = (await boardOf(PLANNER_ID, boardId)).board.elements.n1;
  assert.deepEqual([rewritten?.title, rewritten?.author], ['drop prod', BUILDER_ID], 'a rewritten note is signed by its rewriter');

  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'n1', fields: { author: 'operator' } }] });
  assert.equal((await boardOf(PLANNER_ID, boardId)).board.elements.n1?.author, BUILDER_ID, 'an agent cannot sign a note as someone else');

  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'n1', fields: { tone: 'pink' } }] });
  assert.equal((await boardOf(PLANNER_ID, boardId)).board.elements.n1?.author, PLANNER_ID, 'any agent edit signs the note, not only a text edit');
});

test('a malformed or over-limit put is refused whole with a reason and the board is unchanged', async () => {
  const boardId = await newBoard('refusals');
  const before = await boardOf(PLANNER_ID, boardId);

  const strandedBox = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'ok', title: 'Fine', place: { at: { x: 40, y: 40 } } } },
    { op: 'add', element: { kind: 'box', id: 'lost', title: 'Lost' } },
  ] });
  assert.equal(strandedBox.status, 400);
  assert.match(String(strandedBox.body.error), /a box needs a place/);

  const gridOps = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'columns', columns: [{ id: 'intake', title: 'Intake' }] }] });
  assert.equal(gridOps.status, 400);

  const tooMany = Array.from({ length: WHITEBOARD_LIMITS.opsPerPut + 1 }, (_, index) => ({ op: 'add', element: { kind: 'box', id: `b${index}`, title: 'Box', place: { at: { x: 40, y: 40 } } } }));
  const overLimit = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: tooMany });
  assert.equal(overLimit.status, 400);
  assert.match(String(overLimit.body.error), new RegExp(`at most ${WHITEBOARD_LIMITS.opsPerPut} ops`));

  const overfullNote = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'n1', shape: 'note', title: 'mine', place: { at: { x: 40, y: 40 } }, lines: Array.from({ length: WHITEBOARD_LIMITS.linesPerBox + 1 }, () => ({ text: 'pad' })) } },
  ] });
  assert.equal(overfullNote.status, 400);
  assert.match(String(overfullNote.body.error), new RegExp(`a box holds at most ${WHITEBOARD_LIMITS.linesPerBox} lines`));

  const unnamedRename = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'renamed', title: 'New name', place: { at: { x: 40, y: 40 } }, change: 'relabeled' } },
  ] });
  assert.equal(unnamedRename.status, 400);
  assert.match(String(unnamedRename.body.error), /box renamed is relabeled, so give its old title in was/);

  const after = await boardOf(PLANNER_ID, boardId);
  assert.equal(after.board.version, before.board.version);
  assert.deepEqual(after.board.elements, {});
});

test('a put larger than other agent requests but inside the put limit lands, and one past the limit gets a reason', async () => {
  const boardId = await newBoard('big puts');
  const line = { text: 'x'.repeat(WHITEBOARD_LIMITS.line) };
  const boxesOf = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
    op: 'add', element: { kind: 'box', id: `${prefix}${index}`, title: 'Box', place: { at: { x: 40, y: 40 } }, lines: Array.from({ length: WHITEBOARD_LIMITS.linesPerBox }, () => line) },
  }));

  const bytesPerOp = Buffer.byteLength(JSON.stringify(Op.array().parse(boxesOf(1, 'a0000'))));
  const inside = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: boxesOf(Math.floor(WHITEBOARD_LIMITS.putBytes / bytesPerOp) - 1, 'a') });
  assert.equal(inside.status, 200);

  const past = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: boxesOf(Math.ceil(WHITEBOARD_LIMITS.putBytes / bytesPerOp) + 1, 'b') });
  assert.equal(past.status, 413);
  assert.match(String(past.body.error), /nothing changed/);
});

test('the operator deletes a board from the dashboard and a connected agent is told it was deleted', async () => {
  const boardId = await newBoard('short lived');
  const client = await dashboardClient(boundPort(running().server));
  const control = await openRecordingSocket<{ type: string; requestId?: string; ok?: boolean; boardId?: string }>(client);
  control.ws.send(JSON.stringify({ type: 'whiteboard-delete', boardId, requestId: 'delete-1' }));
  const deleted = await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-result' && frame.requestId === 'delete-1', 'the delete reply');
  assert.equal(deleted.ok, true);
  await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-removed' && frame.boardId === boardId, 'the removal broadcast');
  await closeSocket(control.ws);

  const afterDelete = await whiteboard(PLANNER_ID, { sub: 'get', board: boardId });
  assert.equal(afterDelete.status, 404);
  assert.equal(afterDelete.body.error, 'that board was deleted');
});

test('a dashboard viewing one region of a board past the incremental layout floor gets only the elements there, then a diff naming each edit that touches it with its record, including a box moved in from far away', async () => {
  const boardId = await newBoard('streamed region');
  const fillerBoxCount = 2000;
  const placed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    ...Array.from({ length: fillerBoxCount }, (_, fillerIndex) => ({ op: 'add', element: { kind: 'box', id: `filler-${fillerIndex}`, title: 'Filler', place: { at: { x: (fillerIndex % 50) * 300, y: 100000 + Math.floor(fillerIndex / 50) * 200 } } } })),
    { op: 'add', element: { kind: 'box', id: 'near', title: 'Near', place: { at: { x: 0, y: 0 } } } },
    { op: 'add', element: { kind: 'box', id: 'far', title: 'Far', place: { at: { x: 0, y: 0 } } } },
    { op: 'set', id: 'near', fields: { place: { at: { x: 40, y: 80 } } } },
    { op: 'set', id: 'far', fields: { place: { at: { x: 40000, y: 80 } } } },
  ] });
  assert.equal(placed.status, 200);
  type TileFrame = { type: string; boardId?: string; version?: number; fromVersion?: number; chrome?: unknown; tiles?: { elements: { element: { id: string } }[] }[]; diff?: { changed: { element: { id: string; titleLines?: string[]; x?: number }; record?: { title?: string } }[]; removedIds: string[] } };
  const client = await dashboardClient(boundPort(running().server));
  const control = await openRecordingSocket<TileFrame>(client);
  try {
    control.ws.send(JSON.stringify({ type: 'whiteboard-view', boardId, view: { x: 0, y: 0, width: 1200, height: 800 }, lod: 'full', knownVersion: null }));
    const tiles = await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tiles' && frame.boardId === boardId, 'the first tiles');
    assert.notEqual(tiles.chrome, null);
    const shownIds = new Set(tiles.tiles?.flatMap((tile) => tile.elements.map((painted) => painted.element.id)));
    assert.ok(shownIds.has('near'));
    assert.equal(shownIds.has('far'), false);

    const renamed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'near', fields: { title: 'Near now' } }, { op: 'set', id: 'far', fields: { title: 'Far now' } }] });
    assert.equal(renamed.status, 200);
    const renameDiff = await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tile-diff' && frame.fromVersion === tiles.version, 'the rename diff');
    assert.deepEqual(renameDiff.diff?.changed.map((painted) => [painted.element.id, painted.element.titleLines?.join(' '), painted.record?.title]), [['near', 'Near now', 'Near now']]);

    const movedIn = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'far', fields: { place: { at: { x: 400, y: 300 } } } }] });
    assert.equal(movedIn.status, 200);
    const moveDiff = await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tile-diff' && frame.fromVersion === renamed.body.version, 'the move diff');
    assert.deepEqual(moveDiff.diff?.changed.map((painted) => [painted.element.id, painted.element.x]), [['far', 400]]);
  } finally {
    await closeSocket(control.ws);
  }
});

test('an agent reads a board too large to return whole as an outline with the operator view in full, moves its own focus, and pages the rest by region, ids and text', async () => {
  const boardId = await newBoard('large outline');
  const gridBoxCount = WHITEBOARD_LIMITS.readPage + 60;
  const gridBoxes = Array.from({ length: gridBoxCount }, (_, boxIndex) => ({ op: 'add', element: { kind: 'box', id: `cell-${boxIndex}`, title: `Cell ${boxIndex}`, place: { at: { x: (boxIndex % 20) * 300, y: (boxIndex % 13) * 200 + Math.floor(boxIndex / 260) * 3000 } } } }));
  const placed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [...gridBoxes, { op: 'add', element: { kind: 'box', id: 'far-away', title: 'Zebra lantern', place: { at: { x: 60000, y: 40 } } } }] });
  assert.equal(placed.status, 200);
  const ElementPage = z.object({ elements: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() });
  const OutlineRead = ElementPage.extend({ outline: BoardOutline, focus: BoardRegion });
  const idsOf = (reply: { body: Record<string, unknown> }) => ElementPage.parse(reply.body).elements.map((element) => element.id);
  const focusOf = (reply: { body: Record<string, unknown> }) => OutlineRead.parse(reply.body).focus;

  const firstRead = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId });
  const outline = OutlineRead.parse(firstRead.body);
  assert.equal(outline.outline.elementCount, gridBoxCount + 1);
  assert.equal(idsOf(firstRead).includes('far-away'), false);
  assert.ok(outline.outline.clustersOutsideFocus.some((cluster) => cluster.titles.includes('Zebra lantern')));

  const operatorView = { x: 59000, y: -200, width: 2000, height: 1200 };
  const client = await dashboardClient(boundPort(running().server));
  const control = await openRecordingSocket<{ type: string; boardId?: string }>(client);
  try {
    control.ws.send(JSON.stringify({ type: 'whiteboard-view', boardId, view: operatorView, lod: 'full', knownVersion: null }));
    await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tiles' && frame.boardId === boardId, 'the operator view tiles');
    const operatorRead = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId });
    assert.deepEqual(focusOf(operatorRead), operatorView);
    assert.deepEqual(idsOf(operatorRead), ['far-away']);

    const gridRegion = { x: -100, y: -100, width: 7000, height: 6000 };
    const gridFirstPage = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId, region: gridRegion });
    const gridCursor = ElementPage.parse(gridFirstPage.body).nextCursor;
    assert.ok(gridCursor);
    control.received.length = 0;
    control.ws.send(JSON.stringify({ type: 'whiteboard-view', boardId, view: { ...operatorView, y: 0 }, lod: 'full', knownVersion: null }));
    await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tiles' && frame.boardId === boardId, 'the panned view tiles');
    const gridSecondPage = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId, cursor: gridCursor });
    assert.deepEqual(focusOf(gridSecondPage), gridRegion);
    assert.equal(new Set([...idsOf(gridFirstPage), ...idsOf(gridSecondPage)]).size, gridBoxCount);

    const ownFocus = { x: 0, y: 0, width: 700, height: 300 };
    await whiteboard(BUILDER_ID, { sub: 'get', board: boardId, region: ownFocus });
    const keptRead = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId });
    assert.deepEqual(focusOf(keptRead), ownFocus);
    assert.ok(idsOf(keptRead).includes('cell-0'));

    const movedView = { ...operatorView, x: 58000 };
    control.received.length = 0;
    control.ws.send(JSON.stringify({ type: 'whiteboard-view', boardId, view: movedView, lod: 'full', knownVersion: null }));
    await waitForMessage(control.received, (frame) => frame.type === 'whiteboard-tiles' && frame.boardId === boardId, 'the moved view tiles');
    const followedRead = await whiteboard(BUILDER_ID, { sub: 'get', board: boardId });
    assert.deepEqual(focusOf(followedRead), movedView);
  } finally {
    await closeSocket(control.ws);
  }

  const byText = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, text: 'zebra' });
  assert.deepEqual(idsOf(byText), ['far-away']);
  const byIds = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, ids: ['cell-3', 'not-there'] });
  assert.deepEqual([idsOf(byIds), byIds.body.missingIds], [['cell-3'], ['not-there']]);
  const wholeRegion = { x: -1000, y: -1000, width: 100000, height: 10000 };
  const firstPage = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, region: wholeRegion });
  assert.equal(idsOf(firstPage).length, WHITEBOARD_LIMITS.readPage);
  const secondPage = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, region: wholeRegion, cursor: ElementPage.parse(firstPage.body).nextCursor });
  assert.equal(secondPage.body.nextCursor, null);
  assert.equal(new Set([...idsOf(firstPage), ...idsOf(secondPage)]).size, gridBoxCount + 1);
  const editedBetweenPages = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'cell-1', fields: { title: 'Cell one' } }] });
  assert.equal(editedBetweenPages.status, 200);
  const staleCursorPage = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, region: wholeRegion, cursor: ElementPage.parse(firstPage.body).nextCursor });
  assert.equal(staleCursorPage.status, 409);

  const longLine = 'word '.repeat(24).trim();
  const heavyBoxes = Array.from({ length: 40 }, (_, boxIndex) => ({ op: 'add', element: { kind: 'box', id: `heavy-${boxIndex}`, title: `Heavy ${boxIndex}`, lines: Array.from({ length: WHITEBOARD_LIMITS.linesPerBox }, () => ({ text: longLine })), place: { at: { x: 90000 + (boxIndex % 8) * 1000, y: Math.floor(boxIndex / 8) * 1000 } } } }));
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: heavyBoxes })).status, 200);
  const heavyPage = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, region: { x: 89000, y: -1000, width: 10000, height: 7000 } });
  const heavyElements = z.array(Element).parse(heavyPage.body.elements);
  assert.ok(ElementPage.parse(heavyPage.body).nextCursor);
  assert.ok(heavyElements.length < 40);
  assert.ok(JSON.stringify(heavyElements.map(sparseElement)).length <= WHITEBOARD_LIMITS.readPageChars + 2 * heavyElements.length);

  const twoCriteria = await whiteboard(BUILDER_ID, { sub: 'query', board: boardId, text: 'zebra', ids: ['cell-3'] });
  assert.equal(twoCriteria.status, 400);
});

test('a session deletes a board of its project and is refused a board of another project', async () => {
  const boardId = await newBoard('agent made');
  const refused = await whiteboard(BUILDER_ID, { sub: 'delete', board: boardId });
  assert.equal(refused.status, 403);
  assert.equal((await whiteboard(BUILDER_ID, { sub: 'get', board: boardId })).status, 200);

  const deleted = await whiteboard(PLANNER_ID, { sub: 'delete', board: boardId });
  assert.equal(deleted.status, 200);
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'get', board: boardId })).body.error, 'that board was deleted');
});

async function runPlannerCli(context: test.TestContext, args: string[]): Promise<{ exitCode: number; printed: string }> {
  const { agentBase, backend } = running();
  const printedLines: string[] = [];
  context.mock.method(console, 'log', (line: string) => { printedLines.push(line); });
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  process.env[AGENT_URL_ENV] = `${agentBase}/agent/${PLANNER_ID}?t=${backend.getSession(PLANNER_ID)?.agentToken ?? ''}`;
  try {
    const exitCode = await runAgentApiCli(args);
    return { exitCode, printed: printedLines.join('\n') };
  } finally {
    context.mock.restoreAll();
    if (previousAgentUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousAgentUrl !== undefined) process.env[AGENT_URL_ENV] = previousAgentUrl;
  }
}

test('an agent plans steps through the CLI in dependency order and a circular plan keeps every label', async (context) => {
  const boardId = await newBoard('search api');
  const plan = (...args: string[]) => runPlannerCli(context, ['whiteboard', 'plan', ...args]);

  assert.equal((await plan('add', boardId, 'Diff index schema')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Search endpoint', '--after', 'diff-index-schema')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Index backfill', '--after', 'diff-index-schema')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Search box')).exitCode, 0);
  assert.equal((await plan('after', boardId, 'search-box', 'search-endpoint')).exitCode, 0);

  const clash = await plan('add', boardId, 'Search box');
  assert.equal(clash.exitCode, 1);
  assert.match(clash.printed, /already exists/);
  assert.equal((await plan('add', boardId, 'Search box', '--id', 'search-box-2')).exitCode, 0);

  assert.equal((await plan('after', boardId, 'diff-index-schema', 'search-box')).exitCode, 0);
  const circular = await plan('show', boardId);
  assert.equal(circular.exitCode, 0);
  assert.deepEqual(circular.printed.split('\n').slice(1, 6).map((line) => /^\d+[a-z]?\d* /.test(line)), [true, true, true, true, true], circular.printed);
  assert.equal((await plan('after', boardId, 'diff-index-schema')).exitCode, 0);

  assert.match((await plan('after', boardId, 'search-box', 'search-box')).printed, /cannot come after itself/);
  const builderEdit = await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'builder-box', title: 'Builder box', place: { at: { x: 0, y: 900 } } } }] });
  assert.equal(builderEdit.status, 200);
  assert.match((await plan('after', boardId, 'search-box', 'builder-box')).printed, /builder-box is not a plan step/);
  assert.equal((await plan('status', boardId, 'diff-index-schema', 'shipped')).exitCode, 1);
  assert.equal((await plan('status', boardId, 'diff-index-schema', 'landed')).exitCode, 0);
  assert.equal((await plan('status', boardId, 'index-backfill', 'building')).exitCode, 0);

  const shown = await plan('show', 'search', 'api');
  assert.equal(shown.exitCode, 0);
  const planLines = shown.printed.split('\n').slice(1, 6).map((line) => line.replace(/ +/g, ' ').trim());
  assert.deepEqual(planLines, [
    '1a diff-index-schema landed Diff index schema',
    '1b search-box-2 planned Search box',
    '2a index-backfill building Index backfill after 1a',
    '2b search-endpoint planned Search endpoint after 1a',
    '3 search-box planned Search box after 2b',
  ]);
  assert.match(shown.printed, /Builder box/, 'plan commands leave changes others made unread until plan show prints them');

  const removed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'remove', id: 'search-endpoint' }] });
  assert.equal(removed.status, 200);
  const wiresIntoSearchBox = Object.values((await boardOf(PLANNER_ID, boardId)).board.elements).filter((element) => element.kind === 'wire' && element.to === 'search-box');
  assert.deepEqual(wiresIntoSearchBox, []);
});

test('an agent puts ops from a file, reads the laid-out positions and renders the board to an SVG file, and neither read consumes changes others made', async (context) => {
  const boardId = await newBoard('see it');
  const opsPath = path.join(fixture.tmpDir, 'see-it-ops.json');
  fs.writeFileSync(opsPath, JSON.stringify([
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse <feed>', place: { at: { x: 40, y: 40 } } } },
    { op: 'add', element: { kind: 'box', id: 'save', title: 'Save', place: { at: { x: 350, y: 40 } } } },
    { op: 'add', element: { kind: 'wire', id: 'w1', from: 'parse', to: 'save', label: 'rows' } },
    { op: 'add', element: { kind: 'box', id: 'index', title: 'Index rows', place: { near: { of: 'save', side: 'bottom', gap: 30 } }, change: 'relabeled', was: 'Cache rows' } },
  ]));
  const cli = (...args: string[]) => runPlannerCli(context, ['whiteboard', ...args]);

  assert.equal((await cli('put', boardId, '--file', opsPath)).exitCode, 0);
  const builderEdit = await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'save', fields: { title: 'Save rows' } }] });
  assert.equal(builderEdit.status, 200);

  const laidOut = await cli('get', boardId, '--layout');
  assert.equal(laidOut.exitCode, 0);
  const layout = JSON.parse(laidOut.printed) as { elements: { id: string; x: number; width: number }[]; wires: { id: string; points: { x: number }[] }[] };
  const parse = layout.elements.find((element) => element.id === 'parse');
  const save = layout.elements.find((element) => element.id === 'save');
  assert.ok(parse && save && parse.x + parse.width < save.x, laidOut.printed);
  assert.ok((layout.wires.find((wire) => wire.id === 'w1')?.points.length ?? 0) >= 2, laidOut.printed);

  const svgPath = path.join(fixture.tmpDir, 'see-it.svg');
  assert.equal((await cli('render', boardId, '--out', svgPath)).exitCode, 0);
  const svgText = fs.readFileSync(svgPath, 'utf8');
  assert.match(svgText, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svgText, /Parse &lt;feed&gt;/);
  assert.match(svgText, /data-element-id="w1"/);
  assert.match(svgText, /class="wb-element wb-box wb-change-relabeled"/);
  assert.match(svgText, /class="wb-box-was"[^>]*>Cache rows</);
  assert.match(svgText, /renamed, old title struck through/);

  const { changes } = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(changes.map((change) => change.summary), [`${BUILDER_ID} renamed "Save" to "Save rows"`]);
});

test('an agent attaches media once by content at full fidelity, a box shows it from the served original with ranges, and a put naming an unstored asset or an oversized attach is refused', async (context) => {
  const { default: sharp } = await import('sharp');
  const plannerDir = path.join(fixture.tmpDir, PLANNER_ID);
  const shotBytes = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#c084fc' } }).png().toBuffer();
  fs.writeFileSync(path.join(plannerDir, 'shot.png'), shotBytes);
  fs.writeFileSync(path.join(plannerDir, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="48" height="24"/></svg>');
  fs.writeFileSync(path.join(plannerDir, 'page.html'), '<!doctype html><html><body><p>hello board</p></body></html>');
  const boardId = await newBoard('pictures');

  const attached = await runPlannerCli(context, ['whiteboard', 'attach', path.join(plannerDir, 'shot.png')]);
  assert.equal(attached.exitCode, 0, attached.printed);
  const { media } = JSON.parse(attached.printed) as { media: { kind: string; asset: string; mime: string; width: number; height: number; alt: string; hasPreview: boolean } };
  assert.deepEqual([media.kind, media.mime, media.width, media.height, media.hasPreview], ['image', 'image/png', 640, 320, false]);
  const again = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'shot.png' });
  assert.equal((again.body.media as { asset: string }).asset, media.asset);

  const put = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'login', title: 'Login', place: { at: { x: 40, y: 40 } }, media: { ...media, alt: 'login screen' } } },
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const { board } = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(board.elements.login?.media, { kind: 'image', asset: media.asset, mime: 'image/png', width: 640, height: 320, alt: 'login screen', hasPreview: false, dials: [], link: null, source: { from: 'file', path: path.join(plannerDir, 'shot.png'), sessionId: PLANNER_ID } });
  const assetUrl = (filename: string) => `${running().base}/whiteboards/assets/${filename}`;
  const named = await fetch(assetUrl(`${media.asset}.png/${encodeURIComponent('login caf\u00e9.png')}`));
  assert.deepEqual([named.status, named.headers.get('content-type'), named.headers.get('content-disposition')], [200, 'image/png', `inline; filename="login caf_.png"; filename*=UTF-8''login%20caf%C3%A9.png`]);
  assert.deepEqual(Buffer.from(await named.arrayBuffer()), shotBytes);
  const injected = await fetch(assetUrl(`${media.asset}.png/${encodeURIComponent('a"\r\nSet-Cookie: x.png')}`));
  assert.equal(injected.headers.get('content-disposition'), `inline; filename="aSet-Cookie: x.png"; filename*=UTF-8''aSet-Cookie%3A%20x.png`);
  assert.equal((await fetch(assetUrl(`${media.asset}.png/${encodeURIComponent('/..')}`))).status, 404);
  assert.equal((await fetch(assetUrl(`${'0'.repeat(64)}.png/shot.png`))).status, 404);
  const served = await fetch(assetUrl(`${media.asset}.png`));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), shotBytes);
  const ranged = await fetch(assetUrl(`${media.asset}.png`), { headers: { range: 'bytes=0-7' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), shotBytes.subarray(0, 8));
  assert.equal((await fetch(assetUrl(`${media.asset}.webp`))).status, 404);
  assert.equal((await fetch(assetUrl(`${media.asset}.preview.webp`))).status, 404);
  assert.equal((await fetch(assetUrl(`${'0'.repeat(64)}.png`))).status, 404);
  const exportUrl = (board: string, filename: string) => `${running().base}/whiteboards/pictures/${board}/${filename}`;
  const exportedPng = await fetch(exportUrl(boardId, 'picture.png'));
  assert.deepEqual([exportedPng.status, exportedPng.headers.get('content-type'), exportedPng.headers.get('content-disposition')], [200, 'image/png', 'attachment']);
  const exportedSize = await sharp(Buffer.from(await exportedPng.arrayBuffer())).metadata();
  const exportedSvg = await fetch(exportUrl(boardId, 'picture.svg'));
  assert.equal(exportedSvg.headers.get('content-type'), 'image/svg+xml');
  const exportedMarkup = await exportedSvg.text();
  assert.match(exportedMarkup, /data:image\/png;base64,/);
  const drawnWidth = Number(/ width="([0-9.]+)"/.exec(exportedMarkup)?.[1]);
  assert.equal(exportedSize.width, Math.round(drawnWidth * 2));
  assert.equal((await fetch(exportUrl(boardId, 'picture.gif'))).status, 404);
  assert.equal((await fetch(exportUrl('no-such-board', 'picture.png'))).status, 404);
  const pasted = await fetch(`${running().base}/whiteboards/assets`, { method: 'POST', body: shotBytes, headers: { 'content-type': 'image/png', 'x-glimmervoid-upload-name': 'shot.png' } });
  assert.deepEqual(await pasted.json(), { ok: true, media: { ...media, source: { from: 'upload', name: 'shot.png' } } });
  const crossSite = await fetch(`${running().base}/whiteboards/assets`, { method: 'POST', body: shotBytes, headers: { 'content-type': 'text/plain', origin: 'https://evil.example', 'x-glimmervoid-upload-name': 'shot.png' } });
  assert.equal(crossSite.status, 403);

  const svg = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'mark.svg' });
  assert.equal(svg.status, 200, JSON.stringify(svg.body));
  const svgMedia = svg.body.media as { kind: string; asset: string; mime: string; width: number; height: number };
  assert.deepEqual([svgMedia.kind, svgMedia.mime, svgMedia.width, svgMedia.height], ['image', 'image/svg+xml', 48, 24]);
  const servedSvg = await fetch(assetUrl(`${svgMedia.asset}.svg`));
  assert.equal(servedSvg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(servedSvg.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  const page = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'page.html' });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const pageMedia = page.body.media as { kind: string; asset: string; mime: string; hasPreview: boolean };
  assert.deepEqual([pageMedia.kind, pageMedia.mime, pageMedia.hasPreview], ['page', 'text/html', false]);
  const servedPage = await fetch(assetUrl(`${pageMedia.asset}.html`));
  assert.equal(servedPage.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(String(servedPage.headers.get('content-security-policy')), /^sandbox allow-scripts/);
  const servedPageMarkup = await servedPage.text();
  const [servedDoctype, , servedPageBody] = servedPageMarkup.split(/((?:<style>.*?<\/style>|<script>.*?<\/script>)+)/);
  assert.deepEqual([servedDoctype, `${servedDoctype}${servedPageBody}`], ['<!doctype html>', '<!doctype html><html><body><p>hello board</p></body></html>'], 'a page is served with the base style, params bridge and input reporter right after its doctype, ahead of every style and script of the page');
  assert.ok(servedPageMarkup.includes(`postMessage("${BOARD_PAGE_ESCAPE_MESSAGE}"`));
  assert.ok(servedPageMarkup.includes(`"${BOARD_PAGE_GESTURE_MESSAGE}"`), 'the input reporter relays pinch, pan, wheel and double tap to the dashboard');
  assert.ok(servedPageMarkup.includes(BOARD_PAGE_PARAMS_MESSAGE));
  assert.equal(servedPage.headers.get('cache-control'), 'no-store');
  assert.equal(servedPage.headers.get('content-length'), String(Buffer.byteLength(servedPageMarkup)));
  const dialManifest = [{ id: 'speed', label: 'Speed', kind: 'range', min: 0, max: 10, default: 4 }, { id: 'mode', label: 'Mode', kind: 'choice', options: ['calm', 'busy'], default: 'calm' }];
  fs.writeFileSync(path.join(plannerDir, 'dials.html'), `<!doctype html><script type="application/glimmervoid-params">${JSON.stringify(dialManifest)}</script><p>tuned</p>`);
  const dialed = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'dials.html' });
  assert.equal(dialed.status, 200, JSON.stringify(dialed.body));
  const dialedMedia = dialed.body.media as { asset: string; dials: unknown[] };
  assert.deepEqual(dialedMedia.dials, [{ ...dialManifest[0], step: 1 }, dialManifest[1]]);
  const tuned = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'tuned', title: 'Tuned', place: { at: { x: 400, y: 40 } }, media: dialedMedia, params: { speed: 7 } } }] });
  assert.equal(tuned.status, 200, JSON.stringify(tuned.body));
  const mistuned = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'tuned', fields: { params: { speed: 11 } } }] });
  assert.match(String(mistuned.body.error), /box tuned sets dial speed to 11, which does not suit a range dial/);
  const forged = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'forged', title: 'Forged', place: { at: { x: 700, y: 40 } }, media: { ...dialedMedia, dials: [] }, params: {} } }] });
  assert.match(String(forged.body.error), /attach stored it as/, 'a put cannot swap the dials attach read from the page');
  fs.writeFileSync(path.join(plannerDir, 'bad-dials.html'), `<!doctype html><script type="application/glimmervoid-params">[{"id":"hue","label":"Hue","kind":"range","min":5,"max":1,"default":3}]</script>`);
  const badDials = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'bad-dials.html' });
  assert.equal(badDials.status, 422);
  assert.match(String(badDials.body.error), /dial hue: a range dial needs min below max/);
  const longPrelude = `<?xml version="1.0"?>\n<!-- generated --><!-- ${'license '.repeat(10_000)}--!><!DOCTYPE html>`;
  fs.writeFileSync(path.join(plannerDir, 'long-prelude.html'), `${longPrelude}<html><body><p>standards mode</p></body></html>`);
  const longPreludePage = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'long-prelude.html' });
  assert.equal(longPreludePage.status, 200, JSON.stringify(longPreludePage.body));
  const longPreludeAsset = (longPreludePage.body.media as { asset: string }).asset;
  const longPreludeServed = await (await fetch(assetUrl(`${longPreludeAsset}.html`))).text();
  assert.ok(longPreludeServed.startsWith(`${longPrelude}<style>`), 'a doctype behind an XML declaration and a comment that is longer than one read and closed the lenient way still comes before the injected style and scripts, so the page keeps its rendering mode');
  assert.equal((await (await fetch(assetUrl(`${svgMedia.asset}.svg`))).text()).includes(BOARD_PAGE_ESCAPE_MESSAGE), false);
  const abstractText = '# Abstract\n\n<b>kept as text</b>\n';
  fs.writeFileSync(path.join(plannerDir, 'abstract.md'), abstractText);
  const doc = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'abstract.md' });
  assert.equal(doc.status, 200, JSON.stringify(doc.body));
  const docMedia = doc.body.media as { kind: string; asset: string; mime: string; width: number; height: number; hasPreview: boolean };
  assert.deepEqual([docMedia.kind, docMedia.mime, docMedia.width, docMedia.height, docMedia.hasPreview], ['doc', 'text/markdown', 800, 1000, false]);
  const servedDoc = await fetch(assetUrl(`${docMedia.asset}.md`));
  assert.deepEqual([servedDoc.headers.get('content-type'), servedDoc.headers.get('content-security-policy'), await servedDoc.text()], ['text/markdown; charset=utf-8', "default-src 'none'; sandbox", abstractText]);
  const editedOnBoard = await fetch(`${running().base}/whiteboards/assets`, { method: 'POST', body: `${abstractText}\nedited on the board\n`, headers: { 'content-type': 'text/markdown', 'x-glimmervoid-upload-name': 'abstract.md.md' } });
  const editedDocMedia = (await editedOnBoard.json() as { media: { kind: string; asset: string } }).media;
  assert.equal(editedDocMedia.kind, 'doc', 'the text the dashboard saves from the document view is stored as a document');
  assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);
  const docPut = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'abstract', title: 'abstract.md', place: { at: { x: 40, y: 900 } }, media: { ...docMedia, alt: 'abstract.md' } } },
    { op: 'set', id: 'abstract', fields: { media: { ...editedDocMedia, alt: 'abstract.md' } } },
  ] });
  assert.equal(docPut.status, 200, JSON.stringify(docPut.body));
  const savedDocText = `${abstractText}\nedited on the board\n`;
  const docRead = await whiteboard(PLANNER_ID, { sub: 'doc', board: boardId, box: 'abstract' });
  assert.deepEqual([docRead.status, docRead.body], [200, { ok: true, box: 'abstract', text: savedDocText }], 'an agent reads the text the box shows now, not the text it attached');
  const notADoc = await whiteboard(PLANNER_ID, { sub: 'doc', board: boardId, box: 'login' });
  assert.deepEqual([notADoc.status, notADoc.body.error], [400, 'login on board "pictures" holds no document; whiteboard doc reads a box whose media kind is doc']);
  const docWrites: string[] = [];
  context.mock.method(process.stdout, 'write', (chunk: string) => { docWrites.push(chunk); return true; });
  const docPrinted = await runPlannerCli(context, ['whiteboard', 'doc', boardId, 'abstract']);
  assert.deepEqual([docPrinted.exitCode, docPrinted.printed, docWrites], [0, '', [savedDocText]], 'the CLI prints the document text itself, byte for byte, with no JSON around it');
  assert.deepEqual((await boardOf(BUILDER_ID, boardId)).changes.map((change) => change.summary), [
    `${PLANNER_ID} added box "abstract.md"; ${PLANNER_ID} edited the document in "abstract.md" (read it with whiteboard doc)`,
  ], 'a session following the board is told the document changed and how to read it');
  fs.writeFileSync(path.join(plannerDir, 'big.md'), '#'.repeat(256 * 1024 + 1));
  const bigDoc = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'big.md' });
  assert.deepEqual([bigDoc.status, bigDoc.body.error], [413, 'big.md is larger than the 256 KiB a board document takes']);
  fs.writeFileSync(path.join(plannerDir, 'binary.md'), Buffer.from([0x23, 0x20, 0x00, 0x41]));
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'attach', path: 'binary.md' })).status, 415, 'a .md name does not make bytes that are not text a document');
  fs.writeFileSync(path.join(plannerDir, 'latin1.md'), Buffer.from('# Caf\xe9\n', 'latin1'));
  const latin1Doc = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'latin1.md' });
  assert.deepEqual([latin1Doc.status, latin1Doc.body.error], [415, 'latin1.md is not UTF-8 text; a board document is UTF-8 Markdown']);
  const ffmpegPath = resolveFfmpegPath();
  assert.ok(ffmpegPath, 'ffmpeg-static is installed');
  await execFileAsync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2400x1200:rate=5:duration=1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-y', path.join(plannerDir, 'clip.webm')]);
  const video = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'clip.webm' });
  assert.equal(video.status, 200, JSON.stringify(video.body));
  const videoMedia = video.body.media as { kind: string; asset: string; mime: string; width: number; height: number; hasPreview: boolean };
  assert.deepEqual([videoMedia.kind, videoMedia.mime, videoMedia.width, videoMedia.height, videoMedia.hasPreview], ['video', 'video/webm', 1024, 512, true]);
  const poster = await fetch(assetUrl(`${videoMedia.asset}.preview.webp`));
  assert.equal(poster.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await poster.arrayBuffer())).metadata()).width, 1024);
  assert.equal((await fetch(assetUrl(`${videoMedia.asset}.webm`))).headers.get('content-type'), 'video/webm');
  const videoAgain = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'clip.webm' });
  assert.deepEqual(videoAgain.body.media, videoMedia);
  assert.equal((await fetch(assetUrl(`${videoMedia.asset}.preview.webp`))).status, 200);
  fs.copyFileSync(path.join(plannerDir, 'mark.svg'), path.join(plannerDir, 'mark-as-page.html'));
  const svgAsPage = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'mark-as-page.html' });
  assert.deepEqual({ ...(svgAsPage.body.media as object), source: null }, { ...(svg.body.media as object), source: null });
  assert.deepEqual(fs.readdirSync(path.join(fixture.tmpDir, 'whiteboards', 'assets')).sort(), [`${media.asset}.png`, `${svgMedia.asset}.svg`, `${pageMedia.asset}.html`, `${longPreludeAsset}.html`, `${dialedMedia.asset}.html`, `${docMedia.asset}.md`, `${editedDocMedia.asset}.md`, `${videoMedia.asset}.webm`, `${videoMedia.asset}.preview.webp`].sort());

  const unstored = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'login', fields: { media: { ...media, asset: 'f'.repeat(64) } } }] });
  assert.equal(unstored.status, 400);
  assert.match(String(unstored.body.error), /no whiteboard attach stored/);
  const mislabeled = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'login', fields: { media: { ...media, mime: 'image/webp' } } }] });
  assert.equal(mislabeled.status, 400);
  assert.match(String(mislabeled.body.error), /but attach stored it as/);
  await sharp({ create: { width: 16400, height: 4, channels: 3, background: '#000000' } }).png().toFile(path.join(plannerDir, 'strip.png'));
  const overEdge = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'strip.png' });
  assert.equal(overEdge.status, 413);
  assert.match(String(overEdge.body.error), /at most 16384 on each edge/);
  fs.writeFileSync(path.join(plannerDir, 'notes.txt'), 'plain words');
  const plainText = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'notes.txt' });
  assert.equal(plainText.status, 415);
  fs.writeFileSync(path.join(plannerDir, 'photo.avif'), Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(64)]));
  fs.writeFileSync(path.join(plannerDir, 'photo.heif'), Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypmif2', 'latin1'), Buffer.alloc(64)]));
  fs.writeFileSync(path.join(plannerDir, 'photo-avc.heif'), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypMiHE', 'latin1'), Buffer.alloc(4), Buffer.from('mif1', 'latin1'), Buffer.alloc(64)]));
  for (const imageInVideoContainer of ['photo.avif', 'photo.heif', 'photo-avc.heif']) {
    assert.equal((await whiteboard(PLANNER_ID, { sub: 'attach', path: imageInVideoContainer })).status, 415, imageInVideoContainer);
  }
  fs.writeFileSync(path.join(plannerDir, 'broken.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(64)]));
  fs.writeFileSync(path.join(plannerDir, 'phone.m4v'), Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4VP', 'latin1'), Buffer.alloc(4), Buffer.from('isom', 'latin1'), Buffer.alloc(64)]));
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'attach', path: 'phone.m4v' })).status, 200);
  const unpostered = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'broken.mp4' });
  assert.equal(unpostered.status, 200, JSON.stringify(unpostered.body));
  const unposteredMedia = unpostered.body.media as { kind: string; width: number; height: number; hasPreview: boolean };
  assert.deepEqual([unposteredMedia.kind, unposteredMedia.width, unposteredMedia.height, unposteredMedia.hasPreview], ['video', 1280, 720, false]);
  const posterDropped = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'clip-without-poster', title: 'Clip', place: { at: { x: 40, y: 40 } }, media: { ...videoMedia, hasPreview: false } } },
  ] });
  assert.equal(posterDropped.status, 400, JSON.stringify(posterDropped.body));
  await sharp({ create: { width: 2000, height: 400, channels: 3, background: '#38bdf8' } }).png().toFile(path.join(plannerDir, 'wide.png'));
  const wide = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'wide.png' });
  const wideMedia = wide.body.media as { hasPreview: boolean };
  assert.equal(wideMedia.hasPreview, true);
  const previewDropped = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'wide-without-preview', title: 'Wide', place: { at: { x: 40, y: 40 } }, media: { ...wideMedia, hasPreview: false } } },
  ] });
  assert.equal(previewDropped.status, 400, JSON.stringify(previewDropped.body));
  assert.match(String(previewDropped.body.error), /but attach stored it as/);
  const wholeJpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#a3e635' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(plannerDir, 'cut.jpg'), wholeJpeg.subarray(0, wholeJpeg.length >> 1));
  const cutPhoto = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'cut.jpg' });
  assert.equal(cutPhoto.status, 200, JSON.stringify(cutPhoto.body));
  assert.equal((cutPhoto.body.media as { hasPreview: boolean }).hasPreview, false);
  const hugePath = path.join(plannerDir, 'huge.png');
  fs.closeSync(fs.openSync(hugePath, 'w'));
  fs.truncateSync(hugePath, 201 * 1024 * 1024);
  const huge = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'huge.png' });
  assert.equal(huge.status, 413);
  assert.match(String(huge.body.error), /huge\.png is larger than the 200 MB/);
});

test('a board exported to a board file and imported comes back as a new board with its media and page files, carrying no path or session of the machine it left, and a damaged file is refused whole', async (context) => {
  const { default: sharp } = await import('sharp');
  const shareDir = path.join(fixture.tmpDir, PLANNER_ID, 'share');
  fs.mkdirSync(shareDir);
  fs.writeFileSync(path.join(shareDir, 'flow.png'), await sharp({ create: { width: 64, height: 32, channels: 3, background: '#7cb4f2' } }).png().toBuffer());
  fs.writeFileSync(path.join(shareDir, 'flow.html'), '<!doctype html><script src="app.js"></script><p>flow</p>');
  fs.writeFileSync(path.join(shareDir, 'app.js'), 'document.body.dataset.ready = "yes";');
  const boardId = await newBoard('Shared flow');
  const picture = (await whiteboard(PLANNER_ID, { sub: 'attach', path: 'share/flow.png' })).body.media as BoxMedia;
  const page = (await whiteboard(PLANNER_ID, { sub: 'attach', path: 'share/flow.html' })).body.media as BoxMedia;
  const put = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'board', caption: 'how a login flows', legend: [{ tone: 'fail', label: 'refused' }] },
    { op: 'add', element: { kind: 'box', id: 'shot', title: 'Login', place: { at: { x: 40, y: 40 } }, media: { ...picture, alt: 'login screen' }, refs: ['server/auth.ts#L12'] } },
    { op: 'add', element: { kind: 'box', id: 'demo', title: 'Demo', place: { at: { x: 400, y: 40 } }, media: page } },
    { op: 'add', element: { kind: 'box', id: 'why', shape: 'note', title: 'Check the refusal', place: { at: { x: 40, y: 400 } } } },
    { op: 'add', element: { kind: 'wire', id: 'shot-demo', from: 'shot', to: 'demo', tone: 'fail' } },
    { op: 'add', element: { kind: 'frame', id: 'flow', title: 'Flow', contains: ['shot', 'demo'] } },
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const grown = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'later', title: 'Later', place: { at: { x: 800, y: 40 } } } },
    { op: 'add', element: { kind: 'wire', id: '1', from: 'demo', to: 'later' } },
    { op: 'set', id: 'flow', fields: { contains: ['shot', 'demo', 'later'] } },
  ] });
  assert.equal(grown.status, 200, JSON.stringify(grown.body));
  const original = await boardOf(PLANNER_ID, boardId);

  const outPath = path.join(fixture.tmpDir, 'flow.glimmerboard');
  const exported = await runPlannerCli(context, ['whiteboard', 'export', boardId, '--out', outPath]);
  assert.equal(exported.exitCode, 0, exported.printed);
  const fileText = zlib.gunzipSync(fs.readFileSync(outPath)).toString('utf8');
  for (const machineDetail of [fixture.tmpDir, boardId, '"sessionId"', '"codeSessionId"']) assert.equal(fileText.includes(machineDetail), false, `the board file carries no ${machineDetail}`);

  const imported = await runPlannerCli(context, ['whiteboard', 'import', outPath]);
  assert.equal(imported.exitCode, 0, imported.printed);
  const importedSummary = (JSON.parse(imported.printed) as { board: { id: string; title: string } }).board;
  assert.notEqual(importedSummary.id, boardId);
  assert.equal(importedSummary.title, 'Shared flow (2)', 'an import never takes the title of a board already here');
  const copy = await boardOf(PLANNER_ID, importedSummary.id);
  const withoutSource = (elements: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(elements).map(([id, element]) => [id, element.media ? { ...element, media: { ...element.media as object, source: null } } : element]));
  assert.deepEqual(withoutSource(copy.board.elements), withoutSource(original.board.elements));
  assert.deepEqual([copy.board.elements.shot?.media, copy.board.elements.why?.author], [{ ...picture, alt: 'login screen', source: { from: 'upload', name: 'flow.png' } }, PLANNER_ID]);
  const importedBoard = Board.parse(copy.board as unknown);
  assert.deepEqual([importedBoard.caption, importedBoard.legend, importedBoard.codeSessionId, importedBoard.project], ['how a login flows', [{ tone: 'fail', dashed: false, label: 'refused' }], null, path.join(fixture.tmpDir, PLANNER_ID)]);
  assert.equal((copy.board.elements.demo?.media as BoxMedia | undefined)?.asset, page.asset, 'a page comes back with the same bundle id, so the files it loads came back too');

  const downloaded = await fetch(`${running().base}/whiteboards/files/${boardId}/board.glimmerboard`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-disposition'), 'attachment');
  const uploaded = await fetch(`${running().base}/whiteboards/files`, { method: 'POST', body: Buffer.from(await downloaded.arrayBuffer()), headers: { 'content-type': 'application/gzip' } });
  const uploadReply = await uploaded.json() as { ok: boolean; board: { id: string; title: string } };
  assert.deepEqual([uploaded.status, uploadReply.ok, uploadReply.board.title], [200, true, 'Shared flow (3)'], 'the dashboard imports what it downloads');
  const dashboardCopy = await boardOf(PLANNER_ID, uploadReply.board.id);
  assert.deepEqual(withoutSource(dashboardCopy.board.elements), withoutSource(original.board.elements));
  const crossSite = await fetch(`${running().base}/whiteboards/files`, { method: 'POST', body: Buffer.from(fileText), headers: { origin: 'https://elsewhere.example' } });
  assert.equal(crossSite.status, 403);

  const boardCountBefore = ((await whiteboard(PLANNER_ID, { sub: 'list', all: true })).body.boards as unknown[]).length;
  const parsedFile = JSON.parse(fileText) as { assets: Record<string, { members: Record<string, string> }> };
  const escapingPage = structuredClone(parsedFile);
  const pageAsset = escapingPage.assets[page.asset];
  assert.ok(pageAsset);
  pageAsset.members = { '../escaped.js': pageAsset.members['app.js'] ?? '' };
  const damagedFiles = [
    { name: 'not-gzip.glimmerboard', bytes: Buffer.from(fileText), error: /not a Glimmervoid board file/ },
    { name: 'escaping.glimmerboard', bytes: zlib.gzipSync(JSON.stringify(escapingPage)), error: /page file path is relative/ },
    { name: 'future.glimmerboard', bytes: zlib.gzipSync(JSON.stringify({ ...parsedFile, version: 2 })), error: /another Glimmervoid version/ },
    { name: 'truncated.glimmerboard', bytes: fs.readFileSync(outPath).subarray(0, 200), error: /not a Glimmervoid board file/ },
  ];
  for (const damaged of damagedFiles) {
    fs.writeFileSync(path.join(fixture.tmpDir, PLANNER_ID, damaged.name), damaged.bytes);
    const refused = await whiteboard(PLANNER_ID, { sub: 'import', path: damaged.name });
    assert.match(String(refused.body.error), damaged.error, damaged.name);
  }
  assert.equal(fs.existsSync(path.join(fixture.tmpDir, PLANNER_ID, 'escaped.js')), false);
  assert.equal(((await whiteboard(PLANNER_ID, { sub: 'list', all: true })).body.boards as unknown[]).length, boardCountBefore, 'a refused import leaves no board behind');

  const exportCopy = path.join(fixture.tmpDir, 'whiteboards', 'exports', `${boardId}.glimmerboard`);
  assert.equal(fs.existsSync(exportCopy), true);
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'delete', board: boardId })).status, 200);
  await waitFor(() => !fs.existsSync(exportCopy), 'a deleted board leaves no board file of it behind');
});

test('refs are checked in the code session worktree: a missing file, a line past the end and a path leaving the worktree land as warnings on the put that wrote them, and get --layout repeats them all', async (context) => {
  const worktree = path.join(fixture.tmpDir, PLANNER_ID);
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'feed.ts'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(fixture.tmpDir, 'outside.ts'), 'secret\n');
  fs.symlinkSync(path.join(fixture.tmpDir, 'outside.ts'), path.join(worktree, 'src', 'escape.ts'));
  const boardId = await newBoard('anchored');

  const put = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: {
      kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } }, refs: ['src/feed.ts#L2-L3', 'src/gone.ts', 'src/feed.ts#L9', '../outside.ts'],
      lines: [{ text: 'readFeed()', style: 'code' }],
    } },
    { op: 'add', element: { kind: 'box', id: 'n1', shape: 'note', title: 'what about drafts?', place: { at: { x: 40, y: 300 } }, refs: ['src/escape.ts'] } },
  ] });
  const expectedWarnings = [
    'ref src/gone.ts on box parse: no such file',
    'ref src/feed.ts#L9 on box parse: the file has 3 lines',
    'ref ../outside.ts on box parse: a path with .. is never read; name the file relative to the code session worktree',
    'ref src/escape.ts on box n1: the path leads outside the code session worktree, so it was not read',
  ];
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.warnings, expectedWarnings);
  const unrelatedPut = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'save', title: 'Save', place: { at: { x: 400, y: 40 } }, refs: ['src/feed.ts#L4'] } },
  ] });
  assert.deepEqual(unrelatedPut.body.warnings, ['ref src/feed.ts#L4 on box save: the file has 3 lines']);
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'remove', id: 'save' }] })).status, 200);

  const laidOut = await runPlannerCli(context, ['whiteboard', 'get', boardId, '--layout']);
  assert.equal(laidOut.exitCode, 0);
  const { review } = JSON.parse(laidOut.printed) as { review: unknown };
  assert.deepEqual(review, { codeSessionId: PLANNER_ID, anchorWarnings: expectedWarnings, stepWarnings: [], uncoveredPaths: [], worthALook: [], flaggedStepIds: [], notChecked: null, linkStates: [] });
});

test('a board with no code session takes the first session of its project that connects, a session of another project leaves it, and the other sessions hear of it', async () => {
  const boardId = await newBoard('unclaimed');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'board', codeSessionId: null }] })).status, 200);

  assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);
  assert.equal(((await boardOf(BUILDER_ID, boardId)).board as { codeSessionId?: string | null }).codeSessionId, null);

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'connect', board: boardId })).status, 200);
  const plannerRead = await boardOf(PLANNER_ID, boardId);
  assert.equal((plannerRead.board as { codeSessionId?: string | null }).codeSessionId, PLANNER_ID);
  const builderRead = await boardOf(BUILDER_ID, boardId);
  assert.deepEqual(builderRead.changes.map((change) => change.summary), [`Glimmervoid set the code session to ${PLANNER_ID}`]);
});

test('a box placed near another keeps its place when that box is removed, and a box with no place is refused', async () => {
  const boardId = await newBoard('regroup');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } } } },
    { op: 'add', element: { kind: 'box', id: 'save', title: 'Save', place: { at: { x: 350, y: 40 } } } },
  ] })).status, 200);

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'aside', title: 'Aside', place: { near: { of: 'save', side: 'right' } } } },
    { op: 'remove', id: 'save' },
    { op: 'set', id: 'aside', fields: { title: 'Aside, kept' } },
  ] })).status, 200);
  const afterRemove = (await boardOf(PLANNER_ID, boardId)).board.elements.aside;
  assert.ok(pointOfStored(afterRemove), 'a box near a removed box keeps where it stood');

  const placeless = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'lost', title: 'Lost' } }] });
  assert.equal(placeless.status, 400);
  assert.match(String(placeless.body.error), /needs a place/);
});

test('an align op gives boxes of ragged heights one top and one height as a row, one left and one width as a column, and refuses an id that is not a placed box', async () => {
  const boardId = await newBoard('aligned');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'short', title: 'Short', place: { at: { x: 40, y: 60 } } } },
    { op: 'add', element: { kind: 'box', id: 'tall', title: 'Tall', place: { at: { x: 350, y: 40 } }, lines: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] } },
    { op: 'add', element: { kind: 'box', id: 'wide', title: 'Wide', place: { at: { x: 700, y: 90 } }, width: 300 } },
    { op: 'align', ids: ['short', 'tall', 'wide'], as: 'row' },
  ] })).status, 200);
  const row = (await boardOf(PLANNER_ID, boardId)).board.elements;
  assert.deepEqual([pointOfStored(row.short), pointOfStored(row.tall), pointOfStored(row.wide)], [{ x: 40, y: 40 }, { x: 350, y: 40 }, { x: 700, y: 40 }]);
  const rowHeight = Number(row.tall?.height);
  assert.deepEqual([row.short?.height, row.wide?.height], [rowHeight, rowHeight]);
  assert.ok(rowHeight > 60, 'the row takes the height of its tallest box');

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'align', ids: ['short', 'wide'], as: 'column' }] })).status, 200);
  const column = (await boardOf(PLANNER_ID, boardId)).board.elements;
  assert.deepEqual([pointOfStored(column.short), column.short?.width, pointOfStored(column.wide), column.wide?.width], [{ x: 40, y: 40 }, 300, { x: 40, y: 40 }, 300]);

  const refused = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'align', ids: ['short', 'missing'], as: 'row' }] });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /op 1: align names missing, which is not a placed box/);

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'banded', title: 'Banded', place: 'plan', step: { status: 'planned' } } }] })).status, 200);
  const unplacedBesideANearAdd = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'beside', title: 'Beside', place: { near: { of: 'banded', side: 'right', gap: 60 } } } },
    { op: 'align', ids: ['banded', 'short'], as: 'row' },
  ] });
  assert.equal(unplacedBesideANearAdd.status, 400);
  assert.match(String(unplacedBesideANearAdd.body.error), /op 2: align names banded, which is not a placed box/);

  const everyOpAnAlign = Array.from({ length: WHITEBOARD_LIMITS.opsPerPut / 2 + 1 }, () => ({ op: 'align', ids: ['short', 'wide'], as: 'row' }));
  const pastTheOpCap = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: everyOpAnAlign });
  assert.equal(pastTheOpCap.status, 400);
  assert.match(String(pastTheOpCap.body.error), /the put changes more than \d+ elements once its align ops are counted box by box/);
});

test('a box placed near another stays where it was drawn when that box moves, and near a box with no drawn place is refused', async () => {
  const boardId = await newBoard('near chain');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'first', title: 'First', place: { at: { x: 40, y: 40 } } } },
    { op: 'add', element: { kind: 'box', id: 'second', title: 'Second', place: { near: { of: 'first', side: 'right' } } } },
    { op: 'add', element: { kind: 'box', id: 'third', title: 'Third', place: { near: { of: 'second', side: 'right' } } } },
  ] })).status, 200);
  const placed = (await boardOf(PLANNER_ID, boardId)).board.elements;
  assert.ok(placed.second && placed.third && !('near' in placed.second) && !('near' in placed.third));

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'second', fields: { place: { at: { x: 600, y: 400 } } } }] })).status, 200);
  assert.deepEqual(pointOfStored((await boardOf(PLANNER_ID, boardId)).board.elements.third), pointOfStored(placed.third));

  const unplaced = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'step', title: 'Step', place: 'plan', step: {} } },
    { op: 'add', element: { kind: 'box', id: 'beside', title: 'Beside', place: { near: { of: 'step', side: 'right' } } } },
  ] });
  assert.equal(unplaced.status, 400);
  assert.match(String(unplaced.body.error), /has no drawn place yet/);
});

test('the operator connects and disconnects a session from the dashboard, and a removed session leaves every board and keeps the boards only it was on', async () => {
  const boardId = await newBoard('operator links');
  const leaverOnlyBoardId = await newBoard('leaver only');
  const plannerLeft = await whiteboard(PLANNER_ID, { sub: 'disconnect', board: leaverOnlyBoardId });
  assert.equal(plannerLeft.status, 200);
  const client = await dashboardClient(boundPort(running().server));
  const control = await openRecordingSocket<{ type: string; requestId?: string; ok?: boolean; error?: string; summary?: { connectedSessionIds: string[] }; boards?: { id: string; connectedSessionIds: string[] }[] }>(client);
  try {
    const command = async (message: Record<string, unknown> & { requestId: string }) => {
      control.ws.send(JSON.stringify(message));
      return waitForMessage(control.received, (frame) => frame.requestId === message.requestId, `the ${message.type} reply`);
    };

    const connected = await command({ type: 'whiteboard-connect', boardId, sessionId: BUILDER_ID, requestId: 'connect-builder' });
    assert.equal(connected.ok, true);
    assert.ok(connected.summary?.connectedSessionIds.includes(BUILDER_ID));
    const moved = await command({ type: 'whiteboard-op', boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'from-operator', title: 'Operator box', place: { at: { x: 40, y: 40 } } } }], requestId: 'operator-op' });
    assert.equal(moved.ok, true);
    const builderView = await boardOf(BUILDER_ID, boardId);
    assert.deepEqual(builderView.changes.map((change) => change.summary), ['operator added box "Operator box"']);
    const newWhileAttached = await whiteboard(BUILDER_ID, { sub: 'new', title: 'second board' });
    assert.equal(newWhileAttached.status, 409);
    assert.match(String(newWhileAttached.body.error), new RegExp(`board "operator links" \\(${boardId}\\) beside this session`));
    const detached = await command({ type: 'whiteboard-detach', boardId, sessionId: BUILDER_ID, requestId: 'detach-builder' });
    assert.ok(detached.summary?.connectedSessionIds.includes(BUILDER_ID));
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'new', title: 'board after detach' })).status, 200);
    assert.equal((await command({ type: 'whiteboard-connect', boardId, sessionId: BUILDER_ID, requestId: 'reattach-builder' })).ok, true);

    const disconnected = await command({ type: 'whiteboard-disconnect', boardId, sessionId: BUILDER_ID, requestId: 'disconnect-builder' });
    assert.equal(disconnected.ok, true);
    assert.equal(disconnected.summary?.connectedSessionIds.includes(BUILDER_ID), false);
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'new', title: 'second board' })).status, 200);
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'new', title: 'third board' })).status, 200);
    await whiteboard(BUILDER_ID, { sub: 'disconnect', board: boardId });
    await Promise.all([
      command({ type: 'whiteboard-connect', boardId, sessionId: BUILDER_ID, requestId: 'racing-connect' }),
      command({ type: 'whiteboard-disconnect', boardId, sessionId: BUILDER_ID, requestId: 'racing-disconnect' }),
    ]);
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);
    assert.equal((await whiteboard(BUILDER_ID, { sub: 'new', title: 'fourth board' })).status, 200);

    const unknown = await command({ type: 'whiteboard-connect', boardId, sessionId: 'no-such-session', requestId: 'connect-unknown' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'That session is no longer on the dashboard.');

    const leaverConnected = await command({ type: 'whiteboard-connect', boardId, sessionId: LEAVER_ID, requestId: 'connect-leaver' });
    assert.ok(leaverConnected.summary?.connectedSessionIds.includes(LEAVER_ID));
    const leaverOnlyConnected = await command({ type: 'whiteboard-connect', boardId: leaverOnlyBoardId, sessionId: LEAVER_ID, requestId: 'connect-leaver-only' });
    assert.deepEqual(leaverOnlyConnected.summary?.connectedSessionIds, [LEAVER_ID]);
    const framesBeforeRemoval = control.received.length;
    const removed = await command({ type: 'remove-session', id: LEAVER_ID, requestId: 'remove-leaver' });
    assert.equal(removed.ok, true, String(removed.error));
    await waitForMessage(control.received, (frame) => control.received.indexOf(frame) >= framesBeforeRemoval && frame.type === 'whiteboards-snapshot'
      && frame.boards?.some((board) => board.id === boardId && !board.connectedSessionIds.includes(LEAVER_ID)) === true
      && frame.boards.some((board) => board.id === leaverOnlyBoardId && board.connectedSessionIds.length === 0), 'the snapshot without the removed session, still holding the board only it was on');
    const listed = await whiteboard(PLANNER_ID, { sub: 'list' });
    assert.deepEqual((listed.body.boards as { id: string; connectedSessionIds: string[] }[]).filter((board) => board.id === leaverOnlyBoardId).map((board) => board.connectedSessionIds), [[]]);
    assert.equal((await boardOf(PLANNER_ID, leaverOnlyBoardId)).board.version, 0);
  } finally {
    await closeSocket(control.ws);
  }
});

test('a board the operator attached beside a session stays attached across a restart', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'attached-restart-'));
  const project = path.join(boardsRoot, 'app');
  const agent = { id: 'attached-agent', name: 'agent', project };
  const beforeRestart = createWhiteboardWiring({ boardsRoot, projectOf: () => project });
  const boardId = ((await beforeRestart.handleOperator.create('Beside plan')) as { summary: { id: string } }).summary.id;
  await beforeRestart.handleOperator.connect(boardId, agent.id);

  const afterRestart = createWhiteboardWiring({ boardsRoot, projectOf: () => project });
  await afterRestart.loaded;
  assert.match(String(afterRestart.takeBoardNotice(agent.id, project)), new RegExp(`opened board "Beside plan" \\(${boardId}\\) beside this session`));
  assert.equal((await afterRestart.handleAgent(agent, { sub: 'new', title: 'second' })).status, 409);
  await afterRestart.handleOperator.detach(boardId, agent.id);

  const afterDetachRestart = createWhiteboardWiring({ boardsRoot, projectOf: () => project });
  assert.equal((await afterDetachRestart.handleAgent(agent, { sub: 'new', title: 'second' })).status, 200);
});

test('boards and their connections survive a restart', async () => {
  const boardId = await newBoard('durable');
  await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId });
  await shutDown(fixture.booted);
  fixture.booted = await boot();

  const listed = await whiteboard(PLANNER_ID, { sub: 'list' });
  const boards = listed.body.boards as { id: string; connectedSessionIds: string[] }[];
  const durable = boards.find((board) => board.id === boardId);
  assert.ok(durable, 'the board is listed after the restart');
  assert.deepEqual(durable.connectedSessionIds.sort(), [BUILDER_ID, PLANNER_ID].sort());
});

test('a board an agent creates carries its project, and an unfiled board is filed under the first session that acts on it', async () => {
  const boardId = await newBoard('filed plan');
  assert.equal(Board.parse((await whiteboard(PLANNER_ID, { sub: 'get', board: boardId })).body.board).project, path.join(fixture.tmpDir, PLANNER_ID));

  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'unfiled-'));
  const operatorConnectedProject = path.join(boardsRoot, 'operator-connected');
  const wiring = createWhiteboardWiring({ boardsRoot, projectOf: (sessionId) => (sessionId === 'operator-connected' ? operatorConnectedProject : null) });
  const operatorConnectedBoardId = ((await wiring.handleOperator.create('connected from the dashboard')) as { summary: { id: string } }).summary.id;
  await wiring.handleOperator.connect(operatorConnectedBoardId, 'operator-connected');
  assert.equal((await wiring.handleOperator.get(operatorConnectedBoardId)).board?.project, operatorConnectedProject);

  const unfiledBoardId = ((await wiring.handleOperator.create('unfiled')) as { summary: { id: string } }).summary.id;
  const firstProject = path.join(boardsRoot, 'first');
  const projectOfBoard = async (project: string) => {
    const read = await wiring.handleAgent({ id: `reader-${path.basename(project)}`, name: 'reader', project }, { sub: 'get', board: unfiledBoardId });
    return Board.parse((read.body as { board: unknown }).board).project;
  };
  assert.equal(await projectOfBoard(firstProject), firstProject);
  assert.equal(await projectOfBoard(path.join(boardsRoot, 'second')), firstProject);

  const restartRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'unfiled-restart-'));
  const beforeFiling = createWhiteboardWiring({ boardsRoot: restartRoot });
  const knownSessionBoardId = ((await beforeFiling.handleOperator.create('made before filing')) as { summary: { id: string } }).summary.id;
  const goneSessionBoardId = ((await beforeFiling.handleOperator.create('session gone')) as { summary: { id: string } }).summary.id;
  await beforeFiling.handleOperator.connect(knownSessionBoardId, 'restored-session');
  await beforeFiling.handleOperator.connect(goneSessionBoardId, 'gone-session');
  assert.equal((await beforeFiling.handleOperator.get(knownSessionBoardId)).board?.project, null);
  const restoredProject = path.join(restartRoot, 'restored');
  const afterRestart = createWhiteboardWiring({ boardsRoot: restartRoot, projectOf: (sessionId) => (sessionId === 'restored-session' ? restoredProject : null) });
  await afterRestart.fileUnfiledBoards();
  const projectAfterAnotherRestart = async (boardId: string) => (await createWhiteboardWiring({ boardsRoot: restartRoot }).handleOperator.get(boardId)).board?.project;
  assert.equal(await projectAfterAnotherRestart(knownSessionBoardId), restoredProject);
  assert.equal(await projectAfterAnotherRestart(goneSessionBoardId), null);
});

test('an agent lists its own project boards in use, all lists every board, a title resolves only in its project, and a board idle 30 days unconnected is archived until a connect or an edit', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'project-scope-'));
  let clockMs = Date.UTC(2026, 0, 1);
  const wiring = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  const planner = { id: 'scope-planner', name: 'planner', project: path.join(boardsRoot, 'app') };
  const stranger = { id: 'scope-stranger', name: 'stranger', project: path.join(boardsRoot, 'other') };
  const boardId = ((await wiring.handleAgent(planner, { sub: 'new', title: 'App plan' })).body as { board: { id: string } }).board.id;
  const listedIds = async (caller: typeof planner, all: boolean) => ((await wiring.handleAgent(caller, all ? { sub: 'list', all: true } : { sub: 'list' })).body as { boards: { id: string }[] }).boards.map((board) => board.id);

  assert.deepEqual(await listedIds(planner, false), [boardId]);
  assert.deepEqual(await listedIds(stranger, false), []);
  assert.deepEqual(await listedIds(stranger, true), [boardId]);
  assert.equal((await wiring.handleAgent(stranger, { sub: 'get', board: 'App plan', peek: true })).status, 404);
  assert.equal((await wiring.handleAgent(stranger, { sub: 'get', board: boardId, peek: true })).status, 200);
  const unfiledBoardId = ((await wiring.handleOperator.create('Dashboard sketch')) as { summary: { id: string } }).summary.id;
  assert.deepEqual(await listedIds(stranger, false), [unfiledBoardId]);
  assert.equal((await wiring.handleAgent(stranger, { sub: 'get', board: 'Dashboard sketch', peek: true })).status, 200);
  assert.deepEqual(await listedIds(planner, false), [boardId]);

  const archivedAfterIdleDays = async (idleDays: number) => {
    await wiring.handleAgent(planner, { sub: 'disconnect', board: boardId });
    clockMs += idleDays * 24 * 60 * 60 * 1000;
    return wiring.snapshotMessage().boards.find((board) => board.id === boardId)?.isArchived;
  };
  assert.equal(await archivedAfterIdleDays(29), false);
  assert.equal(await archivedAfterIdleDays(2), true);
  assert.deepEqual(await listedIds(planner, false), []);
  assert.ok((await listedIds(planner, true)).includes(boardId));
  assert.equal((await wiring.handleAgent(planner, { sub: 'connect', board: 'App plan' })).status, 200);
  assert.deepEqual(await listedIds(planner, false), [boardId]);

  assert.equal(await archivedAfterIdleDays(31), true);
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'board', caption: 'picked back up' }]));
  assert.deepEqual(await listedIds(planner, false), [boardId]);
});

test('once its code session is gone a board checks refs against its project, the next session of its project to connect takes over the refs and keeps them while live, and no agent deletes an unfiled board', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'project-refs-'));
  const project = path.join(boardsRoot, 'app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'real.ts'), 'export {};\n', 'utf8');
  const wiring = createWhiteboardWiring({ boardsRoot, codeContextOf: (sessionId) => (sessionId === 'refs-successor' ? { root: project, buildChangeMap: () => Promise.reject(new Error('no change map in this test')) } : null) });
  const creator = { id: 'refs-creator', name: 'creator', project };
  const successor = { id: 'refs-successor', name: 'successor', project };
  const boardId = ((await wiring.handleAgent(creator, { sub: 'new', title: 'Refs plan' })).body as { board: { id: string } }).board.id;
  await wiring.handleAgent(creator, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } }, refs: ['src/real.ts', 'src/missing.ts'] } }]) });

  const review = (await wiring.handleOperator.review(boardId)).review;
  assert.equal(review?.notChecked, null);
  assert.deepEqual(review?.anchorWarnings.map((warning) => warning.split(':')[0]), ['ref src/missing.ts on box parse']);

  await wiring.handleAgent({ id: 'refs-successor', name: 'stranger', project: path.join(boardsRoot, 'other') }, { sub: 'connect', board: boardId });
  assert.equal((await wiring.handleOperator.get(boardId)).board?.codeSessionId, creator.id);
  await wiring.handleAgent(successor, { sub: 'connect', board: boardId });
  assert.equal((await wiring.handleOperator.get(boardId)).board?.codeSessionId, successor.id);
  await wiring.handleAgent({ id: 'refs-latecomer', name: 'latecomer', project }, { sub: 'connect', board: boardId });
  assert.equal((await wiring.handleOperator.get(boardId)).board?.codeSessionId, successor.id);

  const unfiledBoardId = ((await wiring.handleOperator.create('Operator sketch')) as { summary: { id: string } }).summary.id;
  assert.equal((await wiring.handleAgent(successor, { sub: 'delete', board: unfiledBoardId })).status, 403);
  assert.equal((await wiring.handleOperator.get(unfiledBoardId)).board?.project, null);
  await wiring.handleOperator.connect(unfiledBoardId, successor.id);
  assert.equal((await wiring.handleOperator.get(unfiledBoardId)).board?.codeSessionId, successor.id);

  assert.equal((await wiring.handleAgent(successor, { sub: 'delete', board: boardId })).status, 200);

  const movedBoardId = ((await wiring.handleAgent(creator, { sub: 'new', title: 'Moved plan' })).body as { board: { id: string } }).board.id;
  await wiring.handleAgent(creator, { sub: 'put', board: movedBoardId, ops: z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } }, refs: ['src/real.ts'] } }]) });
  fs.rmSync(project, { recursive: true, force: true });
  const movedReview = (await wiring.handleOperator.review(movedBoardId)).review;
  assert.notEqual(movedReview?.notChecked, null);
  assert.deepEqual(movedReview?.anchorWarnings.filter((warning) => warning.includes('could not be read')), []);
});

test('a new session first prompt names the five newest boards of its project in use, once', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'project-notice-'));
  let clockMs = Date.UTC(2026, 0, 1);
  const wiring = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  const project = path.join(boardsRoot, 'app');
  const author = { id: 'notice-author', name: 'author', project };
  const newBoardAt = async (caller: typeof author, title: string) => {
    clockMs += 60_000;
    const boardId = ((await wiring.handleAgent(caller, { sub: 'new', title })).body as { board: { id: string } }).board.id;
    await wiring.handleAgent(caller, { sub: 'disconnect', board: boardId });
    return boardId;
  };
  await newBoardAt(author, 'Archived plan');
  clockMs += 31 * 24 * 60 * 60 * 1000;
  const projectBoardIds: string[] = [];
  for (const title of ['Plan 1', 'Plan 2', 'Plan 3', 'Plan 4', 'Plan 5', 'Plan 6']) projectBoardIds.push(await newBoardAt(author, title));
  await newBoardAt({ id: 'notice-stranger', name: 'stranger', project: path.join(boardsRoot, 'other') }, 'Other plan');

  const named = projectBoardIds.slice(1).reverse().map((boardId, index) => `"Plan ${6 - index}" (${boardId})`).join(', ');
  assert.equal(wiring.takeBoardNotice('notice-newcomer', project), `This project has whiteboards from other sessions, newest first: ${named}. Read one with whiteboard get <id>, or connect to follow its changes.`);
  assert.equal(wiring.takeBoardNotice('notice-newcomer', project), null);
  assert.equal(wiring.takeBoardNotice('notice-elsewhere', path.join(boardsRoot, 'empty')), null);

  const restarted = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  await restarted.loaded;
  await restarted.handleAgent({ ...author, id: 'notice-newcomer' }, { sub: 'connect', board: projectBoardIds[5] ?? '' });
  assert.equal(restarted.takeBoardNotice(author.id, project), null);
  assert.ok(!restarted.takeBoardNotice('notice-newcomer', project)?.includes('Plan 6'));
});

test('the next prompt tells a connected session once per new change to read the board before changing it, leaving the changes unread', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'prompt-notice-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  const agent = { id: 'prompt-agent', name: 'prompt agent', project: boardsRoot };
  const created = await wiring.handleAgent(agent, { sub: 'new', title: 'Prompt plan' });
  const boardId = (created.body as { board: { id: string } }).board.id;
  const notice = `Board "Prompt plan" (${boardId}) changed since your last read. Read it with whiteboard get ${boardId} before you change it.`;
  await wiring.handleAgent(agent, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'board', caption: 'agent caption' }]) });
  assert.equal(wiring.takeBoardNotice(agent.id, null), null);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', place: { at: { x: 40, y: 40 } } } }]));
  assert.equal(wiring.takeBoardNotice(agent.id, null), notice);
  assert.equal(wiring.takeBoardNotice(agent.id, null), null);
  assert.equal(wiring.snapshotMessage().boards.find((board) => board.id === boardId)?.queuedBySessionId[agent.id], 1);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'set', id: 'parse', fields: { title: 'Parse feed' } }]));
  assert.equal(wiring.takeBoardNotice(agent.id, null), notice);

  const read = await wiring.handleAgent(agent, { sub: 'get', board: boardId });
  assert.deepEqual((read.body as { changes: { summary: string }[] }).changes.map((change) => change.summary), ['operator added box "Parse"; operator renamed "Parse" to "Parse feed"']);
  assert.equal(wiring.takeBoardNotice(agent.id, null), null);

  await wiring.handleAgent(agent, { sub: 'disconnect', board: boardId });
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'n1', shape: 'note', title: 'handle drafts', place: { at: { x: 300, y: 40 } } } }]));
  assert.equal(wiring.takeBoardNotice(agent.id, null), null);
});

test('the same bytes attached at once under an svg and an html name are stored once as one kind', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'asset-race-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  await wiring.loaded;
  const markup = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="30" height="10"><rect width="30" height="10"/></svg>';
  const racedPaths = ['race.svg', 'race.html'].map((racedName) => path.join(boardsRoot, racedName));
  for (const racedPath of racedPaths) fs.writeFileSync(racedPath, markup);
  const [asSvg, asPage] = await Promise.all(racedPaths.map((racedPath) => wiring.assets.ingestFile(racedPath)));
  assert.ok(asSvg?.ok && asPage?.ok);
  assert.deepEqual({ ...asPage.media, source: null }, { ...asSvg.media, source: null });
  assert.equal(fs.readdirSync(path.join(boardsRoot, 'assets')).length, 1);
});

test('a stored file keeps the preview it was stored with when attached again after a restart, whether or not the preview can be read', async () => {
  const { default: sharp } = await import('sharp');
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'asset-restart-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  await wiring.loaded;
  const widePath = path.join(boardsRoot, 'wide.png');
  await sharp({ create: { width: 2000, height: 400, channels: 3, background: '#f472b6' } }).png().toFile(widePath);
  const first = await wiring.assets.ingestFile(widePath);
  assert.ok(first.ok && first.media.hasPreview);
  const boardId = ((await wiring.handleOperator.create('wide')) as { summary: { id: string } }).summary.id;
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'wide', title: 'wide', media: first.media, place: { at: { x: 0, y: 0 } } } }]));
  fs.rmSync(path.join(boardsRoot, 'assets', `${first.media.asset}.preview.webp`));
  const restarted = createWhiteboardWiring({ boardsRoot });
  await restarted.loaded;
  const again = await restarted.assets.ingestFile(widePath);
  assert.ok(again.ok);
  assert.equal(again.media.hasPreview, false);
  const ffmpegPath = resolveFfmpegPath();
  assert.ok(ffmpegPath, 'ffmpeg-static is installed');
  const clipPath = path.join(boardsRoot, 'clip.webm');
  await execFileAsync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=5:duration=1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-y', clipPath]);
  const clip = await restarted.assets.ingestFile(clipPath);
  assert.ok(clip.ok && clip.media.hasPreview);
  await restarted.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'clip', title: 'clip', media: clip.media, place: { at: { x: 0, y: 200 } } } }]));
  fs.writeFileSync(path.join(boardsRoot, 'assets', `${clip.media.asset}.preview.webp`), 'not a picture');
  const restartedAgain = createWhiteboardWiring({ boardsRoot });
  await restartedAgain.loaded;
  const clipAgain = await restartedAgain.assets.ingestFile(clipPath);
  assert.ok(clipAgain.ok);
  assert.equal(clipAgain.media.hasPreview, true);
  assert.equal(restartedAgain.assets.mismatchOf(clip.media), null);
});

test('a video whose ffmpeg crashes or cannot decode it is kept without a first frame, while one whose ffmpeg is killed or runs out of disk is refused so it can be attached again', { skip: process.platform === 'win32' }, async () => {
  const ffmpegPath = resolveFfmpegPath();
  assert.ok(ffmpegPath, 'ffmpeg-static is installed');
  const workRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'poster-failure-'));
  const clipPath = path.join(workRoot, 'clip.webm');
  await execFileAsync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=5:duration=1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-y', clipPath]);
  const attachScriptPath = path.join(workRoot, 'attach.ts');
  const assetsModuleUrl = new URL('../server/whiteboard/whiteboard-assets.ts', import.meta.url).href;
  fs.writeFileSync(attachScriptPath, `import { createWhiteboardAssetStore } from ${JSON.stringify(assetsModuleUrl)};\nconst store = createWhiteboardAssetStore({ boardsRoot: process.argv[2] });\nawait store.loaded;\nconsole.log(JSON.stringify(await store.ingestFile(process.argv[3])));\n`);
  const attachWithFakeFfmpeg = async (name: string, script: string) => {
    const fakeFfmpegPath = path.join(workRoot, `ffmpeg-${name}`);
    fs.writeFileSync(fakeFfmpegPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const { stdout } = await execFileAsync(stableLauncherPath(), [attachScriptPath, fs.mkdtempSync(path.join(workRoot, 'boards-')), clipPath], { env: { ...process.env, FFMPEG_BIN: fakeFfmpegPath } });
    return JSON.parse(stdout) as { ok: boolean; status?: number; media?: { hasPreview: boolean } };
  };
  for (const [name, script] of [['crash', 'kill -SEGV $$'], ['undecodable', 'echo "Invalid data found when processing input" >&2; exit 1']]) {
    const kept = await attachWithFakeFfmpeg(name, script);
    assert.deepEqual([name, kept.ok, kept.media?.hasPreview], [name, true, false], JSON.stringify(kept));
  }
  for (const [name, script] of [['killed', 'kill -KILL $$'], ['disk-full', 'echo "Error writing trailer: No space left on device" >&2; exit 1']]) {
    const refused = await attachWithFakeFfmpeg(name, script);
    assert.deepEqual([name, refused.ok, refused.status], [name, false, 503], JSON.stringify(refused));
  }
});

test('a large picture whose preview write runs out of disk is refused so it can be attached again, while one whose preview cannot be made is kept', async () => {
  const { default: sharp } = await import('sharp');
  const workRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'preview-failure-'));
  const picturePath = path.join(workRoot, 'wide.png');
  await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#336699' } }).png().toFile(picturePath);
  const realSharpUrl = pathToFileURL(createRequire(import.meta.url).resolve('sharp')).href;
  const attachScriptPath = path.join(workRoot, 'attach.ts');
  const assetsModuleUrl = new URL('../server/whiteboard/whiteboard-assets.ts', import.meta.url).href;
  fs.writeFileSync(attachScriptPath, `import { createWhiteboardAssetStore } from ${JSON.stringify(assetsModuleUrl)};\nconst store = createWhiteboardAssetStore({ boardsRoot: process.argv[2] });\nawait store.loaded;\nconsole.log(JSON.stringify(await store.ingestFile(process.argv[3])));\n`);
  const attachWithPreviewWriteFailing = async (name: string, failure: { message: string; code?: string }) => {
    const failingSharpPath = path.join(workRoot, `sharp-${name}.mjs`);
    fs.writeFileSync(failingSharpPath, `import realSharp from ${JSON.stringify(realSharpUrl)};\nexport default function sharp(...options) {\n  const pipeline = realSharp(...options);\n  pipeline.toFile = () => Promise.reject(Object.assign(new Error(${JSON.stringify(failure.message)}), ${JSON.stringify(failure.code ? { code: failure.code } : {})}));\n  return pipeline;\n}\n`);
    const hooksPath = path.join(workRoot, `hooks-${name}.mjs`);
    fs.writeFileSync(hooksPath, `export async function resolve(specifier, context, nextResolve) {\n  if (specifier === 'sharp') return { url: ${JSON.stringify(pathToFileURL(failingSharpPath).href)}, shortCircuit: true };\n  return nextResolve(specifier, context);\n}\n`);
    const registerPath = path.join(workRoot, `register-${name}.mjs`);
    fs.writeFileSync(registerPath, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooksPath).href)});\n`);
    const { stdout } = await execFileAsync(stableLauncherPath(), ['--import', registerPath, attachScriptPath, fs.mkdtempSync(path.join(workRoot, 'boards-')), picturePath]);
    return JSON.parse(stdout) as { ok: boolean; status?: number; media?: { hasPreview: boolean } };
  };
  const diskFull = await attachWithPreviewWriteFailing('disk-full', { message: 'write failed', code: 'ENOSPC' });
  assert.deepEqual([diskFull.ok, diskFull.status], [false, 503], JSON.stringify(diskFull));
  const unreadable = await attachWithPreviewWriteFailing('unreadable', { message: 'Input file has corrupt header' });
  assert.deepEqual([unreadable.ok, unreadable.media?.hasPreview], [true, false], JSON.stringify(unreadable));
});

test('a photo turned by its EXIF orientation is sized and drawn upright for the agent picture', async () => {
  const { default: sharp } = await import('sharp');
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'asset-orientation-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  await wiring.loaded;
  const photoPath = path.join(boardsRoot, 'turned.jpg');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#22d3ee' } }).jpeg().withMetadata({ orientation: 6 }).toFile(photoPath);
  const stored = await wiring.assets.ingestFile(photoPath);
  assert.ok(stored.ok);
  assert.deepEqual([stored.media.width, stored.media.height], [20, 40]);
  const dataUri = await wiring.assets.dataUriOf(stored.media, 20, 40);
  const drawn = await sharp(Buffer.from(String(dataUri).replace(/^data:image\/png;base64,/, ''), 'base64')).metadata();
  assert.deepEqual([drawn.width, drawn.height], [20, 40]);
});

test('deleting a board sweeps the pictures no live board shows, sparing a pending attach, a picture still shown elsewhere, and one a put released within the hour', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'asset-sweep-'));
  let clockMs = 1_800_000_000_000;
  const wiring = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  await wiring.loaded;
  const { default: sharp } = await import('sharp');
  const pictureOf = async (background: string) => {
    const picturePath = path.join(boardsRoot, `${background.slice(1)}.webp`);
    await sharp({ create: { width: 40, height: 20, channels: 3, background } }).webp().toFile(picturePath);
    const stored = await wiring.assets.ingestFile(picturePath);
    assert.ok(stored.ok);
    return stored.media;
  };
  const newBoardId = async (title: string) => ((await wiring.handleOperator.create(title)) as { summary: { id: string } }).summary.id;
  const putBox = (boardId: string, id: string, media: { asset: string } | null) => wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id, title: id, media, place: { at: { x: 0, y: 0 } } } }]));
  const storedFiles = () => fs.readdirSync(path.join(boardsRoot, 'assets')).sort();
  const filesOf = (assetIds: string[]) => assetIds.map((assetId) => `${assetId}.webp`).sort();
  const shared = await pictureOf('#c084fc');
  const onlyOnDoomed = await pictureOf('#22d3ee');
  const released = await pictureOf('#facc15');
  const doomedId = await newBoardId('doomed');
  const keptId = await newBoardId('kept');
  await putBox(doomedId, 'shared', shared);
  await putBox(doomedId, 'only', onlyOnDoomed);
  await putBox(keptId, 'shared', shared);
  await putBox(keptId, 'released', released);
  clockMs += 11 * 60_000;
  await wiring.handleOperator.put(keptId, z.array(Op).parse([{ op: 'remove', id: 'released' }]));
  const pending = await pictureOf('#4ade80');

  await wiring.handleOperator.remove(doomedId);
  const survivingFiles = filesOf([shared.asset, released.asset, pending.asset]);
  await waitFor(() => storedFiles().length === survivingFiles.length, 'the unused picture was swept');
  assert.deepEqual(storedFiles(), survivingFiles);
  assert.match(String(((await putBox(keptId, 'swept', onlyOnDoomed)) as { error: string }).error), /which no whiteboard attach stored/);
  assert.equal((await putBox(keptId, 'pending', pending)).ok, true);

  const keptFilePath = path.join(boardsRoot, `${keptId}.json`);
  const savedKept = JSON.parse(JSON.stringify({ board: (await wiring.handleOperator.get(keptId)).board, log: [], cursorBySessionId: {}, createdBy: null })) as { board: { elements: Record<string, Record<string, unknown>> } };
  await createBoardStore(boardsRoot).remove(keptId);
  const { media: sharedMedia, ...sharedWithoutMedia } = savedKept.board.elements.shared ?? {};
  const { kind: _kind, mime: _mime, hasPreview: _hasPreview, ...imageFromRelease051 } = sharedMedia as Record<string, unknown>;
  savedKept.board.elements.shared = { ...sharedWithoutMedia, image: imageFromRelease051 };
  savedKept.board.elements.plain = { ...sharedWithoutMedia, id: 'plain', image: null };
  fs.writeFileSync(keptFilePath, JSON.stringify(savedKept));
  clockMs += 61 * 60_000;
  const restarted = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  await restarted.loaded;
  assert.deepEqual(storedFiles(), filesOf([shared.asset, pending.asset]));
  const migrated = (await restarted.handleOperator.get(keptId)).board?.elements;
  const [sharedBox, plainBox] = [migrated?.get('shared'), migrated?.get('plain')];
  assert.deepEqual([sharedBox?.kind === 'box' ? sharedBox.media : undefined, plainBox?.kind === 'box' ? plainBox.media : undefined], [{ alt: '', ...imageFromRelease051, kind: 'image', mime: 'image/webp', hasPreview: false }, null], 'a board saved by 0.51.0 loads with media');

  fs.writeFileSync(path.join(boardsRoot, `${keptId}.json`), '{"board": "from a newer build"}');
  clockMs += 61 * 60_000;
  await createWhiteboardWiring({ boardsRoot, now: () => clockMs, logger: { warn: () => {} } }).loaded;
  assert.deepEqual(storedFiles(), filesOf([shared.asset, pending.asset]));
});

test('a board saved with units, panels, columns, lanes and retired fields loads them as step boxes, wires, panel boxes and free boxes stacked where their columns stood, with the retired fields dropped', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'saved-shapes-'));
  const before = createWhiteboardWiring({ boardsRoot });
  const planned = await before.handleOperator.create('planned');
  const plannedId = planned.summary?.id ?? '';
  const stepped = await before.handleOperator.put(plannedId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'u1', title: 'Unit', place: 'plan', step: {} } }]));
  assert.equal(stepped.ok, true, stepped.error ?? '');
  const plannedPath = path.join(boardsRoot, `${plannedId}.json`);
  const savedPlanned = JSON.parse(JSON.stringify({ board: (await before.handleOperator.get(plannedId)).board, log: [], cursorBySessionId: {}, createdBy: null })) as { board: Record<string, unknown> & { elements: Record<string, unknown> } };
  await createBoardStore(boardsRoot).remove(plannedId);
  savedPlanned.board.columns = [{ id: 'intake', title: 'Intake' }, { id: 'apply', title: 'Apply' }];
  savedPlanned.board.lanes = [{ id: 'main', label: 'Main', color: 'blue' }];
  savedPlanned.board.legend = [{ tone: 'lane', label: 'per lane' }, { tone: 'plain', dashed: false, back: true, label: 'retry' }];
  savedPlanned.board.elements.u1 = { kind: 'box', id: 'u1', title: 'Unit', step: { status: 'planned', linkedBoardId: 'gone-board' } };
  savedPlanned.board.elements.read = { kind: 'box', id: 'read', title: 'Read', column: 'intake', order: 1, lane: 'main', width: 400 };
  savedPlanned.board.elements.queue = { kind: 'box', id: 'queue', title: 'Queue', column: 'intake', order: 0 };
  savedPlanned.board.elements.write = { kind: 'box', id: 'write', title: 'Write', column: 'apply' };
  savedPlanned.board.elements.pinned = { kind: 'box', id: 'pinned', title: 'Pinned', column: 'apply', at: { x: 900, y: 500 } };
  savedPlanned.board.elements.handoff = { kind: 'wire', id: 'handoff', from: 'read', to: 'write', tone: 'lane', fromOutput: null, back: true };
  savedPlanned.board.elements['intake-frame'] = { kind: 'frame', id: 'intake-frame', title: 'Intake', contains: ['read', 'queue'], loop: true };
  savedPlanned.board.elements.pick = { kind: 'box', id: 'pick', title: 'Pick', shape: 'decision', outputs: [{ id: 'yes', label: 'yes' }], lines: [{ text: 'first', style: 'numbered', icon: 'check', ref: 'README.md' }] };
  savedPlanned.board.elements.schema = { kind: 'unit', id: 'schema', title: 'Add the schema', lines: [], refs: [], status: 'landed', after: [], linkedBoardId: null };
  savedPlanned.board.elements.route = { kind: 'unit', id: 'route', title: 'Serve the route', lines: [], refs: [], status: 'building', after: ['schema'], linkedBoardId: null };
  savedPlanned.board.elements.prior = { kind: 'panel', id: 'prior', title: 'Prior art', lines: [{ text: 'the old router', style: 'item', muted: false, ref: null, key: null }], order: 2 };
  fs.writeFileSync(plannedPath, JSON.stringify(savedPlanned));

  const after = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  await after.loaded;
  const upgraded = Board.parse((await after.handleOperator.get(plannedId) as { board?: unknown }).board);
  assert.deepEqual(planSteps(upgraded).map((step) => [step.boxId, step.label, step.status, step.afterLabels]), [['schema', '1a', 'landed', []], ['u1', '1b', 'planned', []], ['route', '2', 'building', ['1a']]]);
  const placeOf = (boxId: string) => {
    const element = upgraded.elements.get(boxId);
    return element?.kind === 'box' ? pointOfBox(element) : null;
  };
  assert.deepEqual(['queue', 'read', 'write', 'pinned'].map(placeOf), [
    { x: 40, y: 40 },
    { x: -50, y: 114 },
    { x: 530, y: 40 },
    { x: 900, y: 500 },
  ]);
  const handoff = upgraded.elements.get('handoff');
  assert.deepEqual([handoff?.kind === 'wire' && handoff.tone, upgraded.legend.map((entry) => entry.label)], ['plain', ['per lane']]);
  const pick = upgraded.elements.get('pick');
  assert.ok(pick?.kind === 'box');
  const unit = upgraded.elements.get('u1');
  assert.deepEqual([pick.shape, pick.lines, unit?.kind === 'box' ? unit.step : null], ['decision', [{ text: 'first', muted: false, style: 'item', key: null }], { status: 'planned' }]);
  const priorPanel = upgraded.elements.get('prior');
  assert.ok(priorPanel?.kind === 'box');
  assert.deepEqual([priorPanel.shape, priorPanel.title, priorPanel.lines.map((line) => line.text), priorPanel.order, priorPanel.place], ['box', 'Prior art', ['the old router'], 2, 'aside']);
  const renamed = await after.handleOperator.put(plannedId, z.array(Op).parse([{ op: 'board', title: 'renamed' }]));
  assert.equal(renamed.ok, true, renamed.error ?? '');
  const store = createBoardStore(boardsRoot);
  const plannedHead = (await store.loadHeads()).records.find((record) => record.board.id === plannedId);
  const storedPlanned = plannedHead ? await store.loadElements(plannedHead) : null;
  assert.ok(storedPlanned);
  assert.equal(/"kind":"(unit|panel)"|"columns"|"lanes"|"column"|"lane"|"outputs"|"fromOutput"|"back"|"loop"|"linkedBoardId"|"numbered"/.test(JSON.stringify(storedPlanned)), false);
});

test('show puts each file on a board the session is connected to, creating one named after the first file title, placing later cards right of the last and numbering past an oversized shown id', async () => {
  const { default: sharp } = await import('sharp');
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'show-'));
  const showerDir = fs.mkdtempSync(path.join(fixture.tmpDir, 'shower-'));
  fs.writeFileSync(path.join(showerDir, 'login.png'), await sharp({ create: { width: 64, height: 32, channels: 3, background: '#38bdf8' } }).png().toBuffer());
  fs.writeFileSync(path.join(showerDir, 'report.html'), '<!doctype html><html><head><title>Weekly report</title></head><body>numbers</body></html>');
  const wiring = createWhiteboardWiring({ boardsRoot });
  const shower = { id: 'show-agent', name: 'checkout fix', project: showerDir, cwd: showerDir };

  const first = await wiring.handleAgent(shower, { sub: 'show', path: 'login.png', caption: 'login after fix' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const boardId = (first.body as { board: { id: string; title: string; connectedSessionIds: string[] } }).board.id;
  assert.deepEqual(wiring.snapshotMessage().boards.map(({ id, title, connectedSessionIds }) => ({ id, title, connectedSessionIds })), [{ id: boardId, title: 'login', connectedSessionIds: [shower.id] }]);

  const second = await wiring.handleAgent(shower, { sub: 'show', path: 'report.html' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((second.body as { board: { id: string } }).board.id, boardId);

  const read = await wiring.handleAgent(shower, { sub: 'get', board: boardId });
  const shownBoard = Board.parse((read.body as { board: unknown }).board);
  const { elements } = shownBoard;
  const firstCard = elements.get('shown-1');
  const secondCard = elements.get('shown-2');
  assert.ok(firstCard?.kind === 'box' && firstCard.shape === 'box' && secondCard?.kind === 'box' && secondCard.shape === 'box');
  assert.deepEqual([firstCard.title, firstCard.lines.map((line) => line.text), firstCard.media?.kind, firstCard.media?.alt], ['login.png', ['login after fix'], 'image', 'login after fix']);
  assert.deepEqual([secondCard.title, secondCard.media?.kind], ['Weekly report', 'page']);
  const drawnCards = layoutBoard(shownBoard).elements.filter((element) => element.kind === 'box');
  const drawnFirst = drawnCards.find((element) => element.id === 'shown-1');
  const drawnSecond = drawnCards.find((element) => element.id === 'shown-2');
  assert.equal(drawnSecond?.x, (drawnFirst?.x ?? 0) + (drawnFirst?.width ?? 0) + 60);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'shown-1000000000000000000000', title: 'Odd id', place: { at: { x: 0, y: 0 } } } }]));
  const pastOddId = await wiring.handleAgent(shower, { sub: 'show', path: 'login.png' });
  assert.equal(pastOddId.status, 200, JSON.stringify(pastOddId.body));
  assert.match(String((pastOddId.body as { note: string }).note), /as box shown-3 /);
});

test('a shown page brings the files it refers to by relative path, served beside it, and the reply names each local file that did not load', { skip: process.platform === 'win32' }, async () => {
  const plannerDir = path.join(fixture.tmpDir, PLANNER_ID);
  const pageDir = path.join(plannerDir, 'evidence');
  fs.mkdirSync(path.join(pageDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(pageDir, 'fonts'), { recursive: true });
  const shotBytes = Buffer.from('not really a png, bytes are bytes');
  fs.writeFileSync(path.join(pageDir, 'shots', 'before.png'), shotBytes);
  fs.writeFileSync(path.join(pageDir, 'fonts', 'mono.woff2'), 'font bytes');
  fs.writeFileSync(path.join(pageDir, 'style.css'), 'body { font-family: m; } @font-face { font-family: m; src: url("fonts/mono.woff2"); }');
  fs.writeFileSync(path.join(pageDir, 'app.js'), "import { shout } from './lib.js';\nshout();");
  fs.writeFileSync(path.join(pageDir, 'lib.js'), 'export function shout() {}');
  fs.writeFileSync(path.join(pageDir, 'notes.html'), '<!doctype html><p>notes</p>');
  fs.writeFileSync(path.join(pageDir, 'index.html'), '<!doctype html><p>a sibling index</p>');
  fs.writeFileSync(path.join(plannerDir, 'outside.png'), 'outside bytes');
  fs.symlinkSync(path.join(plannerDir, 'outside.png'), path.join(pageDir, 'linked-out.png'));
  fs.writeFileSync(path.join(pageDir, 'report.html'), '<!doctype html><html><head><title>Before and after</title><link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script></head><body><img src="shots/before.png?v=2"><img src="../outside.png"><img src="linked-out.png"><img src="missing.png"><img src="/abs.png"><img src="https://example.com/remote.png"><a href="notes.html">notes</a><a href="index.html">index</a></body></html>');

  const shown = await whiteboard(PLANNER_ID, { sub: 'show', path: 'evidence/report.html' });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  const note = String(shown.body.note);
  assert.match(note, /5 local files the page refers to do not load: \.\.\/outside\.png in report\.html \(outside the page folder\), linked-out\.png in report\.html \(outside the page folder\), missing\.png in report\.html \(missing\), \/abs\.png in report\.html \(an absolute path, which leaves the page folder\), index\.html in report\.html \(named index\.html/);
  assert.doesNotMatch(note, /remote\.png|before\.png|lib\.js/);
  const board = (shown.body as { board: { id: string } }).board.id;
  const { board: shownBoard } = await boardOf(PLANNER_ID, board);
  const shownBoxId = /as box (\S+) /.exec(note)?.[1] ?? '';
  const pageMedia = shownBoard.elements[shownBoxId]?.media as { kind: string; asset: string } | undefined;
  assert.equal(pageMedia?.kind, 'page');

  const opened = await fetch(`${running().base}/frames/open/whiteboards/pages/${pageMedia.asset}/index.html?tuned=1`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  const keyedPagePath = String(opened.headers.get('location'));
  assert.match(keyedPagePath, new RegExp(`^/frames/[0-9a-f]{64}/whiteboards/pages/${pageMedia.asset}/index\\.html\\?tuned=1$`));
  const keyedPageBase = `${running().base}${keyedPagePath.replace(/index\.html\?tuned=1$/, '')}`;
  const pageUrl = (memberPath: string) => `${keyedPageBase}${memberPath}`;
  assert.equal((await fetch(pageUrl('shots/before.png').replace(/\/frames\/[0-9a-f]{64}\//, `/frames/${'0'.repeat(64)}/`))).status, 404, 'a wrong key serves nothing');
  const servedPage = await fetch(pageUrl('index.html'));
  assert.equal(servedPage.status, 200);
  assert.equal(servedPage.headers.get('content-disposition'), null);
  const namedPage = await fetch(`${pageUrl('index.html')}?tuned=1&name=${encodeURIComponent('Before and after.html')}`);
  assert.equal(namedPage.headers.get('content-disposition'), `inline; filename="Before and after.html"; filename*=UTF-8''Before%20and%20after.html`);
  assert.match(String(servedPage.headers.get('content-security-policy')), /^sandbox allow-scripts/);
  assert.match(await servedPage.text(), /<img src="shots\/before\.png\?v=2">/);
  const servedShot = await fetch(pageUrl('shots/before.png'));
  assert.deepEqual([servedShot.status, servedShot.headers.get('content-type'), servedShot.headers.get('content-security-policy')], [200, 'image/png', "default-src 'none'; sandbox"]);
  assert.deepEqual(Buffer.from(await servedShot.arrayBuffer()), shotBytes);
  const servedModule = await fetch(pageUrl('lib.js'), { headers: { origin: 'null' } });
  assert.deepEqual([servedModule.status, servedModule.headers.get('content-type'), servedModule.headers.get('access-control-allow-origin')], [200, 'text/javascript; charset=utf-8', 'null']);
  assert.equal((await fetch(pageUrl('fonts/mono.woff2'))).status, 200, 'a font a referenced stylesheet loads is bundled too');
  assert.equal((await fetch(pageUrl('linked-out.png'))).status, 404);
  const servedSubPage = await fetch(pageUrl('notes.html'));
  assert.match(String(servedSubPage.headers.get('content-security-policy')), /^sandbox allow-scripts/, 'a page the shown page links to runs as a page, not as inert media');
  assert.equal((await fetch(pageUrl('report.html'))).status, 404);
});

test('a linked page keeps its bundle on each read, follows edits to a file it refers to, and still shows when one of them cannot be read', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'linked-page-'));
  const worktree = path.join(boardsRoot, 'worktree');
  fs.mkdirSync(path.join(worktree, 'report'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'report', 'shot.png'), 'first shot');
  fs.writeFileSync(path.join(worktree, 'report', 'locked.png'), 'locked shot');
  fs.chmodSync(path.join(worktree, 'report', 'locked.png'), 0o000);
  const pageText = '<!doctype html><html><body><img src="shot.png"><img src="locked.png"></body></html>';
  fs.writeFileSync(path.join(worktree, 'report', 'page.html'), pageText);
  const wiring = createWhiteboardWiring({ boardsRoot, codeContextOf: () => ({ root: worktree, buildChangeMap: () => Promise.reject(new Error('no change map in this test')) }) });
  const linker = { id: 'link-page-agent', name: 'linker', project: worktree, cwd: worktree };

  const shown = await wiring.handleAgent(linker, { sub: 'show', path: 'report/page.html', link: true });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.match(String((shown.body as { note: string }).note), /locked\.png in page\.html \(not readable\)/);
  const boardId = (shown.body as { board: { id: string } }).board.id;
  const linkedMediaOf = async () => {
    const card = (await wiring.handleOperator.get(boardId)).board?.elements.get('shown-1');
    return card?.kind === 'box' ? card.media : null;
  };
  const shownAsset = (await linkedMediaOf())?.asset;
  const pageFileHash = crypto.createHash('sha256').update(pageText).digest('hex');
  assert.notEqual(shownAsset, pageFileHash);
  const versionAfterRead = (await wiring.handleOperator.get(boardId)).board?.version;
  assert.equal((await linkedMediaOf())?.asset, shownAsset);
  assert.equal((await wiring.handleOperator.get(boardId)).board?.version, versionAfterRead, 'an unchanged linked page is in sync, so a read writes nothing');

  fs.writeFileSync(path.join(worktree, 'report', 'shot.png'), 'second shot');
  const followed = await linkedMediaOf();
  assert.notEqual(followed?.asset, shownAsset);
  assert.notEqual(followed?.asset, pageFileHash);
  assert.equal(followed?.link?.syncedHash, followed?.asset);

  fs.writeFileSync(path.join(worktree, 'report', 'page.html'), `${pageText}<img src="gone.png">`);
  const resynced = await wiring.handleAgent(linker, { sub: 'get', board: boardId, review: true });
  const resyncedLinkStates = (resynced.body as { review: { linkStates: { text: string }[] } }).review.linkStates;
  assert.match(resyncedLinkStates[0]?.text ?? '', /gone\.png in page\.html \(missing\)/, 'a page edit that breaks a reference is reported on the read that follows it');
  fs.chmodSync(path.join(worktree, 'report', 'locked.png'), 0o600);
});

test('a linked card follows its file in the code session worktree on each read, writes it on an operator save unless either side moved, refuses a path outside it, and keeps its last text with the reason once the file or session is gone', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'linked-'));
  const worktree = path.join(boardsRoot, 'worktree');
  fs.mkdirSync(path.join(worktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'docs', 'plan.md'), '# Plan\n\nfirst draft\n', 'utf8');
  fs.writeFileSync(path.join(boardsRoot, 'outside.md'), '# Outside\n', 'utf8');
  const liveSessionIds = new Set(['link-agent']);
  const wiring = createWhiteboardWiring({ boardsRoot, codeContextOf: (sessionId) => (liveSessionIds.has(sessionId) ? { root: worktree, buildChangeMap: () => Promise.reject(new Error('no change map in this test')) } : null) });
  const linker = { id: 'link-agent', name: 'linker', project: worktree, cwd: worktree };

  const shown = await wiring.handleAgent(linker, { sub: 'show', path: 'docs/plan.md', link: true });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.match(String((shown.body as { note: string }).note), /linked to docs\/plan\.md/);
  const boardId = (shown.body as { board: { id: string } }).board.id;
  const linkedMediaOf = async () => {
    const card = (await wiring.handleOperator.get(boardId)).board?.elements.get('shown-1');
    return card?.kind === 'box' ? card.media : null;
  };
  assert.equal((await linkedMediaOf())?.link?.path, 'docs/plan.md');

  fs.writeFileSync(path.join(worktree, 'docs', 'plan.md'), '# Plan\n\nsecond draft\n', 'utf8');
  const followed = await wiring.handleAgent(linker, { sub: 'doc', board: boardId, box: 'shown-1' });
  assert.equal((followed.body as { text: string }).text, '# Plan\n\nsecond draft\n');
  const followedMedia = await linkedMediaOf();
  assert.equal(followedMedia?.link?.syncedHash, followedMedia?.asset);

  const outside = await wiring.handleAgent(linker, { sub: 'show', path: '../outside.md', link: true });
  assert.equal(outside.status, 409, JSON.stringify(outside.body));
  const climbing = await wiring.handleAgent(linker, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'set', id: 'shown-1', fields: { media: { ...followedMedia, link: { path: '../outside.md', syncedHash: null } } } }]) });
  assert.equal(climbing.status, 400, JSON.stringify(climbing.body));
  const { default: sharp } = await import('sharp');
  fs.writeFileSync(path.join(worktree, 'shot.png'), await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c084fc' } }).png().toBuffer());
  const attachedShot = await wiring.handleAgent(linker, { sub: 'attach', path: 'shot.png' });
  const shotMedia = BoxMedia.parse('media' in attachedShot.body ? attachedShot.body.media : null);
  const relabeledAsImage = await wiring.handleAgent(linker, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'set', id: 'shown-1', fields: { media: { ...shotMedia, link: followedMedia?.link } } }]) });
  assert.equal(relabeledAsImage.status, 400, JSON.stringify(relabeledAsImage.body));

  const planPath = path.join(worktree, 'docs', 'plan.md');
  const saved = await wiring.handleOperator.saveLinkedDoc(boardId, 'shown-1', '# Plan\n\nedited on the board\n', followedMedia?.asset ?? '');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\n\nedited on the board\n');
  const savedMedia = await linkedMediaOf();
  assert.equal(savedMedia?.asset, saved.savedMedia?.asset);
  assert.equal(savedMedia?.link?.syncedHash, savedMedia?.asset);
  const staleSave = await wiring.handleOperator.saveLinkedDoc(boardId, 'shown-1', '# Plan\n\nfrom a stale editor\n', followedMedia?.asset ?? '');
  assert.deepEqual([staleSave.ok, staleSave.isConflict], [false, true]);
  const svgLedSave = await wiring.handleOperator.saveLinkedDoc(boardId, 'shown-1', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n\n# Plan\n', savedMedia?.asset ?? '');
  assert.equal(svgLedSave.ok, false);
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\n\nedited on the board\n');

  fs.writeFileSync(planPath, '# Plan\n\nedited by the agent\n', 'utf8');
  const behindSave = await wiring.handleOperator.saveLinkedDoc(boardId, 'shown-1', '# Plan\n\nfrom the editor\n', savedMedia?.asset ?? '');
  assert.deepEqual([behindSave.ok, behindSave.isConflict], [false, true]);
  const queried = await wiring.handleAgent(linker, { sub: 'query', board: boardId, ids: ['shown-1'] });
  assert.ok(!JSON.stringify(queried.body).includes(savedMedia?.asset ?? ''), 'a save refused for a file change pulls the file into the card, so the editor reload shows it');
  fs.writeFileSync(planPath, '# Plan\n\nedited on the board\n', 'utf8');
  await wiring.handleOperator.get(boardId);

  const undone = await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'set', id: 'shown-1', fields: { media: followedMedia } }]));
  assert.equal(undone.ok, true, JSON.stringify(undone));
  const undoneReview = (await wiring.handleOperator.review(boardId)).review;
  assert.deepEqual(undoneReview?.linkStates.map(({ state, text }) => [state, text]), [['card-ahead', 'Not saved to file']]);
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\n\nedited on the board\n');

  fs.writeFileSync(planPath, '# Plan\n\nedited in the repo\n', 'utf8');
  const divergedSave = await wiring.handleOperator.saveLinkedDoc(boardId, 'shown-1', '# Plan\n\nboard wins\n', followedMedia?.asset ?? '');
  assert.deepEqual([divergedSave.ok, divergedSave.isConflict], [false, true]);
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\n\nedited in the repo\n');

  fs.rmSync(path.join(worktree, 'docs', 'plan.md'));
  const missingReview = (await wiring.handleOperator.review(boardId)).review;
  assert.deepEqual(missingReview?.linkStates, [{ boxId: 'shown-1', state: 'broken', text: 'File missing in the code session worktree' }]);
  const keptText = await wiring.handleAgent(linker, { sub: 'doc', board: boardId, box: 'shown-1' });
  assert.equal((keptText.body as { text: string }).text, '# Plan\n\nsecond draft\n');

  liveSessionIds.clear();
  const goneReview = (await wiring.handleOperator.review(boardId)).review;
  assert.deepEqual(goneReview?.linkStates.map(({ state, text }) => [state, text]), [['broken', 'The board code session is not running, so the linked file cannot be read']]);

  const linkedElements = copyOfElements((await wiring.handleOperator.get(boardId)).board?.elements ?? assert.fail('the board is readable'));
  assert.ok(boardIndexOf(linkedElements).linkedBoxIds.has('shown-1'));
  dropElement(linkedElements, 'shown-1');
  assert.equal(boardIndexOf(linkedElements).linkedBoxIds.has('shown-1'), false, 'a removed linked card leaves the linked-box index');
});

test('a board show creates is renamed once by the title lane, never over a rename the operator made first', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'show-named-'));
  const showerDir = fs.mkdtempSync(path.join(fixture.tmpDir, 'show-named-shower-'));
  fs.writeFileSync(path.join(showerDir, 'report.html'), '<!doctype html><html><head><title>Weekly report</title></head><body>numbers</body></html>');
  const lanePrompts: string[] = [];
  const pendingNamings: Promise<void>[] = [];
  const refiner = createTaskTitleRefiner({
    getConfig: () => ({}),
    spawnLane: async ({ cwd }) => {
      lanePrompts.push(fs.readFileSync(path.join(cwd, 'task-title-prompt.txt'), 'utf8'));
      fs.writeFileSync(path.join(cwd, 'task-title-result.json'), JSON.stringify({ title: 'Revenue dashboard draft' }));
    },
    retitleBoard: (boardId, provisionalTitle, title) => wiring.retitleProvisionalBoard(boardId, provisionalTitle, title),
  });
  const wiring = createWhiteboardWiring({
    boardsRoot,
    onBoardNamedProvisionally: (naming) => pendingNamings.push(refiner.nameBoard({ ...naming, sessionName: 'checkout fix', taskTitle: 'Chart the numbers' })),
  });
  const shower = { id: 'named-agent', name: 'checkout fix', project: showerDir, cwd: showerDir };
  const titleOf = (boardId: string) => wiring.snapshotMessage().boards.find((board) => board.id === boardId)?.title;

  const shown = await wiring.handleAgent(shower, { sub: 'show', path: 'report.html' });
  const boardId = (shown.body as { board: { id: string } }).board.id;
  await Promise.all(pendingNamings);
  assert.match(lanePrompts[0], /"Weekly report"/);
  assert.match(lanePrompts[0], /"checkout fix"/);
  assert.equal(titleOf(boardId), 'Revenue dashboard draft');

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'board', title: 'Mine' }]));
  assert.equal(await wiring.retitleProvisionalBoard(boardId, 'Revenue dashboard draft', 'Late lane title'), false);
  assert.equal(titleOf(boardId), 'Mine');
  await refiner.stop();
});

test('an agent reads operator ink as bounds and may remove it, but is refused drawing or changing a stroke', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'ink-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  const agent = { id: 'ink-agent', name: 'ink agent', project: boardsRoot };
  const created = await wiring.handleAgent(agent, { sub: 'new', title: 'Ink' });
  const boardId = (created.body as { board: { id: string } }).board.id;
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'stroke', id: 'ink', points: [40, 60, 140, 60, 140, 160], width: 4 } }]));

  const read = await wiring.handleAgent(agent, { sub: 'get', board: boardId });
  const elements = (read.body as { elements?: unknown[] }).elements;
  assert.deepEqual(elements, [{ kind: 'stroke', id: 'ink', bounds: { x: 38, y: 58, width: 104, height: 104 }, pointCount: 3, width: 4, tone: 'ink' }]);

  const drawn = await wiring.handleAgent(agent, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'add', element: { kind: 'stroke', id: 'mine', points: [0, 0, 10, 10] } }]) });
  assert.equal((drawn.body as { error?: string }).error, 'op 1: only the operator draws strokes; an agent may read or remove one, so nothing changed');
  const changed = await wiring.handleAgent(agent, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'set', id: 'ink', fields: { tone: 'pink' } }]) });
  assert.equal((changed.body as { error?: string }).error, 'op 1: only the operator changes strokes; an agent may read or remove one, so nothing changed');
  const removed = await wiring.handleAgent(agent, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'remove', id: 'ink' }]) });
  assert.equal(removed.status, 200);
});
