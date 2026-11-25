import { Op } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import type { TraceRecord } from '../../shared/contracts/trace.ts';
import type { DirectorDigest, DirectorDigestState, ProgressAnswer, SessionProgressAnswer } from '../../shared/contracts/director-digests.ts';
import { operatorPartOfPrompt } from '../../shared/board-branch-core.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../shared/contracts/untrusted-payload.ts';
import type { UntrustedPayload } from '../../shared/contracts/untrusted-payload.ts';
import { directorDigestKeyOf } from '../../shared/director-digest-key.ts';
import { standingMisfitOf } from '../../shared/director-fit.ts';
import type { FitVerdict } from '../../shared/director-fit.ts';
import { withoutControlCharacters } from '../../shared/lane-report-core.ts';
import { opensOperatorTurn } from '../../shared/trace-turn.ts';
import { wordCountOf } from './whiteboard-store-core.ts';

export const DIRECTOR_PROMPT_FILE = 'director-prompt.txt';
export const DIRECTOR_RESULT_FILE = 'director-result.json';
export const DIRECTOR_REPLY_MAX_CHARS = 16000;
const CHAT_LINE_MAX_CHARS = 160;
const DIRECTOR_DIGESTS_PER_SESSION = 20;
const DIRECTOR_CHAT_LINES_PER_SESSION = 100;
const DIRECTOR_SESSIONS_KEPT = 200;
const DIRECTOR_UNTRUSTED_SOURCE = 'studio-turn-reply';
const PROGRESS_UNTRUSTED_SOURCE = 'studio-progress';
const PROGRESS_SHAPED_MAX_CHARS = 80;
const PROGRESS_PHRASE_PATTERN = /^(how('s| is| are) (it|this|that|things|everything|the work|we|you)( all)? (going|doing|coming along)|how far along|status( update)?|progress( update)?|any (progress|update|news)|what('s| is) (left|done|the status|the progress)|where are (we|things|you)( at)?)\b/i;
const PROGRESS_ANSWER_MAX_CHARS = 300;
const PROGRESS_ANSWERS_PER_SESSION = 20;
const PROGRESS_NOTES_PER_AGENT = 3;
const DIGEST_MAX_CHARS = 80;
const POINT_MAX_CHARS = 60;
const MAX_POINTS = 3;
const CARD_WORD_LIMIT = 24;
const LEFTOVER_DIRECTOR_CARD_ID = /^dir-[0-9a-z]{7}-[0-9a-z]+$/;
const LEFTOVER_DIRECTOR_CARD_TONE = 'violet';
const LEFTOVER_DIRECTOR_WIRE_SUFFIX = '-to';

const BRANCH_TASK_MAX_CHARS = 4000;
const MISFIT_MAX_CHARS = 120;
const UNJUDGED_FIT: FitVerdict = { fitsTask: null, misfit: null };

export interface DirectorTurn {
  openedAt: number;
  promptText: string;
  replyText: string;
}

interface BranchTask {
  repoName: string;
  boxTitle: string;
}

interface DirectedTurn extends FitVerdict {
  chatLine: string | null;
  digest: string | null;
  points: string[];
}

interface DirectorVerdict extends FitVerdict {
  chatLine: string | null;
  digest: string | null;
}

export function directorTurnOf(records: readonly TraceRecord[], endedAtMs: number): DirectorTurn | null {
  const openingIndex = records.findLastIndex((record) => opensOperatorTurn(record) && record.ts <= endedAtMs);
  const opening = records[openingIndex];
  if (opening === undefined) return null;
  const nextOpeningIndex = records.findIndex((record, index) => index > openingIndex && opensOperatorTurn(record));
  const turnRecords = records.slice(openingIndex + 1, nextOpeningIndex === -1 ? undefined : nextOpeningIndex);
  const replyTexts = turnRecords.flatMap((record) => record.agentId === undefined && record.kind === 'assistant' && record.text.trim().length > 0 ? [record.text.trim()] : []);
  return { openedAt: opening.ts, promptText: opening.kind === 'prompt' ? opening.text : '', replyText: replyTexts.join('\n\n') };
}

export function withFinalReply(turn: DirectorTurn, finalReply: string | null): DirectorTurn {
  if (finalReply === null || turn.replyText.trimEnd().endsWith(finalReply.trim())) return turn;
  const tracedReply = turn.replyText.trimEnd();
  return { ...turn, replyText: tracedReply.length === 0 ? finalReply : `${tracedReply}\n\n${finalReply}` };
}

export function hasReply(turn: DirectorTurn): boolean {
  return turn.replyText.trim().length > 0;
}

export function directorPayloadOf(turn: DirectorTurn, fetchedAt: string, branchTask: BranchTask | null): UntrustedPayload {
  const replyItem = { kind: 'agent-reply', ref: 'turn', text: turn.replyText.slice(-DIRECTOR_REPLY_MAX_CHARS) };
  if (branchTask === null) return { trust: 'untrusted', source: DIRECTOR_UNTRUSTED_SOURCE, fetchedAt, items: [replyItem] };
  const taskText = `Repo ${branchTask.repoName}, started on ${branchTask.boxTitle}. Asked: ${operatorPartOfPrompt(turn.promptText).slice(0, BRANCH_TASK_MAX_CHARS)}`;
  return { trust: 'untrusted', source: DIRECTOR_UNTRUSTED_SOURCE, fetchedAt, items: [replyItem, { kind: 'branch-task', ref: 'task', text: taskText }] };
}

const FIT_RESULT_FIELDS = ', "fitsTask": true or false, "misfit": "..." or null';

function fitRulesOf(): string[] {
  return [
    "- fitsTask: false only when the reply shows work that does not serve the task in the branch-task item, or work in a part of the repo that task has no need for; true otherwise, and true when the reply shows too little to tell. Changing files outside the box the branch started on is fine whenever the task needs them.",
    `- misfit: when fitsTask is false, one sentence of at most ${MISFIT_MAX_CHARS} characters naming what does not fit; null when fitsTask is true.`,
  ];
}

export function buildDirectorPrompt(resultPath: string, checksFit: boolean): string {
  const payloadLine = checksFit
    ? `${UNTRUSTED_PAYLOAD_FILENAME} holds two items: a coding agent's reply at the end of its turn (agent-reply), and the task that agent, a branch, was given and where it started (branch-task). The operator never reads that reply directly: you decide what, if anything, reaches them, and whether the turn fits the task.`
    : `The one item in ${UNTRUSTED_PAYLOAD_FILENAME} is a coding agent's reply at the end of its turn. The operator never reads that reply directly: you decide what, if anything, reaches them.`;
  return [
    UNTRUSTED_PREAMBLE,
    '',
    payloadLine,
    '',
    `Write ${resultPath} with the Write tool, holding only this JSON object:`,
    `{"chatLine": "..." or null, "digest": "..." or null, "points": ["..."]${checksFit ? FIT_RESULT_FIELDS : ''}}`,
    '',
    'Rules:',
    `- chatLine: one short sentence of at most ${CHAT_LINE_MAX_CHARS} characters for the operator's chat, only when they must act (a question, a decision, a blocker), a piece of work is finished, or the reply answers or explains something to them; otherwise null. Most turns get null.`,
    '- When the reply answers or explains something, chatLine is that answer in one sentence, saying where on the board to look when the reply says it put the answer there.',
    `- digest: what is worth keeping on the agent's card in Studio, one line of at most ${DIGEST_MAX_CHARS} characters leading with the distinctive thing (the feature, file or bug), not a generic verb; null when nothing is.`,
    `- points: 0 to ${MAX_POINTS} short facts behind the digest (a result, a failure, a follow-up), each at most ${POINT_MAX_CHARS} characters; digest and points together stay within ${CARD_WORD_LIMIT} words.`,
    '- When the reply asks the operator a question or waits on a decision, chatLine states that question.',
    "- chatLine is null when the reply only relays that another agent (a branch) finished, its state or what it said: that agent's own line already reached the operator.",
    ...(checksFit ? fitRulesOf() : []),
    '- Report only what the reply says. Never answer its questions, never add advice, never invent results.',
  ].join('\n');
}

function cleanLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const line = withoutControlCharacters(value).replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
  return line.length === 0 ? null : line;
}

function pointsWithinWordLimit(digest: string, points: readonly string[]): string[] {
  const keptPoints: string[] = [];
  let words = wordCountOf(digest);
  for (const point of points) {
    words += wordCountOf(point);
    if (words > CARD_WORD_LIMIT) break;
    keptPoints.push(point);
  }
  return keptPoints;
}

function cardDigestOf(value: unknown): string | null {
  const digest = cleanLine(value, DIGEST_MAX_CHARS);
  return digest === null || wordCountOf(digest) > CARD_WORD_LIMIT ? null : digest;
}

export function misfitMessageOf(branchName: string, repoName: string, misfit: string): string {
  return `The Studio Director read the last turn of your branch ${branchName} in ${repoName} and judges that it does not fit its task: ${misfit.replace(/[.!?]+$/, '')}. Read its work, then redirect it with session send, or leave it when the work is right.`;
}

function fitVerdictOf(laneOutput: Record<string, unknown>): FitVerdict {
  if (laneOutput.fitsTask === true) return { fitsTask: true, misfit: null };
  const misfit = laneOutput.fitsTask === false ? cleanLine(laneOutput.misfit, MISFIT_MAX_CHARS) : null;
  return misfit === null ? UNJUDGED_FIT : { fitsTask: false, misfit };
}

export function parseDirectorVerdict(laneOutput: Record<string, unknown> | null, checksFit: boolean): DirectedTurn | null {
  if (laneOutput === null) return null;
  const fit = checksFit ? fitVerdictOf(laneOutput) : UNJUDGED_FIT;
  const chatLine = cleanLine(laneOutput.chatLine, CHAT_LINE_MAX_CHARS);
  const digest = cardDigestOf(laneOutput.digest);
  const rawPoints = Array.isArray(laneOutput.points) ? laneOutput.points : [];
  const points = digest === null ? [] : pointsWithinWordLimit(digest, rawPoints.flatMap((point) => cleanLine(point, POINT_MAX_CHARS) ?? []).slice(0, MAX_POINTS));
  return { chatLine, digest, points, ...fit };
}

export function fallbackVerdictOf(turn: DirectorTurn): DirectedTurn {
  const reply = turn.replyText.trim();
  const firstSentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(reply)?.[0] ?? reply;
  return { chatLine: cleanLine(firstSentence, CHAT_LINE_MAX_CHARS), digest: null, points: [], ...UNJUDGED_FIT };
}

function newestOpenedAtOf(digests: readonly DirectorDigest[]): number {
  return digests.at(-1)?.openedAt ?? 0;
}

export function withDirectorDigest(state: DirectorDigestState, sessionId: string, digest: DirectorDigest): DirectorDigestState {
  const otherTurns = (state.digestsBySessionId[sessionId] ?? []).filter((entry) => entry.openedAt !== digest.openedAt);
  const turnsInOrder = [...otherTurns, digest].sort((left, right) => left.openedAt - right.openedAt);
  const recentTurns = turnsInOrder.slice(-DIRECTOR_DIGESTS_PER_SESSION);
  const olderChatLines = turnsInOrder.slice(0, -DIRECTOR_DIGESTS_PER_SESSION).filter((entry) => entry.chatLine !== null).slice(-(DIRECTOR_CHAT_LINES_PER_SESSION - DIRECTOR_DIGESTS_PER_SESSION));
  const sessionDigests = [...olderChatLines, ...recentTurns];
  const keptSessions = Object.entries({ ...state.digestsBySessionId, [sessionId]: sessionDigests })
    .sort(([, left], [, right]) => newestOpenedAtOf(right) - newestOpenedAtOf(left))
    .slice(0, DIRECTOR_SESSIONS_KEPT);
  return { ...state, digestsBySessionId: Object.fromEntries(keptSessions) };
}

export function directorVerdictsOf(state: DirectorDigestState, sessionIds: readonly string[]): Record<string, DirectorVerdict> {
  const verdictByKey: Record<string, DirectorVerdict> = {};
  for (const sessionId of sessionIds) {
    for (const entry of state.digestsBySessionId[sessionId] ?? []) verdictByKey[directorDigestKeyOf(sessionId, entry.openedAt)] = { chatLine: entry.chatLine, digest: entry.digest, fitsTask: entry.fitsTask, misfit: entry.misfit };
  }
  return verdictByKey;
}

export function isSessionFlagged(state: DirectorDigestState, sessionId: string): boolean {
  return standingMisfitOf((state.digestsBySessionId[sessionId] ?? []).toReversed()) !== null;
}

export function leftoverDirectorCardOps(board: Board): Op[] {
  return [...board.elements.values()].flatMap((element) => {
    if (element.kind !== 'box' || element.tone !== LEFTOVER_DIRECTOR_CARD_TONE || !LEFTOVER_DIRECTOR_CARD_ID.test(element.id)) return [];
    const wire = board.elements.get(`${element.id}${LEFTOVER_DIRECTOR_WIRE_SUFFIX}`);
    if (wire?.kind !== 'wire' || wire.from !== element.id) return [];
    return [Op.parse({ op: 'remove', id: wire.id }), Op.parse({ op: 'remove', id: element.id })];
  });
}

interface ProgressContext {
  question: string;
  steps: { title: string; status: string }[];
  agents: { name: string; notes: string[] }[];
}

export function isProgressShaped(question: string): boolean {
  const trimmed = question.trim();
  return trimmed.length <= PROGRESS_SHAPED_MAX_CHARS && PROGRESS_PHRASE_PATTERN.test(trimmed);
}

export function planStepsOf(board: Board): { title: string; status: string }[] {
  return [...board.elements.values()].flatMap((element) => element.kind === 'box' && element.step ? [{ title: element.title, status: element.step.status }] : []);
}

export function latestNotesOf(state: DirectorDigestState, sessionId: string): string[] {
  return (state.digestsBySessionId[sessionId] ?? []).flatMap((entry) => entry.chatLine ?? entry.digest ?? []).slice(-PROGRESS_NOTES_PER_AGENT);
}

export function progressPayloadOf(context: ProgressContext, fetchedAt: string): UntrustedPayload {
  const stateText = JSON.stringify({ steps: context.steps, agents: context.agents }).slice(0, DIRECTOR_REPLY_MAX_CHARS);
  return { trust: 'untrusted', source: PROGRESS_UNTRUSTED_SOURCE, fetchedAt, items: [{ kind: 'operator-question', ref: 'question', text: context.question }, { kind: 'studio-state', ref: 'state', text: stateText }] };
}

export function buildProgressPrompt(resultPath: string): string {
  return [
    UNTRUSTED_PREAMBLE,
    '',
    `${UNTRUSTED_PAYLOAD_FILENAME} holds the operator's message to their Studio agents (ref question) and the state of the work (ref state): the plan steps with their status, and each agent's latest notes.`,
    '',
    `Write ${resultPath} with the Write tool, holding only this JSON object:`,
    '{"isProgress": true or false, "answer": "..." or null}',
    '',
    'Rules:',
    '- isProgress is true only when the message asks how the work is going, what is done, what is left or what an agent is doing, and asks nothing else; any request for work, a decision or an answer about the code is false.',
    `- answer, when isProgress is true: at most ${PROGRESS_ANSWER_MAX_CHARS} characters answering from the state alone, naming steps and agents; say plainly when the state does not tell. Null when isProgress is false.`,
    '- Report only what the state says. Never invent progress.',
  ].join('\n');
}

export function parseProgressAnswer(laneOutput: Record<string, unknown> | null): string | null {
  if (laneOutput === null || laneOutput.isProgress !== true) return null;
  return cleanLine(laneOutput.answer, PROGRESS_ANSWER_MAX_CHARS);
}

export function withProgressAnswer(state: DirectorDigestState, sessionId: string, answer: ProgressAnswer): DirectorDigestState {
  const sessionAnswers = [...(state.progressAnswersBySessionId[sessionId] ?? []), answer].slice(-PROGRESS_ANSWERS_PER_SESSION);
  const keptSessions = Object.entries({ ...state.progressAnswersBySessionId, [sessionId]: sessionAnswers })
    .sort(([, left], [, right]) => (right.at(-1)?.askedAt ?? 0) - (left.at(-1)?.askedAt ?? 0))
    .slice(0, DIRECTOR_SESSIONS_KEPT);
  return { ...state, progressAnswersBySessionId: Object.fromEntries(keptSessions) };
}

export function progressAnswersOf(state: DirectorDigestState, sessionIds: readonly string[]): SessionProgressAnswer[] {
  return sessionIds.flatMap((sessionId) => (state.progressAnswersBySessionId[sessionId] ?? []).map((answer) => ({ sessionId, ...answer })));
}
