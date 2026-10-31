import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { z } from 'zod';

import { createBackend } from '../server/backend/backend.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { Op, WHITEBOARD_LIMITS } from '../shared/contracts/whiteboard.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';
import { createWhiteboardWiring } from '../server/whiteboard/whiteboard-wiring.ts';

const PLANNER_ID = 'whiteboard-planner';
const BUILDER_ID = 'whiteboard-builder';
const LEAVER_ID = 'whiteboard-leaver';

interface BootedBackend {
  server: Server;
  backend: Backend;
  base: string;
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
  return { server, backend, base: `http://127.0.0.1:${boundPort(server)}` };
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
  const { base, backend } = running();
  const token = backend.getSession(sessionId)?.agentToken;
  assert.ok(token, `${sessionId} was minted an agent token`);
  const response = await fetch(`${base}/agent/${sessionId}/whiteboard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const reply: Record<string, unknown> = await response.json();
  assert.ok(AGENT_REPLY_SCHEMAS.whiteboard.safeParse(reply).success, `the reply keeps its contract: ${JSON.stringify(reply)}`);
  return { status: response.status, body: reply };
}

async function boardOf(sessionId: string, boardId: string) {
  const reply = await whiteboard(sessionId, { sub: 'get', board: boardId });
  assert.equal(reply.status, 200);
  return reply.body as { board: { version: number; elements: Record<string, Record<string, unknown>> }; changes: { summary: string }[] };
}

async function newBoard(title: string): Promise<string> {
  const created = await whiteboard(PLANNER_ID, { sub: 'new', title });
  assert.equal(created.status, 200);
  const board = created.body.board as { id: string };
  const columns = await whiteboard(PLANNER_ID, { sub: 'put', board: board.id, ops: [
    { op: 'columns', columns: [{ id: 'intake', title: 'Intake' }, { id: 'apply', title: 'Apply' }] },
    { op: 'lanes', lanes: [{ id: 'pr1', label: 'PR 1', color: 'blue' }] },
  ] });
  assert.equal(columns.status, 200);
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

test('an agent builds a board of boxes, wires, frames, notes and boxes marked added, and removing a box takes its wires and notes', async () => {
  const boardId = await newBoard('knowledge writer');
  const built = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake', lane: 'pr1', lines: [{ text: 'reads the feed' }, { text: 'skips drafts', muted: true }] } },
    { op: 'add', element: { kind: 'box', id: 'store', title: 'Store', column: 'apply' } },
    { op: 'add', element: { kind: 'box', id: 'later', title: 'Later', column: 'apply', change: 'added' } },
    { op: 'add', element: { kind: 'wire', id: 'w1', from: 'parse', to: 'store', dashed: true, label: 'on retry' } },
    { op: 'add', element: { kind: 'frame', id: 'core', title: 'Core', contains: ['parse', 'store'] } },
    { op: 'add', element: { kind: 'note', id: 'n1', on: 'store', text: 'what about retries?' } },
    { op: 'set', id: 'parse', fields: { at: { x: 40, y: 80 } } },
  ] });
  assert.equal(built.status, 200);
  assert.equal(built.body.warnings, undefined);

  const blocked = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'later', fields: { at: { x: 250, y: 100 } } }] });
  assert.equal(blocked.status, 200);
  assert.ok((blocked.body.warnings as string[] | undefined)?.includes('wire w1 runs through box later'), JSON.stringify(blocked.body));

  const removed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'remove', id: 'store' }] });
  assert.equal(removed.status, 200);
  const { board } = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(Object.keys(board.elements).sort(), ['core', 'later', 'parse']);
  assert.deepEqual(board.elements.core?.contains, ['parse']);
  assert.deepEqual(board.elements.parse?.at, { x: 40, y: 80 });
  assert.equal(board.elements.later?.change, 'added');
});

test('two writers keep both different fields, the later write of one field wins, and the overwritten writer gets every change to the element in one line', async () => {
  const boardId = await newBoard('shared edits');
  assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: 'shared edits' })).status, 200);
  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake' } }] });
  await boardOf(PLANNER_ID, boardId);
  await boardOf(BUILDER_ID, boardId);

  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { title: 'Parse feed' } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { lines: [{ text: 'by the builder' }] } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'parse', fields: { title: 'Parse and store' } }] });

  const plannerView = await boardOf(PLANNER_ID, boardId);
  assert.equal(plannerView.board.elements.parse?.title, 'Parse and store');
  assert.deepEqual(plannerView.board.elements.parse?.lines, [{ text: 'by the builder', muted: false, style: 'text', key: null, ref: null }]);
  assert.deepEqual(plannerView.changes.map((change) => change.summary), [
    `${BUILDER_ID} changed lines of "Parse feed"; ${BUILDER_ID} renamed "Parse feed" to "Parse and store"`,
  ]);
  assert.deepEqual((await boardOf(PLANNER_ID, boardId)).changes, [], 'a get marks the summaries read');

  await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'note', id: 'n1', on: 'parse', text: 'keep prod' } }] });
  await whiteboard(BUILDER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'n1', fields: { text: 'drop prod' } }] });
  const rewritten = (await boardOf(PLANNER_ID, boardId)).board.elements.n1;
  assert.deepEqual([rewritten?.text, rewritten?.author], ['drop prod', BUILDER_ID], 'a rewritten note carries its rewriter as author');
});

test('a malformed or over-limit put is refused whole with a reason and the board is unchanged', async () => {
  const boardId = await newBoard('refusals');
  const before = await boardOf(PLANNER_ID, boardId);

  const strandedBox = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'ok', title: 'Fine', column: 'intake' } },
    { op: 'add', element: { kind: 'box', id: 'lost', title: 'Lost', column: 'nowhere' } },
  ] });
  assert.equal(strandedBox.status, 400);
  assert.match(String(strandedBox.body.error), /op 2: .*column nowhere/);

  const tooMany = Array.from({ length: WHITEBOARD_LIMITS.opsPerPut + 1 }, (_, index) => ({ op: 'add', element: { kind: 'box', id: `b${index}`, title: 'Box', column: 'intake' } }));
  const overLimit = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: tooMany });
  assert.equal(overLimit.status, 400);
  assert.match(String(overLimit.body.error), /at most 200 ops/);

  const forgedNote = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'target', title: 'Target', column: 'intake' } },
    { op: 'add', element: { kind: 'note', id: 'n1', on: 'target', text: 'mine' } },
    { op: 'set', id: 'n1', fields: { author: 'operator' } },
  ] });
  assert.equal(forgedNote.status, 400);
  assert.match(String(forgedNote.body.error), /op 3: set cannot change who wrote or resolved a note/);

  const unnamedRename = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'renamed', title: 'New name', column: 'intake', change: 'relabeled' } },
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
    op: 'add', element: { kind: 'box', id: `${prefix}${index}`, title: 'Box', column: 'intake', lines: Array.from({ length: WHITEBOARD_LIMITS.linesPerBox }, () => line) },
  }));

  const inside = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: boxesOf(100, 'a') });
  assert.equal(inside.status, 200);

  const past = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: boxesOf(200, 'b') });
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

test('a session deletes a board it created and is refused a board another session created', async () => {
  const boardId = await newBoard('agent made');
  const refused = await whiteboard(BUILDER_ID, { sub: 'delete', board: boardId });
  assert.equal(refused.status, 403);
  assert.equal((await whiteboard(BUILDER_ID, { sub: 'get', board: boardId })).status, 200);

  const deleted = await whiteboard(PLANNER_ID, { sub: 'delete', board: boardId });
  assert.equal(deleted.status, 200);
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'get', board: boardId })).body.error, 'that board was deleted');
});

async function runPlannerCli(context: test.TestContext, args: string[]): Promise<{ exitCode: number; printed: string }> {
  const { base, backend } = running();
  const printedLines: string[] = [];
  context.mock.method(console, 'log', (line: string) => { printedLines.push(line); });
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  process.env[AGENT_URL_ENV] = `${base}/agent/${PLANNER_ID}?t=${backend.getSession(PLANNER_ID)?.agentToken ?? ''}`;
  try {
    const exitCode = await runAgentApiCli(args);
    return { exitCode, printed: printedLines.join('\n') };
  } finally {
    context.mock.restoreAll();
    if (previousAgentUrl === undefined) delete process.env[AGENT_URL_ENV];
    if (previousAgentUrl !== undefined) process.env[AGENT_URL_ENV] = previousAgentUrl;
  }
}

test('an agent plans units through the CLI in dependency order, a cycle is refused, and deleting a linked board unlinks its unit', async (context) => {
  const boardId = await newBoard('search api');
  const detailBoardId = await newBoard('backfill design');
  const plan = (...args: string[]) => runPlannerCli(context, ['whiteboard', 'plan', ...args]);

  assert.equal((await plan('add', boardId, 'Diff index schema')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Search endpoint', '--after', 'diff-index-schema')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Index backfill', '--after', 'diff-index-schema', '--link', 'backfill design')).exitCode, 0);
  assert.equal((await plan('add', boardId, 'Search box')).exitCode, 0);
  assert.equal((await plan('after', boardId, 'search-box', 'search-endpoint')).exitCode, 0);

  const clash = await plan('add', boardId, 'Search box');
  assert.equal(clash.exitCode, 1);
  assert.match(clash.printed, /already exists/);
  assert.equal((await plan('add', boardId, 'Search box', '--id', 'search-box-2')).exitCode, 0);

  const cycle = await plan('after', boardId, 'diff-index-schema', 'search-box');
  assert.equal(cycle.exitCode, 1);
  assert.match(cycle.printed, /dependency cycle: diff-index-schema, search-box, search-endpoint, diff-index-schema/);

  assert.equal((await plan('status', boardId, 'diff-index-schema', 'shipped')).exitCode, 1);
  assert.equal((await plan('status', boardId, 'diff-index-schema', 'landed')).exitCode, 0);

  const shown = await plan('show', 'search', 'api');
  assert.equal(shown.exitCode, 0);
  const planLines = shown.printed.split('\n').slice(1, 6).map((line) => line.replace(/ +/g, ' ').trim());
  assert.deepEqual(planLines, [
    '1a diff-index-schema landed Diff index schema',
    '1b search-box-2 planned Search box',
    '2a index-backfill planned Index backfill after 1a board "backfill design"',
    '2b search-endpoint planned Search endpoint after 1a',
    '3 search-box planned Search box after 2b',
  ]);

  const deleted = await whiteboard(PLANNER_ID, { sub: 'delete', board: detailBoardId });
  assert.equal(deleted.status, 200);
  const { board, changes } = await boardOf(PLANNER_ID, boardId);
  assert.equal(board.elements['index-backfill']?.linkedBoardId, null);
  assert.ok(changes.some((change) => change.summary === 'Glimmervoid unlinked "Index backfill" from its board'), JSON.stringify(changes));

  const removed = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'remove', id: 'search-endpoint' }] });
  assert.equal(removed.status, 200);
  assert.deepEqual((await boardOf(PLANNER_ID, boardId)).board.elements['search-box']?.after, []);
});

test('an agent puts ops from a file, reads the laid-out positions and renders the board to an SVG file, and neither read consumes changes others made', async (context) => {
  const boardId = await newBoard('see it');
  const opsPath = path.join(fixture.tmpDir, 'see-it-ops.json');
  fs.writeFileSync(opsPath, JSON.stringify([
    { op: 'columns', columns: [{ id: 'intake', title: 'Intake' }, { id: 'store', title: 'Store' }] },
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse <feed>', column: 'intake' } },
    { op: 'add', element: { kind: 'box', id: 'save', title: 'Save', column: 'store' } },
    { op: 'add', element: { kind: 'wire', id: 'w1', from: 'parse', to: 'save', label: 'rows' } },
    { op: 'add', element: { kind: 'box', id: 'index', title: 'Index rows', column: 'store', change: 'relabeled', was: 'Cache rows' } },
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

test('refs are checked in the code session worktree: a missing file, a line past the end and a path leaving the worktree land as warnings that get --layout repeats', async (context) => {
  const worktree = path.join(fixture.tmpDir, PLANNER_ID);
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'feed.ts'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(fixture.tmpDir, 'outside.ts'), 'secret\n');
  fs.symlinkSync(path.join(fixture.tmpDir, 'outside.ts'), path.join(worktree, 'src', 'escape.ts'));
  const boardId = await newBoard('anchored');

  const put = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: {
      kind: 'box', id: 'parse', title: 'Parse', column: 'intake', refs: ['src/feed.ts#L2-L3', 'src/gone.ts', 'src/feed.ts#L9'],
      lines: [{ text: 'readFeed()', style: 'code', ref: '../outside.ts' }],
    } },
    { op: 'add', element: { kind: 'note', id: 'n1', on: 'parse', text: 'what about drafts?', ref: 'src/escape.ts' } },
  ] });
  const expectedWarnings = [
    'ref src/gone.ts on box parse: no such file',
    'ref src/feed.ts#L9 on box parse: the file has 3 lines',
    'ref ../outside.ts on line 1 of box parse: a path with .. is never read; name the file relative to the code session worktree',
    'ref src/escape.ts on note n1: the path leads outside the code session worktree, so it was not read',
  ];
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.warnings, expectedWarnings);

  const laidOut = await runPlannerCli(context, ['whiteboard', 'get', boardId, '--layout']);
  assert.equal(laidOut.exitCode, 0);
  const { review } = JSON.parse(laidOut.printed) as { review: unknown };
  assert.deepEqual(review, { codeSessionId: PLANNER_ID, anchorWarnings: expectedWarnings, unitWarnings: [], uncoveredPaths: [], worthALookPaths: [] });
});

test('a board with no code session takes the first session that connects, and only the other sessions hear of it', async () => {
  const boardId = await newBoard('unclaimed');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'board', codeSessionId: null }] })).status, 200);

  assert.equal((await whiteboard(BUILDER_ID, { sub: 'connect', board: boardId })).status, 200);

  const builderRead = await boardOf(BUILDER_ID, boardId);
  assert.equal((builderRead.board as { codeSessionId?: string }).codeSessionId, BUILDER_ID);
  assert.deepEqual(builderRead.changes, []);
  const plannerRead = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(plannerRead.changes.map((change) => change.summary), [`Glimmervoid set the code session to ${BUILDER_ID}`]);
});

test('a columns op with a move map carries boxes in one put, removing a box pins the boxes near it, and a box with no place is refused', async () => {
  const boardId = await newBoard('regroup');
  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake' } },
    { op: 'add', element: { kind: 'box', id: 'save', title: 'Save', column: 'apply' } },
  ] })).status, 200);

  const unmoved = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'columns', columns: [{ id: 'read', title: 'Read' }] }] });
  assert.equal(unmoved.status, 400);
  assert.match(String(unmoved.body.error), /box \w+ is still in removed column/);

  const moved = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'columns', columns: [{ id: 'read', title: 'Read' }], move: { intake: 'read', apply: 'read' } }] });
  assert.equal(moved.status, 200);
  const { board } = await boardOf(PLANNER_ID, boardId);
  assert.equal(board.elements.parse?.column, 'read');
  assert.equal(board.elements.save?.column, 'read');

  assert.equal((await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'aside', title: 'Aside', near: { of: 'save', side: 'right' } } },
    { op: 'remove', id: 'save' },
    { op: 'set', id: 'aside', fields: { title: 'Aside, kept' } },
  ] })).status, 200);
  const afterRemove = (await boardOf(PLANNER_ID, boardId)).board.elements.aside;
  assert.equal(afterRemove?.near, null);
  assert.ok(afterRemove?.at, 'a box near a removed box is pinned where it stood');

  const placeless = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'lost', title: 'Lost' } }] });
  assert.equal(placeless.status, 400);
  assert.match(String(placeless.body.error), /needs a place/);
});

test('the operator connects and disconnects a session from the dashboard, and a removed session leaves every board', async () => {
  const boardId = await newBoard('operator links');
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
    const moved = await command({ type: 'whiteboard-op', boardId, ops: [{ op: 'add', element: { kind: 'box', id: 'from-operator', title: 'Operator box', column: 'intake' } }], requestId: 'operator-op' });
    assert.equal(moved.ok, true);
    const builderView = await boardOf(BUILDER_ID, boardId);
    assert.deepEqual(builderView.changes.map((change) => change.summary), ['operator added box "Operator box"']);

    const disconnected = await command({ type: 'whiteboard-disconnect', boardId, sessionId: BUILDER_ID, requestId: 'disconnect-builder' });
    assert.equal(disconnected.ok, true);
    assert.equal(disconnected.summary?.connectedSessionIds.includes(BUILDER_ID), false);

    const unknown = await command({ type: 'whiteboard-connect', boardId, sessionId: 'no-such-session', requestId: 'connect-unknown' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'That session is no longer on the dashboard.');

    const leaverConnected = await command({ type: 'whiteboard-connect', boardId, sessionId: LEAVER_ID, requestId: 'connect-leaver' });
    assert.ok(leaverConnected.summary?.connectedSessionIds.includes(LEAVER_ID));
    const framesBeforeRemoval = control.received.length;
    const removed = await command({ type: 'remove-session', id: LEAVER_ID, requestId: 'remove-leaver' });
    assert.equal(removed.ok, true, String(removed.error));
    await waitForMessage(control.received, (frame) => control.received.indexOf(frame) >= framesBeforeRemoval && frame.type === 'whiteboards-snapshot'
      && frame.boards?.some((board) => board.id === boardId && !board.connectedSessionIds.includes(LEAVER_ID)) === true, 'the snapshot without the removed session');
  } finally {
    await closeSocket(control.ws);
  }
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

test('the next prompt carries what others changed and marks it read, so the next get holds only later changes', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'prompt-context-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  const agent = { id: 'prompt-agent', name: 'prompt agent' };
  const created = await wiring.handleAgent(agent, { sub: 'new', title: 'Prompt plan' });
  const boardId = (created.body as { board: { id: string } }).board.id;
  await wiring.handleOperator.put(boardId, z.array(Op).parse([
    { op: 'columns', columns: [{ id: 'intake', title: 'Intake' }] },
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake' } },
  ]));
  const queuedBefore = wiring.snapshotMessage().boards.find((board) => board.id === boardId);
  assert.equal(queuedBefore?.queuedBySessionId[agent.id], 2);

  const promptContext = wiring.takePromptContext(agent.id);
  assert.equal(promptContext, `Board "Prompt plan" (${boardId}) changed since your last read:\n- operator set the columns to Intake\n- operator added box "Parse"`);
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'set', id: 'parse', fields: { title: 'Parse feed' } }]));

  const read = await wiring.handleAgent(agent, { sub: 'get', board: boardId });
  assert.deepEqual((read.body as { changes: { summary: string }[] }).changes.map((change) => change.summary), ['operator renamed "Parse" to "Parse feed"']);
  assert.equal(wiring.takePromptContext(agent.id), null);
  assert.equal(wiring.snapshotMessage().boards.find((board) => board.id === boardId)?.queuedBySessionId[agent.id], 0);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'note', id: 'n1', on: 'parse', text: 'handle drafts', ref: 'src/feed.ts#L12' } }]));
  assert.equal(wiring.takePromptContext(agent.id), `Board "Prompt plan" (${boardId}) changed since your last read:\n- operator note on "Parse feed" at src/feed.ts#L12: handle drafts (note n1)`);
});

test('a flood of edits to one box stays inside the prompt context bound and leaves the board unread for the next get', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'prompt-bound-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  const reader = { id: 'bound-reader', name: 'bound reader' };
  const writer = { id: 'bound-writer', name: 'bound writer' };
  const created = await wiring.handleAgent(reader, { sub: 'new', title: 'Bound plan' });
  const boardId = (created.body as { board: { id: string } }).board.id;
  await wiring.handleAgent(writer, { sub: 'put', board: boardId, ops: z.array(Op).parse([
    { op: 'columns', columns: [{ id: 'intake', title: 'Intake' }] },
    { op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake' } },
  ]) });
  const renames = Array.from({ length: 150 }, (_, index) => ({ op: 'set', id: 'parse', fields: { title: `Parse step ${index} ${'x'.repeat(40)}` } }));
  await wiring.handleAgent(writer, { sub: 'put', board: boardId, ops: z.array(Op).parse(renames) });

  const promptContext = wiring.takePromptContext(reader.id) ?? '';
  assert.ok(promptContext.length <= WHITEBOARD_LIMITS.promptContextCharacters, `the context is ${promptContext.length} characters`);
  assert.match(promptContext, new RegExp(`run glimmervoid whiteboard get ${boardId} for the rest`));
  const read = await wiring.handleAgent(reader, { sub: 'get', board: boardId });
  assert.ok((read.body as { changes: unknown[] }).changes.length > 0, 'the clipped changes are still unread');
});

test('a board whose linked board vanished on restart still takes unrelated edits', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'dangling-link-'));
  const before = createWhiteboardWiring({ boardsRoot });
  const planned = await before.handleOperator.create('planned');
  const detail = await before.handleOperator.create('detail');
  const plannedId = planned.summary?.id ?? '';
  const detailId = detail.summary?.id ?? '';
  const linked = await before.handleOperator.put(plannedId, z.array(Op).parse([{ op: 'add', element: { kind: 'unit', id: 'u1', title: 'Unit', linkedBoardId: detailId } }]));
  assert.equal(linked.ok, true, linked.error ?? '');
  fs.writeFileSync(path.join(boardsRoot, `${detailId}.json`), '{corrupt', 'utf8');

  const after = createWhiteboardWiring({ boardsRoot, logger: { warn: () => {} } });
  const renamed = await after.handleOperator.put(plannedId, z.array(Op).parse([{ op: 'board', title: 'renamed' }]));
  assert.equal(renamed.ok, true, renamed.error ?? '');
  const relinked = await after.handleOperator.put(plannedId, z.array(Op).parse([{ op: 'add', element: { kind: 'unit', id: 'u2', title: 'Other', linkedBoardId: detailId } }]));
  assert.equal(relinked.ok, false);
});
