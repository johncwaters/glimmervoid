import { randomBytes } from 'node:crypto';
import { Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardAsk } from '../../shared/contracts/whiteboard.ts';
import { OPERATOR_AUTHOR } from '../../shared/contracts/whiteboard-ops-core.ts';
import type { Author } from '../../shared/contracts/whiteboard-ops-core.ts';
import type { WhiteboardPort } from './whiteboard-wiring.ts';

type AskBoards = Pick<WhiteboardPort, 'putAsks' | 'boardOf'>;

interface AskingSession {
  id: string;
  name: string;
  path: string;
}

type MapLookup = { ok: true; boardId: string | null; boxIdByPath: Record<string, string> } | { ok: false; error: string };
type Sent = { ok: true } | { ok: false; error: string };
type AskReply = { status: number; body: { ok: true; boardId: string; ask: string; note: string } | { ok: false; error: string } };
type AnswerOutcome = { ok: true } | { ok: false; error: string };

interface BoardAskDeps {
  boards: AskBoards;
  mapOf: (repoDir: string, sessionId: string, paths: readonly string[]) => Promise<MapLookup>;
  sendToSession: (sessionId: string, text: string) => Sent;
}

const ASK_ID_PREFIX = 'ask-';
const ASK_ID_BYTES = 4;
const ASK_NOTE_TONE = 'yellow';

function newAskId(): string {
  return `${ASK_ID_PREFIX}${randomBytes(ASK_ID_BYTES).toString('hex')}`;
}

function refused(status: number, error: string): AskReply {
  return { status, body: { ok: false, error } };
}

function askNoteOps(askId: string, aboutBoxId: string, ask: BoardAsk): Op[] {
  return [
    Op.parse({ op: 'add', element: { kind: 'box', id: askId, shape: 'note', title: ask.question.slice(0, WHITEBOARD_LIMITS.title), tone: ASK_NOTE_TONE, ask, place: { near: { of: aboutBoxId, side: 'right' } } } }),
    Op.parse({ op: 'add', element: { kind: 'wire', id: `${askId}-about`, from: askId, to: aboutBoxId, dashed: true } }),
  ];
}

function askAnswerText(ask: BoardAsk, answer: string): string {
  return `Answer to your board question "${ask.question}": ${answer}`;
}

function askOf(board: Board | null, askBoxId: string): BoardAsk | null {
  const element = board?.elements.get(askBoxId);
  if (element?.kind !== 'box') return null;
  return element.ask;
}

function createBoardAsks({ boards, mapOf, sendToSession }: BoardAskDeps) {
  async function ask(session: AskingSession, request: { about: string; question: string; options: readonly string[] }): Promise<AskReply> {
    const lookup = await mapOf(session.path, session.id, [request.about]);
    if (!lookup.ok) return refused(409, `ask goes on the code map, and ${lookup.error}`);
    if (lookup.boardId === null) return refused(409, 'ask goes on the code map, and this repo has no map board yet');
    const board = await boards.boardOf(lookup.boardId);
    if (board === null) return refused(404, 'the code map board is gone');
    const aboutBoxId = board.elements.get(request.about)?.kind === 'box' ? request.about : lookup.boxIdByPath[request.about] ?? null;
    if (aboutBoxId === null || board.elements.get(aboutBoxId)?.kind !== 'box') return refused(400, `about names no box on the code map: ${request.about}`);
    const askId = newAskId();
    const author: Author = { id: session.id, name: session.name };
    const boardAsk: BoardAsk = { sessionId: session.id, question: request.question, options: [...request.options] };
    const reply = await boards.putAsks(lookup.boardId, askNoteOps(askId, aboutBoxId, boardAsk), author);
    if (!reply.body.ok) return refused(reply.status, reply.body.error);
    return { status: 200, body: { ok: true, boardId: lookup.boardId, ask: askId, note: 'the operator sees the question beside the box; their answer arrives as a chat message, so end the turn and wait for it' } };
  }

  async function answer(boardId: string, askBoxId: string, answerText: string): Promise<AnswerOutcome> {
    const boardAsk = askOf(await boards.boardOf(boardId), askBoxId);
    if (boardAsk === null) return { ok: false, error: 'That question is no longer on the board.' };
    const sent = sendToSession(boardAsk.sessionId, askAnswerText(boardAsk, answerText));
    if (!sent.ok) return sent;
    const removed = await boards.putAsks(boardId, [{ op: 'remove', id: askBoxId }], OPERATOR_AUTHOR);
    if (!removed.body.ok) return { ok: false, error: `The answer was sent, but the question stayed on the board: ${removed.body.error}` };
    return { ok: true };
  }

  return { ask, answer };
}

type BoardAsks = ReturnType<typeof createBoardAsks>;

export { createBoardAsks };
export type { BoardAsks };
