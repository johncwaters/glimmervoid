import { randomBytes } from 'node:crypto';
import { Op, WHITEBOARD_LIMITS } from '../../shared/contracts/whiteboard.ts';
import type { Board, BoardAsk } from '../../shared/contracts/whiteboard.ts';
import { isRecommendedOptionLabel } from '../../shared/contracts/question-manager.ts';
import { OPERATOR_AUTHOR } from '../../shared/contracts/whiteboard-ops-core.ts';
import type { Author } from '../../shared/contracts/whiteboard-ops-core.ts';
import type { WhiteboardPort } from './whiteboard-wiring.ts';

type AskBoards = Pick<WhiteboardPort, 'putAsks' | 'boardOf' | 'openAsksOf'>;

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
const ASK_CARD_WIDTH = 360;
const ASK_CARD_CHROME_HEIGHT = 26;
const ASK_CARD_META_HEIGHT = 26;
const ASK_CARD_LINE_HEIGHT = 21;
const ASK_CARD_GAP = 8;
const ASK_OPTION_GAP = 6;
const ASK_OPTION_CHROME_HEIGHT = 22;
const ASK_ANSWER_ROW_HEIGHT = 43;
const ASK_STATUS_ROW_HEIGHT = 26;
const ASK_CHAR_WIDTH = 8.4;
const ASK_HEADING_WIDTH = 330;
const ASK_RECOMMENDED_LABEL_WIDTH = 210;
const ASK_OPTION_LABEL_WIDTH = 290;

function newAskId(): string {
  return `${ASK_ID_PREFIX}${randomBytes(ASK_ID_BYTES).toString('hex')}`;
}

function refused(status: number, error: string): AskReply {
  return { status, body: { ok: false, error } };
}

function wrappedLineCount(text: string, widthPx: number): number {
  return Math.max(1, Math.ceil((text.length * ASK_CHAR_WIDTH) / widthPx));
}

function askCardHeightOf(ask: BoardAsk): number {
  const headingHeight = wrappedLineCount(ask.question, ASK_HEADING_WIDTH) * ASK_CARD_LINE_HEIGHT;
  const optionHeights = ask.options.map((option) => ASK_OPTION_CHROME_HEIGHT + ASK_CARD_LINE_HEIGHT * wrappedLineCount(option, isRecommendedOptionLabel(option) ? ASK_RECOMMENDED_LABEL_WIDTH : ASK_OPTION_LABEL_WIDTH));
  const optionsHeight = optionHeights.reduce((total, height) => total + height + ASK_OPTION_GAP, 0) + (optionHeights.length > 0 ? ASK_CARD_GAP - ASK_OPTION_GAP : 0);
  return ASK_CARD_CHROME_HEIGHT + ASK_CARD_META_HEIGHT + headingHeight + ASK_CARD_GAP + optionsHeight + ASK_ANSWER_ROW_HEIGHT + ASK_STATUS_ROW_HEIGHT;
}

function askBoxOps(askId: string, aboutBoxId: string, ask: BoardAsk): Op[] {
  const lines = ask.options.map((option) => ({ text: option, style: 'item' }));
  return [
    Op.parse({ op: 'add', element: { kind: 'box', id: askId, shape: 'note', title: ask.question.slice(0, WHITEBOARD_LIMITS.title), lines, ask, width: ASK_CARD_WIDTH, height: askCardHeightOf(ask), place: 'aside' } }),
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
    const reply = await boards.putAsks(lookup.boardId, askBoxOps(askId, aboutBoxId, boardAsk), author);
    if (!reply.body.ok) return refused(reply.status, reply.body.error);
    return { status: 200, body: { ok: true, boardId: lookup.boardId, ask: askId, note: 'the operator sees the question as a card right of the map, wired to the box; their answer arrives as your next message, so end the turn and wait for it' } };
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

  return { ask, answer, openAsksOf: boards.openAsksOf };
}

type BoardAsks = ReturnType<typeof createBoardAsks>;

export { createBoardAsks };
export type { BoardAsks };
