import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { BoardRecord, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Op, WhiteboardAgentRequest } from '../../shared/contracts/whiteboard.ts';
import type { AgentReplyBodyOf } from '../../shared/contracts/session.ts';
import { applyOps, createBoard } from '../../shared/whiteboard-ops-core.ts';
import type { Author } from '../../shared/whiteboard-ops-core.ts';
import {
  changesForReader, connectSession, disconnectSession, markRead, recordPut, resolveBoardRef, summarizeBoard,
} from '../core/whiteboard-store-core.ts';
import { loadJsonStateFile, writeJsonAtomic } from '../json-file.ts';
import { createKeyedSerialQueue } from '../spawn-gate.ts';
import { errorMessage } from '../../shared/text.ts';

const WHITEBOARDS_FOLDER_NAME = 'whiteboards';
const BOARD_FILE_EXTENSION = '.json';
const BOARD_FILE_MODE = 0o600;

const PUT_GUIDE = [
  'glimmervoid whiteboard put <board> <ops> takes a JSON array of ops, or - to read it from stdin, for example',
  '\'[{"op":"columns","columns":[{"id":"intake","title":"Intake"}]},',
  '{"op":"lanes","lanes":[{"id":"pr1","label":"PR 1","color":"blue"}]},',
  '{"op":"add","element":{"kind":"box","id":"parse","title":"Parse","column":"intake","lane":"pr1","lines":[{"text":"reads the feed"},{"text":"skips drafts","muted":true}]}},',
  '{"op":"add","element":{"kind":"wire","id":"w1","from":"parse","to":"store","dashed":true,"label":"on retry"}},',
  '{"op":"set","id":"parse","fields":{"title":"Parse feed"}},{"op":"remove","id":"w1"}]\'.',
  'Element kinds: box (title, column, lines, lane, ghost, order), wire (from, to, dashed, tone plain|fail|join|lane, label), frame (title, contains), note (on, text).',
  'Columns place boxes, so never send pixel positions. A put is applied whole or refused whole.',
  'glimmervoid whiteboard get <board> returns the board and a one-line summary of each change others made since this session last read it.',
].join(' ');

interface WhiteboardCaller {
  id: string;
  name: string;
}

interface WhiteboardReply {
  status: number;
  body: AgentReplyBodyOf<'whiteboard'>;
}

type RecordChange = { ok: true; record: BoardRecord; reply: WhiteboardReply } | { ok: false; reply: WhiteboardReply };

interface WhiteboardWiringOptions {
  boardsRoot: string;
  now?: () => number;
  newBoardId?: () => string;
  logger?: Pick<Console, 'warn'>;
}

interface WhiteboardPort {
  loaded: Promise<void>;
  handleAgent(caller: WhiteboardCaller, request: WhiteboardAgentRequest): Promise<WhiteboardReply>;
}

function refusal(status: number, error: string): WhiteboardReply {
  return { status, body: { ok: false, error } };
}

function parseBoardRecord(raw: unknown): BoardRecord | null {
  const parsed = BoardRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function createWhiteboardWiring({
  boardsRoot, now = Date.now, newBoardId = () => crypto.randomUUID(), logger = console,
}: WhiteboardWiringOptions): WhiteboardPort {
  const recordsByBoardId = new Map<string, BoardRecord>();
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

  function writeRecord(record: BoardRecord): Promise<void> {
    return writeJsonAtomic(path.join(boardsRoot, `${record.board.id}${BOARD_FILE_EXTENSION}`), record, { mode: BOARD_FILE_MODE, mkdir: true });
  }

  function changeRecord(boardId: string, change: (record: BoardRecord) => RecordChange): Promise<WhiteboardReply> {
    return writeQueue.run(boardId, async () => {
      const current = recordsByBoardId.get(boardId);
      if (!current) return refusal(404, 'that board was deleted');
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
      return outcome.reply;
    });
  }

  function findBoardId(ref: string): { ok: true; boardId: string } | { ok: false; reply: WhiteboardReply } {
    const resolved = resolveBoardRef([...recordsByBoardId.values()].map((record) => record.board), ref);
    if ('error' in resolved) return { ok: false, reply: refusal(404, resolved.error) };
    return { ok: true, boardId: resolved.id };
  }

  async function createBoardFor(caller: WhiteboardCaller, title: string): Promise<WhiteboardReply> {
    const boardId = newBoardId();
    const nowMs = now();
    const record: BoardRecord = { board: createBoard({ id: boardId, title, nowMs }), log: [], cursorBySessionId: { [caller.id]: 0 } };
    recordsByBoardId.set(boardId, record);
    try {
      await writeQueue.run(boardId, () => writeRecord(record));
    } catch (error) {
      recordsByBoardId.delete(boardId);
      logger.warn(`[whiteboard] board ${boardId} could not be created: ${errorMessage(error)}`);
      return refusal(500, 'the board could not be saved, so it was not created');
    }
    return { status: 200, body: { ok: true, board: summarizeBoard(record), note: PUT_GUIDE } };
  }

  function putOps(boardId: string, ops: readonly Op[], author: Author): Promise<WhiteboardReply> {
    if (Buffer.byteLength(JSON.stringify(ops)) > WHITEBOARD_LIMITS.putBytes) {
      return Promise.resolve(refusal(413, `one put carries at most ${WHITEBOARD_LIMITS.putBytes} bytes of ops, so nothing changed`));
    }
    return changeRecord(boardId, (record) => {
      const result = applyOps(record.board, ops, author, now());
      if (!result.ok) return { ok: false, reply: refusal(400, `${result.error}, so nothing changed`) };
      const next = recordPut(record, result);
      return { ok: true, record: next, reply: { status: 200, body: { ok: true, version: next.board.version } } };
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
      case 'connect':
        return changeRecord(found.boardId, (record) => {
          const next = connectSession(record, caller.id);
          return { ok: true, record: next, reply: connectionReply(next, PUT_GUIDE) };
        });
      case 'disconnect':
        return changeRecord(found.boardId, (record) => {
          const next = disconnectSession(record, caller.id);
          return { ok: true, record: next, reply: connectionReply(next, 'this session no longer gets summaries of changes to this board') };
        });
      case 'get': return readBoard(found.boardId, caller.id);
      case 'put': return putOps(found.boardId, request.ops, author);
      case 'resolve': return putOps(found.boardId, [{ op: 'resolve', id: request.note }], author);
    }
  }

  return { loaded, handleAgent };
}

export { createWhiteboardWiring, WHITEBOARDS_FOLDER_NAME };
export type { WhiteboardPort };
