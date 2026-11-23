import { Op } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import type { TraceRecord } from '../../shared/contracts/trace.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../shared/contracts/untrusted-payload.ts';
import type { UntrustedPayload } from '../../shared/contracts/untrusted-payload.ts';
import { directorCardIdOf, directorCardPrefixOf } from '../../shared/director-card.ts';
import { fileEditsOf } from '../../shared/file-edits-core.ts';
import { withoutControlCharacters } from '../../shared/lane-report-core.ts';
import { opensOperatorTurn } from '../../shared/trace-turn.ts';
import { wordCountOf } from './whiteboard-store-core.ts';

export const DIRECTOR_PROMPT_FILE = 'director-prompt.txt';
export const DIRECTOR_RESULT_FILE = 'director-result.json';
export const DIRECTOR_REPLY_MAX_CHARS = 16000;
const DIRECTOR_MIN_REPLY_CHARS = 400;
const DIRECTOR_CARDS_KEPT = 3;
const DIRECTOR_UNTRUSTED_SOURCE = 'studio-turn-reply';
const MAX_CANDIDATES = 12;
const DIGEST_MAX_CHARS = 80;
const POINT_MAX_CHARS = 60;
const MAX_POINTS = 3;
const CANDIDATE_TITLE_MAX_CHARS = 80;
const CARD_WORD_LIMIT = 24;
const CARD_TONE = 'violet';
const WIRE_SUFFIX = '-to';

export interface DirectorTurn {
  openedAt: number;
  replyText: string;
  editedPaths: string[];
  readPaths: string[];
}

interface DirectorCandidate {
  boxId: string;
  title: string;
}

interface DirectorDigest {
  digest: string;
  points: string[];
  boxId: string;
}

interface BoxLookup {
  boxIdByPath: Record<string, string>;
  fallbackBoxId: string;
  boxChoices: readonly DirectorCandidate[];
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?\//;

function forwardSlashed(path: string): string {
  return path.replaceAll('\\', '/');
}

function repoPathOf(toolPath: string, workingDirectory: string | null): string | null {
  const slashedPath = forwardSlashed(toolPath);
  const slashedRoot = workingDirectory === null ? null : forwardSlashed(workingDirectory).replace(/\/+$/, '');
  const relativePath = slashedRoot !== null && slashedPath.startsWith(`${slashedRoot}/`) ? slashedPath.slice(slashedRoot.length + 1) : slashedPath;
  if (relativePath.length === 0 || ABSOLUTE_PATH.test(relativePath)) return null;
  return relativePath;
}

export function directorTurnOf(records: readonly TraceRecord[], workingDirectory: string | null): DirectorTurn | null {
  const openingIndex = records.findLastIndex(opensOperatorTurn);
  const opening = records[openingIndex];
  if (opening === undefined) return null;
  const replyTexts: string[] = [];
  const editedPaths = new Set<string>();
  const readPaths = new Set<string>();
  for (const record of records.slice(openingIndex + 1)) {
    if (record.agentId !== undefined) continue;
    if (record.kind === 'assistant' && record.text.trim().length > 0) replyTexts.push(record.text.trim());
    if (record.kind !== 'tool_call') continue;
    for (const edit of fileEditsOf(record.input, null)) {
      const repoPath = repoPathOf(edit.path, workingDirectory);
      if (repoPath === null) continue;
      if (edit.hasLineCounts) {
        editedPaths.add(repoPath);
        continue;
      }
      readPaths.add(repoPath);
    }
  }
  const unchangedReadPaths = [...readPaths].filter((path) => !editedPaths.has(path));
  return { openedAt: opening.ts, replyText: replyTexts.join('\n\n'), editedPaths: [...editedPaths], readPaths: unchangedReadPaths };
}

export function isWorthDirecting(turn: DirectorTurn): boolean {
  return turn.replyText.length >= DIRECTOR_MIN_REPLY_CHARS;
}

export function touchedPathsOf(turn: DirectorTurn): string[] {
  return turn.editedPaths.length > 0 ? turn.editedPaths : turn.readPaths;
}

export function candidatesOf(turn: DirectorTurn, lookup: BoxLookup): DirectorCandidate[] {
  const titleByBoxId = new Map(lookup.boxChoices.map((choice) => [choice.boxId, choice.title]));
  const boxIds = [...new Set(touchedPathsOf(turn).flatMap((path) => lookup.boxIdByPath[path] ?? []))].slice(0, MAX_CANDIDATES);
  const chosenBoxIds = boxIds.length > 0 ? boxIds : [lookup.fallbackBoxId];
  return chosenBoxIds.map((boxId) => ({ boxId, title: cleanLine(titleByBoxId.get(boxId), CANDIDATE_TITLE_MAX_CHARS) ?? boxId }));
}

export function directorPayloadOf(turn: DirectorTurn, fetchedAt: string): UntrustedPayload {
  return { trust: 'untrusted', source: DIRECTOR_UNTRUSTED_SOURCE, fetchedAt, items: [{ kind: 'agent-reply', ref: 'turn', text: turn.replyText.slice(-DIRECTOR_REPLY_MAX_CHARS) }] };
}

export function buildDirectorPrompt(candidates: readonly DirectorCandidate[], resultPath: string): string {
  const candidateLines = candidates.map((candidate) => `- ${candidate.boxId}: ${candidate.title}`).join('\n');
  return [
    UNTRUSTED_PREAMBLE,
    '',
    `The one item in ${UNTRUSTED_PAYLOAD_FILENAME} is a coding agent's reply at the end of its turn. The operator will read your digest instead of that reply, on a card on the repo's code map.`,
    '',
    `Write ${resultPath} with the Write tool, holding only this JSON object:`,
    '{"digest": "...", "points": ["..."], "boxId": "..."}',
    '',
    'Rules:',
    `- digest: one line, at most ${DIGEST_MAX_CHARS} characters, saying what the turn did or found, leading with the distinctive thing (the feature, file or bug), not a generic verb.`,
    `- points: 0 to ${MAX_POINTS} short facts the operator still needs (a result, a failure, a follow-up), each at most ${POINT_MAX_CHARS} characters; digest and points together stay within ${CARD_WORD_LIMIT} words.`,
    '- When the reply asks the operator a question or waits on a decision, the digest states that question.',
    '- Report only what the reply says. Never answer its questions, never add advice, never invent results.',
    '- boxId: the id below of the box the turn mostly worked on, copied exactly.',
    '',
    'Boxes:',
    candidateLines,
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

export function parseDirectorDigest(laneOutput: Record<string, unknown> | null, candidates: readonly DirectorCandidate[]): DirectorDigest | null {
  if (laneOutput === null) return null;
  const digest = cleanLine(laneOutput.digest, DIGEST_MAX_CHARS);
  if (digest === null || wordCountOf(digest) > CARD_WORD_LIMIT) return null;
  const rawPoints = Array.isArray(laneOutput.points) ? laneOutput.points : [];
  const points = rawPoints.flatMap((point) => cleanLine(point, POINT_MAX_CHARS) ?? []).slice(0, MAX_POINTS);
  const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
  const chosen = onlyCandidate ?? candidates.find((candidate) => candidate.boxId === laneOutput.boxId);
  if (chosen === undefined) return null;
  return { digest, points: pointsWithinWordLimit(digest, points), boxId: chosen.boxId };
}

function cardOpenedAtOf(cardId: string, prefix: string): number {
  return Number.parseInt(cardId.slice(prefix.length), 36);
}

function removeCardOps(board: Board, cardId: string): Op[] {
  const wireId = `${cardId}${WIRE_SUFFIX}`;
  const wireOps: Op[] = board.elements.has(wireId) ? [Op.parse({ op: 'remove', id: wireId })] : [];
  return board.elements.has(cardId) ? [...wireOps, Op.parse({ op: 'remove', id: cardId })] : wireOps;
}

export function directorCardOps(sessionId: string, turn: DirectorTurn, directed: DirectorDigest, board: Board): Op[] {
  const prefix = directorCardPrefixOf(sessionId);
  const cardId = directorCardIdOf(sessionId, turn.openedAt);
  const card = Op.parse({ op: 'add', element: {
    kind: 'box', id: cardId, title: directed.digest, tone: CARD_TONE,
    lines: directed.points.map((point) => ({ text: point, style: 'item' })),
    place: { near: { of: directed.boxId, side: 'right' } },
  } });
  const wire = Op.parse({ op: 'add', element: { kind: 'wire', id: `${cardId}${WIRE_SUFFIX}`, from: cardId, to: directed.boxId, dashed: true } });
  const olderCardIds = [...board.elements.values()]
    .filter((element) => element.kind === 'box' && element.id.startsWith(prefix) && element.id !== cardId)
    .map((element) => element.id)
    .sort((left, right) => cardOpenedAtOf(right, prefix) - cardOpenedAtOf(left, prefix));
  const retiredOps = olderCardIds.slice(DIRECTOR_CARDS_KEPT - 1).flatMap((retiredId) => removeCardOps(board, retiredId));
  return [...removeCardOps(board, cardId), ...retiredOps, card, wire];
}
