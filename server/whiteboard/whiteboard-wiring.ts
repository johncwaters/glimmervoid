import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BoardRecord, sparseBoardRecord, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardReview, BoardSummary, Op, WhiteboardAgentRequest } from '../../shared/contracts/whiteboard.ts';
import type { AgentReplyBodyOf } from '../../shared/contracts/session.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { OPERATOR_AUTHOR, applyOps, createBoard } from '../../shared/whiteboard-ops-core.ts';
import type { Author } from '../../shared/whiteboard-ops-core.ts';
import { layoutBoardRemembered } from '../../shared/whiteboard-layout-cache.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import { referencedPaths, reviewBoard } from '../../shared/whiteboard-anchor-core.ts';
import { cappedWarnings } from '../../shared/whiteboard-route-core.ts';
import { readChangeFacts, readFileFacts } from './whiteboard-anchor-facts.ts';
import type { ChangeMap } from '../../shared/contracts/change-map.ts';
import { unitsOf } from '../../shared/whiteboard-plan-core.ts';
import {
  boardRecordWithMediaForImages, changesForReader, connectSession, disconnectSession, markRead, nudgeLineFor, pickShowBoardId, promptContextFor, recordPut, resolveBoardRef, shownBoxOp, summarizeBoard,
} from '../core/whiteboard-store-core.ts';
import { loadJsonStateFile, writeJsonAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { errorMessage } from '../../shared/text.ts';
import { readPageTitle, SHOWN_SNIFF_BYTES } from '../core/shown-files-core.ts';
import { createWhiteboardAssetStore } from './whiteboard-assets.ts';
import type { WhiteboardAssetStore } from './whiteboard-assets.ts';

const WHITEBOARDS_FOLDER_NAME = 'whiteboards';
const BOARD_FILE_EXTENSION = '.json';
const BOARD_FILE_MODE = 0o600;

const PUT_GUIDE = [
  'glimmervoid whiteboard put <board> <ops> takes a JSON array of ops, - to read it from stdin, or --file <path> to read it from a file, for example',
  '\'[{"op":"add","element":{"kind":"box","id":"parse","title":"Parse","at":{"x":40,"y":40},"lines":[{"text":"reads the feed"},{"text":"skips drafts","muted":true}]}},',
  '{"op":"add","element":{"kind":"box","id":"store","title":"Store","near":{"of":"parse","side":"right","gap":60}}},',
  '{"op":"add","element":{"kind":"wire","id":"w1","from":"parse","to":"store","dashed":true,"label":"on retry"}},',
  '{"op":"set","id":"parse","fields":{"title":"Parse feed"}},{"op":"remove","id":"w1"}]\'.',
  'Pick the layout that fits what you draw; the example shows op syntax, not a preferred shape.',
  'Element kinds: box (title, column, lane, near, at, lines, refs, change none|added|removed|relabeled, was, order, shape box|decision, outputs), wire (from, to, fromOutput, dashed, tone plain|fail|join|lane, label, fromSide and toSide left|right|top|bottom, back), frame (title, contains, loop), note (on, text, ref), unit (title, lines, refs, status, after, linkedBoardId), panel (title, lines, order) for side notes such as prior art, stacked right of the board.',
  'To show a picture, video or HTML page, run glimmervoid whiteboard attach <path> (PNG, JPEG, WebP, GIF, SVG, MP4, WebM or HTML) and set the media it returns on a box unchanged except alt, as in "media":{"kind":"image","asset":"<id>","mime":"image/png","width":800,"height":600,"alt":"login screen","hasPreview":false}; a picture or video first frame draws under the box lines, and a page or a video without a first frame shows as a labelled placeholder.',
  'A line takes style text|code|item|numbered|kv; kv needs a key, as in {"style":"kv","key":"timeout","text":"30s"}, and numbered lines count up through each run.',
  'Units lay out work in dependency order: glimmervoid whiteboard plan add|after|show edits and reads them.',
  'Every box needs one place: column and lane on a grid of columns and lane row bands, set by a columns op such as {"op":"columns","columns":[{"id":"intake","title":"Intake"}]} and a lanes op such as {"op":"lanes","lanes":[{"id":"pr1","label":"PR 1","color":"blue"}]} before any box names them; near another box with near {"of":"parse","side":"right|left|top|bottom","gap":60}; or at {"x","y"} pixels.',
  'A unit takes status planned|building|landed; a planned unit whose ref files already changed, or a landed one whose ref files are unchanged or uncommitted, comes back as a warning.',
  'Point a box or unit at code with refs ["path", "path#L12", "path#L12-L30"], relative to the board code session worktree (codeSessionId, the creating session by default); any line or note takes one ref. A ref that names no file or runs past the end comes back as a warning.',
  'Mark what a change does to a box with change: added and removed for parts it brings or takes away, relabeled with was set to the old title for a rename.',
  'A decision is a box with shape:"decision" and outputs [{id, label}] drawn as rows in that order; a wire with fromOutput set to an output id leaves from that row, so each branch starts at its own named exit.',
  'Wires route around every box on their own; set fromSide or toSide to pick where one attaches, back:true for a return edge that loops around the outside, and loop:true on a frame to mark what repeats.',
  'The legend lists every wire style in use on its own; a board op with legend [{tone, dashed, back, label}] renames an entry or adds one.',
  'A columns op takes move {"old-column":"new-column"} to carry boxes when it drops or renames a column. A put is applied whole or refused whole.',
  'glimmervoid whiteboard get <board> returns the board and a one-line summary of each change others made since this session last read it;',
  'add --layout to see where every box, wire and label landed, which refs need fixing, which changed files no ref covers and which referenced files the review tab calls worth a look, or run glimmervoid whiteboard render <board> --out board.svg to draw it as the dashboard does.',
].join(' ');

interface WhiteboardCaller {
  id: string;
  name: string;
  cwd?: string;
  remoteWorkspace?: string | null;
}

interface WhiteboardReply {
  status: number;
  body: AgentReplyBodyOf<'whiteboard'>;
  patch?: WhiteboardPatch;
}

type WhiteboardPatch = ServerMessageOf<'whiteboard-patch'>;

type RecordChange = { ok: true; record: BoardRecord; reply: WhiteboardReply; patch?: WhiteboardPatch } | { ok: false; reply: WhiteboardReply };

type AppliedOps = { ok: true; record: BoardRecord; patch: WhiteboardPatch } | { ok: false; error: string };

type OperatorReply = {
  ok: boolean;
  error: string | null;
  board?: Board;
  summary?: BoardSummary;
  review?: BoardReview;
  patch?: WhiteboardPatch;
};

const GLIMMERVOID_AUTHOR: Author = Object.freeze({ id: 'glimmervoid', name: 'Glimmervoid' });
const DELETED_BOARD_TEXT = 'that board was deleted';
const RELEASE_HOLD_MS = 60 * 60_000;

interface WhiteboardWiringOptions {
  boardsRoot: string;
  broadcastControl?: (message: ControlMessageRecord) => void;
  now?: () => number;
  newBoardId?: () => string;
  logger?: Pick<Console, 'warn'>;
  codeContextOf?: (sessionId: string) => CodeContext | null;
}

interface CodeContext {
  root: string;
  buildChangeMap: () => Promise<ChangeMap>;
}

interface WhiteboardPort {
  loaded: Promise<void>;
  assets: WhiteboardAssetStore;
  handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply>;
  handleOperator: {
    create(title: string): Promise<OperatorReply>;
    put(boardId: string, ops: readonly Op[]): Promise<OperatorReply>;
    remove(boardId: string): Promise<OperatorReply>;
    get(boardId: string): Promise<OperatorReply>;
    review(boardId: string): Promise<OperatorReply>;
    connect(boardId: string, sessionId: string): Promise<OperatorReply>;
    disconnect(boardId: string, sessionId: string): Promise<OperatorReply>;
    nudgeLine(boardId: string): string | null;
  };
  forgetSession(sessionId: string): Promise<void>;
  forgetClosedSessions(isClosedSession: (sessionId: string) => boolean): Promise<void>;
  takePromptContext(sessionId: string): string | null;
  isConnected(sessionId: string): boolean;
  snapshotMessage(): ServerMessageOf<'whiteboards-snapshot'>;
}

function hasNoConnectedSessions(record: BoardRecord): boolean {
  return Object.keys(record.cursorBySessionId).length === 0;
}

function assetIdsOf(board: Board): Set<string> {
  return new Set(Object.values(board.elements).flatMap((element) => (element.kind === 'box' && element.media ? [element.media.asset] : [])));
}

function refusal(status: number, error: string): WhiteboardReply {
  return { status, body: { ok: false, error } };
}

function parseBoardRecord(raw: unknown): BoardRecord | null {
  const parsed = BoardRecord.safeParse(boardRecordWithMediaForImages(raw));
  return parsed.success ? parsed.data : null;
}

function operatorReplyOf(reply: WhiteboardReply): OperatorReply {
  if (!reply.body.ok) return { ok: false, error: reply.body.error };
  const patch = reply.patch ? { patch: reply.patch } : {};
  if ('board' in reply.body && 'changes' in reply.body) return { ok: true, error: null, board: reply.body.board, ...patch };
  if ('board' in reply.body) return { ok: true, error: null, summary: reply.body.board, ...patch };
  return { ok: true, error: null, ...patch };
}

function createWhiteboardWiring({
  boardsRoot, broadcastControl = () => {}, now = Date.now, newBoardId = () => crypto.randomUUID(), logger = console, codeContextOf = () => null,
}: WhiteboardWiringOptions): WhiteboardPort {
  const recordsByBoardId = new Map<string, BoardRecord>();
  const deletedBoardIds = new Set<string>();
  const writeQueue = createKeyedSerialQueue();
  const assets = createWhiteboardAssetStore({ boardsRoot, logger, now });
  let isEveryBoardLoaded = true;
  const loaded = Promise.all([loadBoards(), assets.loaded]).then(sweepUnusedAssets).then(() => {});

  function sweepUnusedAssets(): Promise<number> {
    if (!isEveryBoardLoaded) return Promise.resolve(0);
    const referencedAssetIds = new Set([...recordsByBoardId.values()].flatMap((record) => [...assetIdsOf(record.board)]));
    return assets.sweep(referencedAssetIds);
  }

  function keepPicturesWhileUnloaded(filename: string): void {
    isEveryBoardLoaded = false;
    logger.warn(`[whiteboard] board pictures are kept, not cleared, while ${filename} is not loaded`);
  }

  async function loadBoards(): Promise<void> {
    const filenames = await fsp.readdir(boardsRoot).catch((error: NodeJS.ErrnoException): string[] | null => (error.code === 'ENOENT' ? [] : null));
    if (filenames === null) {
      keepPicturesWhileUnloaded(boardsRoot);
      return;
    }
    for (const filename of filenames) {
      if (filename.includes(`${BOARD_FILE_EXTENSION}.corrupt-`)) keepPicturesWhileUnloaded(filename);
      if (!filename.endsWith(BOARD_FILE_EXTENSION)) continue;
      const outcome = await loadJsonStateFile({ filePath: path.join(boardsRoot, filename), parse: parseBoardRecord });
      if (outcome.status === 'loaded' && `${outcome.value.board.id}${BOARD_FILE_EXTENSION}` === filename) {
        recordsByBoardId.set(outcome.value.board.id, outcome.value);
        continue;
      }
      if (outcome.status === 'missing') continue;
      logger.warn(`[whiteboard] ${filename} was not loaded: ${outcome.status}`);
      keepPicturesWhileUnloaded(filename);
    }
  }

  function boardFilePath(boardId: string): string {
    return path.join(boardsRoot, `${boardId}${BOARD_FILE_EXTENSION}`);
  }

  function writeRecord(record: BoardRecord): Promise<void> {
    return writeJsonAtomic(boardFilePath(record.board.id), sparseBoardRecord(record), { mode: BOARD_FILE_MODE, mkdir: true });
  }

  function snapshotMessage(): ServerMessageOf<'whiteboards-snapshot'> {
    return { type: 'whiteboards-snapshot', boards: [...recordsByBoardId.values()].map(summarizeBoard) };
  }

  function broadcastSummariesIfChanged(before: BoardRecord | null, after: BoardRecord | null): void {
    const summaryBefore = before ? JSON.stringify(summarizeBoard(before)) : null;
    const summaryAfter = after ? JSON.stringify(summarizeBoard(after)) : null;
    if (summaryBefore === summaryAfter) return;
    broadcastControl(snapshotMessage());
  }

  async function saveRecordInSlot(current: BoardRecord, next: BoardRecord): Promise<boolean> {
    const boardId = current.board.id;
    recordsByBoardId.set(boardId, next);
    try {
      await writeRecord(next);
      return true;
    } catch (error) {
      recordsByBoardId.set(boardId, current);
      logger.warn(`[whiteboard] board ${boardId} could not be saved: ${errorMessage(error)}`);
      return false;
    }
  }

  function changeRecord(boardId: string, change: (record: BoardRecord) => RecordChange): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, DELETED_BOARD_TEXT);
      const outcome = change(current);
      if (!outcome.ok) return outcome.reply;
      if (outcome.record === current) return outcome.reply;
      const isSaved = await saveRecordInSlot(current, outcome.record);
      if (!isSaved) return refusal(500, 'the board could not be saved, so nothing changed');
      if (!outcome.patch) {
        broadcastSummariesIfChanged(current, outcome.record);
        return outcome.reply;
      }
      broadcastControl(outcome.patch);
      broadcastSummariesIfChanged(current, outcome.record);
      return { ...outcome.reply, patch: outcome.patch };
    });
  }

  function findBoardId(ref: string): { ok: true; boardId: string } | { ok: false; reply: WhiteboardReply } {
    if (deletedBoardIds.has(ref)) return { ok: false, reply: refusal(404, DELETED_BOARD_TEXT) };
    const resolved = resolveBoardRef([...recordsByBoardId.values()].map((record) => record.board), ref);
    if ('error' in resolved) return { ok: false, reply: refusal(404, resolved.error) };
    return { ok: true, boardId: resolved.id };
  }

  async function createBoardFor(creator: WhiteboardCaller | null, title: string): Promise<WhiteboardReply> {
    const boardId = newBoardId();
    const nowMs = now();
    const cursorBySessionId: Record<string, number> = creator ? { [creator.id]: 0 } : {};
    const board = createBoard({ id: boardId, title, nowMs, codeSessionId: creator?.id ?? null });
    const record: BoardRecord = { board, log: [], cursorBySessionId, createdBy: creator?.id ?? null };
    recordsByBoardId.set(boardId, record);
    try {
      await writeQueue.run(boardId, () => writeRecord(record));
    } catch (error) {
      recordsByBoardId.delete(boardId);
      logger.warn(`[whiteboard] board ${boardId} could not be created: ${errorMessage(error)}`);
      return refusal(500, 'the board could not be saved, so it was not created');
    }
    broadcastSummariesIfChanged(null, record);
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note: PUT_GUIDE } };
  }

  function putOps(boardId: string, ops: readonly Op[], author: Author): Promise<WhiteboardReply> {
    if (Buffer.byteLength(JSON.stringify(ops)) > WHITEBOARD_LIMITS.putBytes) {
      return Promise.resolve(refusal(413, `one put carries at most ${WHITEBOARD_LIMITS.putBytes} bytes of ops, so nothing changed`));
    }
    return changeRecord(boardId, (record) => {
      const applied = applyOpsToRecord(record, ops, author);
      if (!applied.ok) return { ok: false, reply: refusal(400, `${applied.error}, so nothing changed`) };
      const { warnings } = layoutBoardRemembered(applied.record.board);
      const body = { ok: true as const, version: applied.record.board.version, ...(warnings.length > 0 ? { warnings } : {}) };
      return { ok: true, record: applied.record, reply: { status: 200, body }, patch: applied.patch };
    });
  }

  function changedMediaRefusalOf(boardBefore: Board, boardAfter: Board): string | null {
    for (const element of Object.values(boardAfter.elements)) {
      if (element.kind !== 'box' || !element.media) continue;
      const before = boardBefore.elements[element.id];
      const mediaBefore = before?.kind === 'box' ? before.media : null;
      if (JSON.stringify(mediaBefore) === JSON.stringify(element.media)) continue;
      const mismatch = assets.mismatchOf(element.media);
      if (mismatch) return `box ${element.id} names ${mismatch}`;
    }
    return null;
  }

  function applyOpsToRecord(record: BoardRecord, ops: readonly Op[], author: Author): AppliedOps {
    const result = applyOps(record.board, ops, author, now());
    if (!result.ok) return result;
    const strandedUnit = unitsOf(result.board).find((unit) => {
      const before = record.board.elements[unit.id];
      const isNewLink = before?.kind !== 'unit' || before.linkedBoardId !== unit.linkedBoardId;
      return isNewLink && unit.linkedBoardId !== null && !recordsByBoardId.has(unit.linkedBoardId);
    });
    if (strandedUnit) return { ok: false, error: `unit ${strandedUnit.id} links to board ${strandedUnit.linkedBoardId ?? ''}, which does not exist` };
    const assetIdsBefore = assetIdsOf(record.board);
    const assetIdsAfter = assetIdsOf(result.board);
    const mediaRefusal = changedMediaRefusalOf(record.board, result.board);
    if (mediaRefusal) return { ok: false, error: mediaRefusal };
    for (const releasedAssetId of assetIdsBefore) {
      if (!assetIdsAfter.has(releasedAssetId)) assets.hold(releasedAssetId, RELEASE_HOLD_MS);
    }
    const next = recordPut(record, result);
    const patch: WhiteboardPatch = {
      type: 'whiteboard-patch', boardId: record.board.id, fromVersion: record.board.version, toVersion: next.board.version,
      author: { id: author.id, name: author.name }, updatedAt: next.board.updatedAt, diff: result.diff,
    };
    return { ok: true, record: next, patch };
  }

  async function reviewFor(board: Board, { readsChanges }: { readsChanges: boolean }): Promise<BoardReview> {
    const codeContext = board.codeSessionId ? codeContextOf(board.codeSessionId) : null;
    if (!codeContext) return reviewBoard(board, null);
    const fileFactByPath = await readFileFacts(codeContext.root, referencedPaths(board));
    const changes = readsChanges ? await readChangeFacts(codeContext.buildChangeMap) : null;
    return reviewBoard(board, { fileFactByPath, changes });
  }

  async function reviewedPut(boardId: string, ops: readonly Op[], author: Author): Promise<WhiteboardReply> {
    const reply = await putOps(boardId, ops, author);
    const board = recordsByBoardId.get(boardId)?.board;
    if (!reply.body.ok || !('version' in reply.body) || !board) return reply;
    const { anchorWarnings, unitWarnings } = await reviewFor(board, { readsChanges: unitsOf(board).length > 0 });
    if (anchorWarnings.length === 0 && unitWarnings.length === 0) return reply;
    return { status: reply.status, body: { ...reply.body, warnings: cappedWarnings([...reply.body.warnings ?? [], ...anchorWarnings, ...unitWarnings]) } };
  }

  async function readBoard(boardId: string, readerId: string, { isPeek, wantsReview }: { isPeek: boolean; wantsReview: boolean }): Promise<WhiteboardReply> {
    const reply = await changeRecord(boardId, (record) => {
      const changes = changesForReader(record, readerId);
      const next = isPeek || record.cursorBySessionId[readerId] === record.board.version ? record : markRead(record, readerId);
      return { ok: true, record: next, reply: { status: 200, body: { ok: true, board: record.board, changes } } };
    });
    if (!wantsReview || !reply.body.ok || !('changes' in reply.body)) return reply;
    return { status: reply.status, body: { ...reply.body, review: await reviewFor(reply.body.board, { readsChanges: true }) } };
  }

  function connectionReply(record: BoardRecord, note: string): WhiteboardReply {
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note } };
  }

  function connectBoard(boardId: string, sessionId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, (record) => {
      const claimed = record.board.codeSessionId === null ? applyOpsToRecord(record, [{ op: 'board', codeSessionId: sessionId }], GLIMMERVOID_AUTHOR) : null;
      if (!claimed?.ok) {
        const next = connectSession(record, sessionId);
        return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE) };
      }
      const next = connectSession(claimed.record, sessionId);
      return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE), patch: claimed.patch };
    });
  }

  function disconnectBoard(boardId: string, sessionId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, (record) => {
      const next = disconnectSession(record, sessionId);
      return { ok: true, record: next, reply: connectionReply(next, 'this session no longer gets summaries of changes to this board') };
    });
  }

  async function clearLinksTo(deletedBoardId: string): Promise<void> {
    const unlinkPuts = [...recordsByBoardId.values()].flatMap((record) => {
      const ops: Op[] = unitsOf(record.board)
        .filter((unit) => unit.linkedBoardId === deletedBoardId)
        .map((unit) => ({ op: 'set', id: unit.id, fields: { linkedBoardId: null } }));
      if (ops.length === 0) return [];
      const linkingBoardId = record.board.id;
      return [putOps(linkingBoardId, ops, GLIMMERVOID_AUTHOR).then((reply) => {
        if (!reply.body.ok) logger.warn(`[whiteboard] units on board ${linkingBoardId} still link to deleted board ${deletedBoardId}: ${reply.body.error}`);
      })];
    });
    await Promise.all(unlinkPuts);
  }

  async function removeBoard(boardId: string): Promise<WhiteboardReply> {
    const reply = await removeBoardRecord(boardId);
    if (reply.body.ok) await clearLinksTo(boardId);
    return reply;
  }

  function removeBoardRecord(boardId: string): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, DELETED_BOARD_TEXT);
      return deleteRecordInSlot(current);
    });
  }

  async function deleteRecordInSlot(current: BoardRecord): Promise<WhiteboardReply> {
    const boardId = current.board.id;
    try {
      await fsp.rm(boardFilePath(boardId), { force: true });
    } catch (error) {
      logger.warn(`[whiteboard] board ${boardId} could not be deleted: ${errorMessage(error)}`);
      return refusal(500, 'the board file could not be deleted, so the board is still here');
    }
    recordsByBoardId.delete(boardId);
    deletedBoardIds.add(boardId);
    broadcastControl({ type: 'whiteboard-removed', boardId });
    broadcastSummariesIfChanged(current, null);
    void sweepUnusedAssets();
    return { status: 200, body: { ok: true, version: current.board.version } };
  }

  function deleteOwnBoard(boardId: string, callerId: string): Promise<WhiteboardReply> {
    if (recordsByBoardId.get(boardId)?.createdBy !== callerId) {
      return Promise.resolve(refusal(403, 'a session deletes only a board it created, so this board is still here; the operator can delete it from the dashboard'));
    }
    return removeBoard(boardId);
  }

  async function operatorBoardCommand(boardId: string, command: (foundBoardId: string) => Promise<WhiteboardReply>): Promise<OperatorReply> {
    await loaded;
    const found = findBoardId(boardId);
    if (!found.ok) return operatorReplyOf(found.reply);
    return operatorReplyOf(await command(found.boardId));
  }

  const handleOperator: WhiteboardPort['handleOperator'] = {
    create: async (title) => {
      await loaded;
      return operatorReplyOf(await createBoardFor(null, title));
    },
    put: (boardId, ops) => operatorBoardCommand(boardId, (foundBoardId) => putOps(foundBoardId, ops, OPERATOR_AUTHOR)),
    remove: (boardId) => operatorBoardCommand(boardId, removeBoard),
    get: (boardId) => operatorBoardCommand(boardId, async (foundBoardId) => {
      const record = recordsByBoardId.get(foundBoardId);
      if (!record) return refusal(404, DELETED_BOARD_TEXT);
      return { status: 200, body: { ok: true, board: record.board, changes: [] } };
    }),
    review: async (boardId) => {
      await loaded;
      const record = recordsByBoardId.get(boardId);
      if (!record) return { ok: false, error: DELETED_BOARD_TEXT };
      return { ok: true, error: null, review: await reviewFor(record.board, { readsChanges: true }) };
    },
    connect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => connectBoard(foundBoardId, sessionId)),
    disconnect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => disconnectBoard(foundBoardId, sessionId)),
    nudgeLine: (boardId) => {
      const record = recordsByBoardId.get(boardId);
      return record ? nudgeLineFor(record.board) : null;
    },
  };

  async function closeConnections(boardId: string, closedSessionIds: readonly string[]): Promise<void> {
    const isDeleted = await writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return false;
      const next = closedSessionIds.reduce(disconnectSession, current);
      if (hasNoConnectedSessions(next)) return (await deleteRecordInSlot(current)).body.ok;
      if (await saveRecordInSlot(current, next)) broadcastSummariesIfChanged(current, next);
      return false;
    });
    if (isDeleted) await clearLinksTo(boardId);
  }

  async function forgetClosedSessions(isClosedSession: (sessionId: string) => boolean): Promise<void> {
    await loaded;
    const closedConnectionsPerBoard = [...recordsByBoardId].map(([boardId, record]) => ({ boardId, closedSessionIds: Object.keys(record.cursorBySessionId).filter(isClosedSession) }));
    await Promise.all(closedConnectionsPerBoard
      .filter(({ closedSessionIds }) => closedSessionIds.length > 0)
      .map(({ boardId, closedSessionIds }) => closeConnections(boardId, closedSessionIds)));
  }

  function forgetSession(sessionId: string): Promise<void> {
    return forgetClosedSessions((connectedSessionId) => connectedSessionId === sessionId);
  }

  function isConnected(sessionId: string): boolean {
    return [...recordsByBoardId.values()].some((record) => sessionId in record.cursorBySessionId);
  }

  function takePromptContext(sessionId: string): string | null {
    const context = promptContextFor([...recordsByBoardId.values()], sessionId);
    if (!context) return null;
    for (const { boardId, version } of context.readThrough) {
      void changeRecord(boardId, (record) => {
        const next = markRead(record, sessionId, version);
        return { ok: true, record: next, reply: { status: 200, body: { ok: true, version: next.board.version } } };
      });
    }
    return context.text;
  }

  async function attachMedia(caller: WhiteboardCaller, requestedPath: string): Promise<WhiteboardReply> {
    if (caller.remoteWorkspace) return refusal(409, `attach reads files on the Glimmervoid machine, and this session runs in the Coder workspace ${caller.remoteWorkspace}, so its files are not there`);
    const ingested = await assets.ingestFile(path.resolve(caller.cwd ?? boardsRoot, requestedPath));
    if (!ingested.ok) return refusal(ingested.status, ingested.error);
    const isDrawn = ingested.media.kind === 'image' || ingested.media.hasPreview;
    const shownAs = isDrawn ? 'to draw it' : 'to show it as a labelled placeholder until live playback ships';
    const note = `put a box with "media":${JSON.stringify({ ...ingested.media, alt: '<what it shows>' })} ${shownAs}`;
    return { status: 200, body: { ok: true, media: ingested.media, note } };
  }

  async function pageTitleOf(sourcePath: string): Promise<string | null> {
    const handle = await fsp.open(sourcePath, 'r').catch(() => null);
    if (!handle) return null;
    try {
      const firstChunk = Buffer.alloc(SHOWN_SNIFF_BYTES);
      const { bytesRead } = await handle.read(firstChunk, 0, SHOWN_SNIFF_BYTES, 0);
      return readPageTitle(firstChunk.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async function showBoardIdFor(caller: WhiteboardCaller): Promise<{ ok: true; boardId: string } | { ok: false; reply: WhiteboardReply }> {
    const pickedBoardId = pickShowBoardId([...recordsByBoardId.values()], caller.id);
    if (pickedBoardId) return { ok: true, boardId: pickedBoardId };
    const created = await createBoardFor(caller, caller.name.slice(0, WHITEBOARD_LIMITS.title));
    if (!created.body.ok || !('board' in created.body)) return { ok: false, reply: created };
    return { ok: true, boardId: created.body.board.id };
  }

  async function showOnBoard(caller: WhiteboardCaller, requestedPath: string, caption: string | null): Promise<WhiteboardReply> {
    if (caller.remoteWorkspace) return refusal(409, `show reads files on the Glimmervoid machine, and this session runs in the Coder workspace ${caller.remoteWorkspace}, so its files are not there`);
    const sourcePath = path.resolve(caller.cwd ?? boardsRoot, requestedPath);
    const ingested = await assets.ingestFile(sourcePath);
    if (!ingested.ok) return refusal(ingested.status, ingested.error);
    const pageTitle = ingested.media.kind === 'page' ? await pageTitleOf(sourcePath) : null;
    const target = await showBoardIdFor(caller);
    if (!target.ok) return target.reply;
    const card = { media: ingested.media, title: pageTitle ?? path.basename(sourcePath), caption };
    const author: Author = { id: caller.id, name: caller.name };
    return changeRecord(target.boardId, (record) => {
      const shownBox = shownBoxOp(record.board, layoutBoard(record.board).bounds, card);
      if (!shownBox.ok) return { ok: false, reply: refusal(400, `${shownBox.error}, so nothing changed`) };
      const { op, boxId } = shownBox;
      const applied = applyOpsToRecord(record, [op], author);
      if (!applied.ok) return { ok: false, reply: refusal(400, `${applied.error}, so nothing changed`) };
      const { board } = applied.record;
      const note = `showed ${card.title} as box ${boxId} on board "${board.title}" (${board.id}), where the operator sees it; change it with whiteboard put`;
      return { ok: true, record: applied.record, reply: { status: 200, body: { ok: true, board: summarizeBoard(applied.record), note } }, patch: applied.patch };
    });
  }

  async function handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply> {
    await loaded;
    if (request.sub === 'new') return createBoardFor(caller, request.title);
    if (request.sub === 'attach') return attachMedia(caller, request.path);
    if (request.sub === 'show') return showOnBoard(caller, request.path, request.caption?.trim() || null);
    if (request.sub === 'list') {
      return { status: 200, body: { ok: true, boards: [...recordsByBoardId.values()].map(summarizeBoard) } };
    }
    const found = findBoardId(request.board);
    if (!found.ok) return found.reply;
    const author: Author = { id: caller.id, name: caller.name };
    switch (request.sub) {
      case 'connect': return connectBoard(found.boardId, caller.id);
      case 'disconnect': return disconnectBoard(found.boardId, caller.id);
      case 'get': return readBoard(found.boardId, caller.id, { isPeek: request.peek === true, wantsReview: request.review === true });
      case 'put': return reviewedPut(found.boardId, request.ops, author);
      case 'resolve': return putOps(found.boardId, [{ op: 'resolve', id: request.note }], author);
      case 'delete': return deleteOwnBoard(found.boardId, caller.id);
    }
  }

  return { loaded, assets, handleAgent, handleOperator, forgetSession, forgetClosedSessions, takePromptContext, isConnected, snapshotMessage };
}

export { createWhiteboardWiring, WHITEBOARDS_FOLDER_NAME };
export type { WhiteboardPort };
