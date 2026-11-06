import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { z } from 'zod';

import { createBackend } from '../server/backend/backend.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { Board, Op, WHITEBOARD_LIMITS } from '../shared/contracts/whiteboard.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';
import { createWhiteboardWiring } from '../server/whiteboard/whiteboard-wiring.ts';
import { execFileAsync } from '../server/child-process-safe.ts';
import { resolveFfmpegPath } from '../server/runtime-paths.ts';
import { waitFor } from './helpers/wait-for.ts';

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
  const body = reply.body as { board: unknown; changes: { summary: string }[] };
  const board: { version: number; elements: Record<string, Record<string, unknown>> } = Board.parse(body.board);
  return { ...body, board };
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

  const blocked = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [{ op: 'set', id: 'later', fields: { at: { x: 250, y: 110 } } }] });
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
  assert.match(String(overLimit.body.error), new RegExp(`at most ${WHITEBOARD_LIMITS.opsPerPut} ops`));

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
    { op: 'add', element: { kind: 'box', id: 'login', title: 'Login', column: 'intake', media: { ...media, alt: 'login screen' } } },
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const { board } = await boardOf(PLANNER_ID, boardId);
  assert.deepEqual(board.elements.login?.media, { kind: 'image', asset: media.asset, mime: 'image/png', width: 640, height: 320, alt: 'login screen', hasPreview: false });
  const assetUrl = (filename: string) => `${running().base}/whiteboards/assets/${filename}`;
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
  const pasted = await fetch(`${running().base}/whiteboards/assets`, { method: 'POST', body: shotBytes, headers: { 'content-type': 'image/png', 'x-glimmervoid-upload-name': 'shot.png' } });
  assert.deepEqual(await pasted.json(), { ok: true, media });
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
  assert.deepEqual(svgAsPage.body.media, svg.body.media);
  assert.deepEqual(fs.readdirSync(path.join(fixture.tmpDir, 'whiteboards', 'assets')).sort(), [`${media.asset}.png`, `${svgMedia.asset}.svg`, `${pageMedia.asset}.html`, `${videoMedia.asset}.webm`, `${videoMedia.asset}.preview.webp`].sort());

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
    { op: 'add', element: { kind: 'box', id: 'clip-without-poster', title: 'Clip', column: 'intake', media: { ...videoMedia, hasPreview: false } } },
  ] });
  assert.equal(posterDropped.status, 400, JSON.stringify(posterDropped.body));
  await sharp({ create: { width: 2000, height: 400, channels: 3, background: '#38bdf8' } }).png().toFile(path.join(plannerDir, 'wide.png'));
  const wide = await whiteboard(PLANNER_ID, { sub: 'attach', path: 'wide.png' });
  const wideMedia = wide.body.media as { hasPreview: boolean };
  assert.equal(wideMedia.hasPreview, true);
  const previewDropped = await whiteboard(PLANNER_ID, { sub: 'put', board: boardId, ops: [
    { op: 'add', element: { kind: 'box', id: 'wide-without-preview', title: 'Wide', column: 'intake', media: { ...wideMedia, hasPreview: false } } },
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
  assert.deepEqual(review, { codeSessionId: PLANNER_ID, anchorWarnings: expectedWarnings, unitWarnings: [], uncoveredPaths: [], worthALookPaths: [], flaggedUnitIds: [], notChecked: null });
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

test('the operator connects and disconnects a session from the dashboard, and a removed session leaves every board and takes the boards only it was on', async () => {
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
    const leaverOnlyConnected = await command({ type: 'whiteboard-connect', boardId: leaverOnlyBoardId, sessionId: LEAVER_ID, requestId: 'connect-leaver-only' });
    assert.deepEqual(leaverOnlyConnected.summary?.connectedSessionIds, [LEAVER_ID]);
    const framesBeforeRemoval = control.received.length;
    const removed = await command({ type: 'remove-session', id: LEAVER_ID, requestId: 'remove-leaver' });
    assert.equal(removed.ok, true, String(removed.error));
    await waitForMessage(control.received, (frame) => control.received.indexOf(frame) >= framesBeforeRemoval && frame.type === 'whiteboards-snapshot'
      && frame.boards?.some((board) => board.id === boardId && !board.connectedSessionIds.includes(LEAVER_ID)) === true
      && frame.boards.every((board) => board.id !== leaverOnlyBoardId), 'the snapshot without the removed session or the board only it was on');
    const listed = await whiteboard(PLANNER_ID, { sub: 'list' });
    assert.deepEqual((listed.body.boards as { id: string }[]).filter((board) => board.id === leaverOnlyBoardId), []);
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

test('the next prompt tells a connected session once per new change to read the board before changing it, leaving the changes unread', async () => {
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'prompt-notice-'));
  const wiring = createWhiteboardWiring({ boardsRoot });
  const agent = { id: 'prompt-agent', name: 'prompt agent' };
  const created = await wiring.handleAgent(agent, { sub: 'new', title: 'Prompt plan' });
  const boardId = (created.body as { board: { id: string } }).board.id;
  const notice = `Board "Prompt plan" (${boardId}) changed since your last read. Read it with whiteboard get ${boardId} before you change it.`;
  await wiring.handleAgent(agent, { sub: 'put', board: boardId, ops: z.array(Op).parse([{ op: 'columns', columns: [{ id: 'intake', title: 'Intake' }] }]) });
  assert.equal(wiring.takeBoardNotice(agent.id), null);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'parse', title: 'Parse', column: 'intake' } }]));
  assert.equal(wiring.takeBoardNotice(agent.id), notice);
  assert.equal(wiring.takeBoardNotice(agent.id), null);
  assert.equal(wiring.snapshotMessage().boards.find((board) => board.id === boardId)?.queuedBySessionId[agent.id], 1);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'set', id: 'parse', fields: { title: 'Parse feed' } }]));
  assert.equal(wiring.takeBoardNotice(agent.id), notice);

  const read = await wiring.handleAgent(agent, { sub: 'get', board: boardId });
  assert.deepEqual((read.body as { changes: { summary: string }[] }).changes.map((change) => change.summary), ['operator added box "Parse"; operator renamed "Parse" to "Parse feed"']);
  assert.equal(wiring.takeBoardNotice(agent.id), null);

  await wiring.handleAgent(agent, { sub: 'disconnect', board: boardId });
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'note', id: 'n1', on: 'parse', text: 'handle drafts' } }]));
  assert.equal(wiring.takeBoardNotice(agent.id), null);
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
  assert.deepEqual(asPage.media, asSvg.media);
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
  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'wide', title: 'wide', media: first.media, at: { x: 0, y: 0 } } }]));
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
  await restarted.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'clip', title: 'clip', media: clip.media, at: { x: 0, y: 200 } } }]));
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
    const { stdout } = await execFileAsync(process.execPath, [attachScriptPath, fs.mkdtempSync(path.join(workRoot, 'boards-')), clipPath], { env: { ...process.env, FFMPEG_BIN: fakeFfmpegPath } });
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
    const { stdout } = await execFileAsync(process.execPath, ['--import', registerPath, attachScriptPath, fs.mkdtempSync(path.join(workRoot, 'boards-')), picturePath]);
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
  const putBox = (boardId: string, id: string, media: { asset: string } | null) => wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id, title: id, media, at: { x: 0, y: 0 } } }]));
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
  const savedKept = JSON.parse(fs.readFileSync(keptFilePath, 'utf8')) as { board: { elements: Record<string, Record<string, unknown>> } };
  const { media: sharedMedia, ...sharedWithoutMedia } = savedKept.board.elements.shared ?? {};
  const { kind: _kind, mime: _mime, hasPreview: _hasPreview, ...imageFromRelease051 } = sharedMedia as Record<string, unknown>;
  savedKept.board.elements.shared = { ...sharedWithoutMedia, image: imageFromRelease051 };
  savedKept.board.elements.plain = { ...sharedWithoutMedia, id: 'plain', image: null };
  fs.writeFileSync(keptFilePath, JSON.stringify(savedKept));
  clockMs += 61 * 60_000;
  const restarted = createWhiteboardWiring({ boardsRoot, now: () => clockMs });
  await restarted.loaded;
  assert.deepEqual(storedFiles(), filesOf([shared.asset, pending.asset]));
  const migrated = (await restarted.handleOperator.get(keptId)) as { board?: { elements: Record<string, { media?: unknown }> } };
  assert.deepEqual([migrated.board?.elements.shared?.media, migrated.board?.elements.plain?.media], [{ alt: '', ...imageFromRelease051, kind: 'image', mime: 'image/webp', hasPreview: false }, null], 'a board saved by 0.51.0 loads with media');

  fs.writeFileSync(path.join(boardsRoot, `${keptId}.json`), '{"board": "from a newer build"}');
  clockMs += 61 * 60_000;
  await createWhiteboardWiring({ boardsRoot, now: () => clockMs, logger: { warn: () => {} } }).loaded;
  assert.deepEqual(storedFiles(), filesOf([shared.asset, pending.asset]));
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

test('show puts each file on a board the session is connected to, creating one named after the session first, placing later cards right of the last and numbering past an oversized shown id', async () => {
  const { default: sharp } = await import('sharp');
  const boardsRoot = fs.mkdtempSync(path.join(fixture.tmpDir, 'show-'));
  const showerDir = fs.mkdtempSync(path.join(fixture.tmpDir, 'shower-'));
  fs.writeFileSync(path.join(showerDir, 'login.png'), await sharp({ create: { width: 64, height: 32, channels: 3, background: '#38bdf8' } }).png().toBuffer());
  fs.writeFileSync(path.join(showerDir, 'report.html'), '<!doctype html><html><head><title>Weekly report</title></head><body>numbers</body></html>');
  const wiring = createWhiteboardWiring({ boardsRoot });
  const shower = { id: 'show-agent', name: 'checkout fix', cwd: showerDir };

  const first = await wiring.handleAgent(shower, { sub: 'show', path: 'login.png', caption: 'login after fix' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const boardId = (first.body as { board: { id: string; title: string; connectedSessionIds: string[] } }).board.id;
  assert.deepEqual(wiring.snapshotMessage().boards.map(({ id, title, connectedSessionIds }) => ({ id, title, connectedSessionIds })), [{ id: boardId, title: 'checkout fix', connectedSessionIds: [shower.id] }]);

  const second = await wiring.handleAgent(shower, { sub: 'show', path: 'report.html' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((second.body as { board: { id: string } }).board.id, boardId);

  const read = await wiring.handleAgent(shower, { sub: 'get', board: boardId });
  const { elements } = Board.parse((read.body as { board: unknown }).board);
  const firstCard = elements['shown-1'];
  const secondCard = elements['shown-2'];
  assert.ok(firstCard?.kind === 'box' && secondCard?.kind === 'box');
  assert.deepEqual([firstCard.title, firstCard.lines.map((line) => line.text), firstCard.media?.kind, firstCard.media?.alt], ['login.png', ['login after fix'], 'image', 'login after fix']);
  assert.deepEqual([secondCard.title, secondCard.media?.kind, secondCard.near], ['Weekly report', 'page', { of: 'shown-1', side: 'right', gap: 60 }]);

  await wiring.handleOperator.put(boardId, z.array(Op).parse([{ op: 'add', element: { kind: 'box', id: 'shown-1000000000000000000000', title: 'Odd id', at: { x: 0, y: 0 } } }]));
  const pastOddId = await wiring.handleAgent(shower, { sub: 'show', path: 'login.png' });
  assert.equal(pastOddId.status, 200, JSON.stringify(pastOddId.body));
  assert.match(String((pastOddId.body as { note: string }).note), /as box shown-3 /);

  const remote = await wiring.handleAgent({ ...shower, remoteWorkspace: 'coder-box' }, { sub: 'show', path: 'login.png' });
  assert.equal(remote.status, 409);
});
