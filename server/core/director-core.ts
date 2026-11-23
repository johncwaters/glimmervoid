import path from 'node:path';
import { Op } from '../../shared/contracts/whiteboard.ts';
import type { Board } from '../../shared/contracts/whiteboard.ts';
import type { TraceRecord } from '../../shared/contracts/trace.ts';
import type { DirectorDigest, DirectorDigestState } from '../../shared/contracts/director-digests.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../shared/contracts/untrusted-payload.ts';
import type { UntrustedPayload } from '../../shared/contracts/untrusted-payload.ts';
import { directorDigestKeyOf } from '../../shared/director-digest-key.ts';
import { fileEditsOf } from '../../shared/file-edits-core.ts';
import { withoutControlCharacters } from '../../shared/lane-report-core.ts';
import { opensOperatorTurn } from '../../shared/trace-turn.ts';
import { wordCountOf } from './whiteboard-store-core.ts';

export const DIRECTOR_PROMPT_FILE = 'director-prompt.txt';
export const DIRECTOR_RESULT_FILE = 'director-result.json';
export const DIRECTOR_REPLY_MAX_CHARS = 16000;
const DIRECTOR_MIN_REPLY_CHARS = 400;
const DIRECTOR_DIGESTS_PER_SESSION = 20;
const DIRECTOR_SESSIONS_KEPT = 200;
const DIRECTOR_UNTRUSTED_SOURCE = 'studio-turn-reply';
const DIGEST_MAX_CHARS = 80;
const POINT_MAX_CHARS = 60;
const MAX_POINTS = 3;
const CARD_WORD_LIMIT = 24;
const LEFTOVER_DIRECTOR_CARD_ID = /^dir-[0-9a-z]{7}-[0-9a-z]+$/;
const LEFTOVER_DIRECTOR_CARD_TONE = 'violet';
const LEFTOVER_DIRECTOR_WIRE_SUFFIX = '-to';

export interface DirectorTurn {
  openedAt: number;
  replyText: string;
  editedPaths: string[];
  editedOutsideWorktreePaths: string[];
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:)?\//;

function forwardSlashed(toolPath: string): string {
  return toolPath.replaceAll('\\', '/');
}

function repoPathOf(toolPath: string, workingDirectory: string | null): string | null {
  const slashedPath = path.posix.normalize(forwardSlashed(toolPath));
  const slashedRoot = workingDirectory === null ? null : path.posix.normalize(forwardSlashed(workingDirectory)).replace(/\/+$/, '');
  const relativePath = slashedRoot !== null && slashedPath.startsWith(`${slashedRoot}/`) ? slashedPath.slice(slashedRoot.length + 1) : slashedPath;
  if (relativePath.length === 0 || relativePath === '.' || ABSOLUTE_PATH.test(relativePath) || relativePath === '..' || relativePath.startsWith('../')) return null;
  return relativePath;
}

function editedPathsOf(turnRecords: readonly TraceRecord[], workingDirectory: string | null): Pick<DirectorTurn, 'editedPaths' | 'editedOutsideWorktreePaths'> {
  const editedPaths = new Set<string>();
  const editedOutsideWorktreePaths = new Set<string>();
  for (const record of turnRecords) {
    if (record.agentId !== undefined || record.kind !== 'tool_call') continue;
    for (const edit of fileEditsOf(record.input, null)) {
      if (!edit.hasLineCounts) continue;
      const repoPath = repoPathOf(edit.path, workingDirectory);
      if (repoPath === null) editedOutsideWorktreePaths.add(forwardSlashed(edit.path));
      if (repoPath !== null) editedPaths.add(repoPath);
    }
  }
  return { editedPaths: [...editedPaths], editedOutsideWorktreePaths: [...editedOutsideWorktreePaths] };
}

interface DirectedTurn {
  digest: string;
  points: string[];
}

export function directorTurnOf(records: readonly TraceRecord[], endedAtMs: number, workingDirectory: string | null): DirectorTurn | null {
  const openingIndex = records.findLastIndex((record) => opensOperatorTurn(record) && record.ts <= endedAtMs);
  const opening = records[openingIndex];
  if (opening === undefined) return null;
  const nextOpeningIndex = records.findIndex((record, index) => index > openingIndex && opensOperatorTurn(record));
  const turnRecords = records.slice(openingIndex + 1, nextOpeningIndex === -1 ? undefined : nextOpeningIndex);
  const replyTexts = turnRecords.flatMap((record) => record.agentId === undefined && record.kind === 'assistant' && record.text.trim().length > 0 ? [record.text.trim()] : []);
  return { openedAt: opening.ts, replyText: replyTexts.join('\n\n'), ...editedPathsOf(turnRecords, workingDirectory) };
}

export function isWorthDirecting(turn: DirectorTurn): boolean {
  return turn.replyText.length >= DIRECTOR_MIN_REPLY_CHARS;
}

export function directorPayloadOf(turn: DirectorTurn, fetchedAt: string): UntrustedPayload {
  return { trust: 'untrusted', source: DIRECTOR_UNTRUSTED_SOURCE, fetchedAt, items: [{ kind: 'agent-reply', ref: 'turn', text: turn.replyText.slice(-DIRECTOR_REPLY_MAX_CHARS) }] };
}

export function buildDirectorPrompt(resultPath: string): string {
  return [
    UNTRUSTED_PREAMBLE,
    '',
    `The one item in ${UNTRUSTED_PAYLOAD_FILENAME} is a coding agent's reply at the end of its turn. The operator will read your digest instead of that reply, on the agent's card in Studio.`,
    '',
    `Write ${resultPath} with the Write tool, holding only this JSON object:`,
    '{"digest": "...", "points": ["..."]}',
    '',
    'Rules:',
    `- digest: one line, at most ${DIGEST_MAX_CHARS} characters, saying what the turn did or found, leading with the distinctive thing (the feature, file or bug), not a generic verb.`,
    `- points: 0 to ${MAX_POINTS} short facts the operator still needs (a result, a failure, a follow-up), each at most ${POINT_MAX_CHARS} characters; digest and points together stay within ${CARD_WORD_LIMIT} words.`,
    '- When the reply asks the operator a question or waits on a decision, the digest states that question.',
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

export function parseDirectorDigest(laneOutput: Record<string, unknown> | null): DirectedTurn | null {
  if (laneOutput === null) return null;
  const digest = cleanLine(laneOutput.digest, DIGEST_MAX_CHARS);
  if (digest === null || wordCountOf(digest) > CARD_WORD_LIMIT) return null;
  const rawPoints = Array.isArray(laneOutput.points) ? laneOutput.points : [];
  const points = rawPoints.flatMap((point) => cleanLine(point, POINT_MAX_CHARS) ?? []).slice(0, MAX_POINTS);
  return { digest, points: pointsWithinWordLimit(digest, points) };
}

function newestOpenedAtOf(digests: readonly DirectorDigest[]): number {
  return digests.at(-1)?.openedAt ?? 0;
}

export function withDirectorDigest(state: DirectorDigestState, sessionId: string, digest: DirectorDigest): DirectorDigestState {
  const otherTurns = (state.digestsBySessionId[sessionId] ?? []).filter((entry) => entry.openedAt !== digest.openedAt);
  const sessionDigests = [...otherTurns, digest].sort((left, right) => left.openedAt - right.openedAt).slice(-DIRECTOR_DIGESTS_PER_SESSION);
  const keptSessions = Object.entries({ ...state.digestsBySessionId, [sessionId]: sessionDigests })
    .sort(([, left], [, right]) => newestOpenedAtOf(right) - newestOpenedAtOf(left))
    .slice(0, DIRECTOR_SESSIONS_KEPT);
  return { ...state, digestsBySessionId: Object.fromEntries(keptSessions) };
}

export function directorDigestsOf(state: DirectorDigestState, sessionIds: readonly string[]): Record<string, string> {
  const digestByKey: Record<string, string> = {};
  for (const sessionId of sessionIds) {
    for (const entry of state.digestsBySessionId[sessionId] ?? []) digestByKey[directorDigestKeyOf(sessionId, entry.openedAt)] = entry.digest;
  }
  return digestByKey;
}

export function leftoverDirectorCardOps(board: Board): Op[] {
  return [...board.elements.values()].flatMap((element) => {
    if (element.kind !== 'box' || element.tone !== LEFTOVER_DIRECTOR_CARD_TONE || !LEFTOVER_DIRECTOR_CARD_ID.test(element.id)) return [];
    const wire = board.elements.get(`${element.id}${LEFTOVER_DIRECTOR_WIRE_SUFFIX}`);
    if (wire?.kind !== 'wire' || wire.from !== element.id) return [];
    return [Op.parse({ op: 'remove', id: wire.id }), Op.parse({ op: 'remove', id: element.id })];
  });
}
