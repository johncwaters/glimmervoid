import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BoardRecord, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardSummary, Op, WhiteboardAgentRequest } from '../../shared/contracts/whiteboard.ts';
import type { AgentReplyBodyOf } from '../../shared/contracts/session.ts';
import type { ServerMessageOf } from '../../shared/contracts/control-messages.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { applyOps, createBoard } from '../../shared/whiteboard-ops-core.ts';
import type { Author } from '../../shared/whiteboard-ops-core.ts';
import { layoutBoard } from '../../shared/whiteboard-layout-core.ts';
import { unitsOf } from '../../shared/whiteboard-plan-core.ts';
import {
  changesForReader, connectSession, disconnectSession, markRead, nudgeLineFor, promptContextFor, recordPut, resolveBoardRef, summarizeBoard,
} from '../core/whiteboard-store-core.ts';
import { loadJsonStateFile, writeJsonAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { errorMessage } from '../../shared/text.ts';

const WHITEBOARDS_FOLDER_NAME = 'whiteboards';
const BOARD_FILE_EXTENSION = '.json';
const BOARD_FILE_MODE = 0o600;

const PUT_GUIDE = [
  'glimmervoid whiteboard put <board> <ops> takes a JSON array of ops, - to read it from stdin, or --file <path> to read it from a file, for example',
  '\'[{"op":"columns","columns":[{"id":"intake","title":"Intake"}]},',
  '{"op":"lanes","lanes":[{"id":"pr1","label":"PR 1","color":"blue"}]},',
  '{"op":"add","element":{"kind":"box","id":"parse","title":"Parse","column":"intake","lane":"pr1","lines":[{"text":"reads the feed"},{"text":"skips drafts","muted":true}]}},',
  '{"op":"add","element":{"kind":"wire","id":"w1","from":"parse","to":"store","dashed":true,"label":"on retry"}},',
  '{"op":"set","id":"parse","fields":{"title":"Parse feed"}},{"op":"remove","id":"w1"}]\'.',
  'Element kinds: box (title, column, lane, near, at, lines, ghost, order), wire (from, to, dashed, tone plain|fail|join|lane, label, fromSide and toSide left|right|top|bottom, back), frame (title, contains, loop), note (on, text), unit (title, lines, after, linkedBoardId).',
  'Units lay out work in dependency order: glimmervoid whiteboard plan add|after|show edits and reads them.',
  'Place a box by column and lane, which make a grid of columns and lane row bands; or near another box with near {"of":"parse","side":"right|left|top|bottom","gap":60}; or at {"x","y"} pixels as a last resort.',
  'Wires route around every box on their own; set fromSide or toSide to pick where one attaches, back:true for a return edge that loops around the outside, and loop:true on a frame to mark what repeats.',
  'A columns op takes move {"old-column":"new-column"} to carry boxes when it drops or renames a column. A put is applied whole or refused whole.',
  'glimmervoid whiteboard get <board> returns the board and a one-line summary of each change others made since this session last read it;',
  'add --layout to see where every box, wire and label landed, or run glimmervoid whiteboard render <board> --out board.svg to draw it as the dashboard does.',
].join(' ');

interface WhiteboardCaller {
  id: string;
  name: string;
}

interface WhiteboardReply {
  status: number;
  body: AgentReplyBodyOf<'whiteboard'>;
}

type WhiteboardPatch = ServerMessageOf<'whiteboard-patch'>;

type RecordChange = { ok: true; record: BoardRecord; reply: WhiteboardReply; patch?: WhiteboardPatch } | { ok: false; reply: WhiteboardReply };

type OperatorReply = {
  ok: boolean;
  error: string | null;
  board?: Board;
  summary?: BoardSummary;
};

const OPERATOR_AUTHOR: Author = Object.freeze({ id: 'operator', name: 'operator' });
const BOARD_DELETION_AUTHOR: Author = Object.freeze({ id: 'glimmervoid', name: 'Glimmervoid' });
const DELETED_BOARD_TEXT = 'that board was deleted';

interface WhiteboardWiringOptions {
  boardsRoot: string;
  broadcastControl?: (message: ControlMessageRecord) => void;
  now?: () => number;
  newBoardId?: () => string;
  logger?: Pick<Console, 'warn'>;
}

interface WhiteboardPort {
  loaded: Promise<void>;
  handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply>;
  handleOperator: {
    create(title: string): Promise<OperatorReply>;
    put(boardId: string, ops: readonly Op[]): Promise<OperatorReply>;
    remove(boardId: string): Promise<OperatorReply>;
    get(boardId: string): Promise<OperatorReply>;
    connect(boardId: string, sessionId: string): Promise<OperatorReply>;
    disconnect(boardId: string, sessionId: string): Promise<OperatorReply>;
    nudgeLine(boardId: string): string | null;
  };
  forgetSession(sessionId: string): Promise<void>;
  takePromptContext(sessionId: string): string | null;
  snapshotMessage(): ServerMessageOf<'whiteboards-snapshot'>;
}

function refusal(status: number, error: string): WhiteboardReply {
  return { status, body: { ok: false, error } };
}

function parseBoardRecord(raw: unknown): BoardRecord | null {
  const parsed = BoardRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function operatorReplyOf(reply: WhiteboardReply): OperatorReply {
  if (!reply.body.ok) return { ok: false, error: reply.body.error };
  if ('board' in reply.body && 'changes' in reply.body) return { ok: true, error: null, board: reply.body.board };
  if ('board' in reply.body) return { ok: true, error: null, summary: reply.body.board };
  return { ok: true, error: null };
}

function createWhiteboardWiring({
  boardsRoot, broadcastControl = () => {}, now = Date.now, newBoardId = () => crypto.randomUUID(), logger = console,
}: WhiteboardWiringOptions): WhiteboardPort {
  const recordsByBoardId = new Map<string, BoardRecord>();
  const deletedBoardIds = new Set<string>();
  const writeQueue = createKeyedSerialQueue();
  const loaded = loadBoards();

  async function loadBoards(): Promise<void> {
    const filenames = await fsp.readdir(boardsRoot).catch((): string[] => []);
    for (const filename of filenames) {
      if (!filename.endsWith(BOARD_FILE_EXTENSION)) continue;
      const outcome = await loadJsonStateFile({ filePath: path.join(boardsRoot, filename), parse: parseBoardRecord });
      if (outcome.status === 'loaded' && `${outcome.value.board.id}${BOARD_FILE_EXTENSION}` === filename) {
        recordsByBoardId.set(outcome.value.board.id, outcome.value);
        continue;
      }
      if (outcome.status !== 'missing') logger.warn(`[whiteboard] ${filename} was not loaded: ${outcome.status}`);
    }
  }

  function boardFilePath(boardId: string): string {
    return path.join(boardsRoot, `${boardId}${BOARD_FILE_EXTENSION}`);
  }

  function writeRecord(record: BoardRecord): Promise<void> {
    return writeJsonAtomic(boardFilePath(record.board.id), record, { mode: BOARD_FILE_MODE, mkdir: true });
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

  function changeRecord(boardId: string, change: (record: BoardRecord) => RecordChange): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, DELETED_BOARD_TEXT);
      const outcome = change(current);
      if (!outcome.ok) return outcome.reply;
      if (outcome.record === current) return outcome.reply;
      recordsByBoardId.set(boardId, outcome.record);
      try {
        await writeRecord(outcome.record);
      } catch (error) {
        recordsByBoardId.set(boardId, current);
        logger.warn(`[whiteboard] board ${boardId} could not be saved: ${errorMessage(error)}`);
        return refusal(500, 'the board could not be saved, so nothing changed');
      }
      if (outcome.patch) broadcastControl(outcome.patch);
      broadcastSummariesIfChanged(current, outcome.record);
      return outcome.reply;
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
    const record: BoardRecord = { board: createBoard({ id: boardId, title, nowMs }), log: [], cursorBySessionId, createdBy: creator?.id ?? null };
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
      const result = applyOps(record.board, ops, author, now());
      if (!result.ok) return { ok: false, reply: refusal(400, `${result.error}, so nothing changed`) };
      const strandedUnit = unitsOf(result.board).find((unit) => {
        const before = record.board.elements[unit.id];
        const isNewLink = before?.kind !== 'unit' || before.linkedBoardId !== unit.linkedBoardId;
        return isNewLink && unit.linkedBoardId !== null && !recordsByBoardId.has(unit.linkedBoardId);
      });
      if (strandedUnit) return { ok: false, reply: refusal(400, `unit ${strandedUnit.id} links to board ${strandedUnit.linkedBoardId ?? ''}, which does not exist, so nothing changed`) };
      const next = recordPut(record, result);
      const patch: WhiteboardPatch = {
        type: 'whiteboard-patch', boardId, fromVersion: record.board.version, toVersion: next.board.version,
        author: { id: author.id, name: author.name }, updatedAt: next.board.updatedAt, ops: [...ops],
      };
      const { warnings } = layoutBoard(next.board);
      const body = { ok: true as const, version: next.board.version, ...(warnings.length > 0 ? { warnings } : {}) };
      return { ok: true, record: next, reply: { status: 200, body }, patch };
    });
  }

  function readBoard(boardId: string, readerId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, (record) => {
      const changes = changesForReader(record, readerId);
      const next = record.cursorBySessionId[readerId] === record.board.version ? record : markRead(record, readerId);
      return { ok: true, record: next, reply: { status: 200, body: { ok: true, board: record.board, changes } } };
    });
  }

  function connectionReply(record: BoardRecord, note: string): WhiteboardReply {
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note } };
  }

  function connectBoard(boardId: string, sessionId: string): Promise<WhiteboardReply> {
    return changeRecord(boardId, (record) => {
      const next = connectSession(record, sessionId);
      return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE) };
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
      return [putOps(linkingBoardId, ops, BOARD_DELETION_AUTHOR).then((reply) => {
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
      return { status: 200, body: { ok: true, version: current.board.version } };
    });
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
    connect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => connectBoard(foundBoardId, sessionId)),
    disconnect: (boardId, sessionId) => operatorBoardCommand(boardId, (foundBoardId) => disconnectBoard(foundBoardId, sessionId)),
    nudgeLine: (boardId) => {
      const record = recordsByBoardId.get(boardId);
      return record ? nudgeLineFor(record.board) : null;
    },
  };

  async function forgetSession(sessionId: string): Promise<void> {
    await loaded;
    const connectedBoardIds = [...recordsByBoardId].filter(([, record]) => sessionId in record.cursorBySessionId).map(([boardId]) => boardId);
    await Promise.all(connectedBoardIds.map((boardId) => disconnectBoard(boardId, sessionId)));
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

  async function handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply> {
    await loaded;
    if (request.sub === 'new') return createBoardFor(caller, request.title);
    if (request.sub === 'list') {
      return { status: 200, body: { ok: true, boards: [...recordsByBoardId.values()].map(summarizeBoard) } };
    }
    const found = findBoardId(request.board);
    if (!found.ok) return found.reply;
    const author: Author = { id: caller.id, name: caller.name };
    switch (request.sub) {
      case 'connect': return connectBoard(found.boardId, caller.id);
      case 'disconnect': return disconnectBoard(found.boardId, caller.id);
      case 'get': return readBoard(found.boardId, caller.id);
      case 'put': return putOps(found.boardId, request.ops, author);
      case 'resolve': return putOps(found.boardId, [{ op: 'resolve', id: request.note }], author);
      case 'delete': return deleteOwnBoard(found.boardId, caller.id);
    }
  }

  return { loaded, handleAgent, handleOperator, forgetSession, takePromptContext, snapshotMessage };
}

export { createWhiteboardWiring, WHITEBOARDS_FOLDER_NAME };
export type { WhiteboardPort };
