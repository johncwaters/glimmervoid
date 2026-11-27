import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import type { BoxChoice, DockAddress } from './branch-core.ts';

export interface TurnStart {
  at: number;
  isRelayNews: boolean;
}

export interface TurnShownText {
  kind: 'chat-line' | 'last-reply';
  text: string;
}

export interface PendingSend {
  text: string;
  entryIdsAtDispatch: ReadonlySet<string> | null;
  isClaimed: boolean;
  isAwaitingOutboxEcho: boolean;
}

interface TurnDescriptor {
  id: string;
  openedAt: number | null;
}

interface BoardChangeTiming {
  at: number;
  boardId: string;
}

interface TurnAttribution<Change extends BoardChangeTiming> {
  branchNewsTurnIds: ReadonlySet<string>;
  boardChangeByTurnId: ReadonlyMap<string, Change>;
}

interface MentionDisplayItem {
  choice: BoxChoice;
  index: number;
  showGroupLabel: boolean;
}

interface DockLogOpenFlags {
  isTurnOver: boolean;
  hasFailedOutbox: boolean;
  hasFailure: boolean;
}

interface DockLogFoldFlags extends DockLogOpenFlags {
  isAddressedTurnRunning: boolean;
}

export function partTimeOf(part: ChatPart): number | null {
  if (part.kind === 'prompt') return part.at;
  if (part.kind === 'turn') return part.openedAt;
  return null;
}

type TurnSegmentsSource = Pick<Extract<ChatPart, { kind: 'turn' }>, 'segments'>;
type TurnShownSource = Pick<Extract<ChatPart, { kind: 'turn' }>, 'isOver' | 'segments'>;

export function replyTextsOf(part: TurnSegmentsSource): string[] {
  return part.segments.flatMap((segment) => (
    segment.kind === 'text' && segment.text.trim().length > 0 ? [segment.text] : []
  ));
}

function lastReplyTextOf(part: TurnSegmentsSource): string | null {
  const lastTextSegment = part.segments.findLast((segment) => segment.kind === 'text' && segment.text.trim().length > 0);
  return lastTextSegment?.kind === 'text' ? lastTextSegment.text : null;
}

export function shownTextOfTurn(
  part: TurnShownSource,
  isBranch: boolean,
  chatLine: string | null,
  isStartedByBranchNews: boolean,
): TurnShownText | null {
  if (chatLine !== null) return { kind: 'chat-line', text: chatLine };
  if (isBranch || !part.isOver || isStartedByBranchNews) return null;
  const lastReplyText = lastReplyTextOf(part);
  return lastReplyText === null ? null : { kind: 'last-reply', text: lastReplyText };
}

export function computeSessionTurnAttribution<Change extends BoardChangeTiming>(
  turns: readonly TurnDescriptor[],
  turnStarts: readonly TurnStart[],
  boardChanges: readonly Change[],
  mapBoardId: string | null,
): TurnAttribution<Change> {
  const branchNewsTurnIds = new Set<string>();
  const boardChangeByTurnId = new Map<string, Change>();

  const timedTurns = turns
    .map((turn, order) => ({ id: turn.id, openedAt: turn.openedAt, order }))
    .filter((turn): turn is { id: string; openedAt: number; order: number } => turn.openedAt !== null)
    .sort((left, right) => left.openedAt - right.openedAt || left.order - right.order);

  const sortedStarts = turnStarts
    .map((start, order) => ({ at: start.at, isRelayNews: start.isRelayNews, order }))
    .sort((left, right) => left.at - right.at || left.order - right.order);

  let startCursor = 0;
  let latestStart: { at: number; isRelayNews: boolean } | null = null;
  for (const turn of timedTurns) {
    while (startCursor < sortedStarts.length && sortedStarts[startCursor].at <= turn.openedAt) {
      latestStart = sortedStarts[startCursor];
      startCursor += 1;
    }
    if (latestStart?.isRelayNews) branchNewsTurnIds.add(turn.id);
  }

  if (mapBoardId === null || timedTurns.length === 0 || boardChanges.length === 0) {
    return { branchNewsTurnIds, boardChangeByTurnId };
  }

  const relevantChanges = boardChanges
    .map((change, order) => ({ change, order }))
    .filter(({ change }) => change.boardId === mapBoardId)
    .sort((left, right) => left.change.at - right.change.at || left.order - right.order);

  let turnCursor = 0;
  let latestTurn: { id: string; openedAt: number } | null = null;
  let changeStartCursor = 0;
  let latestStartAt: number | null = null;

  for (const { change } of relevantChanges) {
    while (turnCursor < timedTurns.length && timedTurns[turnCursor].openedAt <= change.at) {
      const candidate = timedTurns[turnCursor];
      if (latestTurn === null || candidate.openedAt > latestTurn.openedAt) {
        latestTurn = candidate;
      }
      turnCursor += 1;
    }
    while (changeStartCursor < sortedStarts.length && sortedStarts[changeStartCursor].at <= change.at) {
      latestStartAt = sortedStarts[changeStartCursor].at;
      changeStartCursor += 1;
    }
    if (latestTurn === null) continue;
    if (latestStartAt !== null && latestStartAt > latestTurn.openedAt) continue;
    boardChangeByTurnId.set(latestTurn.id, change);
  }

  return { branchNewsTurnIds, boardChangeByTurnId };
}

export function stepMentionIndex(currentIndex: number, step: 1 | -1, choiceCount: number): number {
  if (choiceCount <= 0) return 0;
  return (currentIndex + step + choiceCount) % choiceCount;
}

export function groupMentionChoices(choices: readonly BoxChoice[]): MentionDisplayItem[] {
  return choices.map((choice, index) => ({
    choice,
    index,
    showGroupLabel: index === 0 || choices[index - 1]?.repoName !== choice.repoName,
  }));
}

export function addressedSessionIdOf(address: DockAddress, mainSessionId: string): string | null {
  if (address.kind === 'branch') return address.sessionId;
  if (address.kind === 'main') return mainSessionId;
  return null;
}

export function shouldOpenLogOnRefresh(flags: DockLogOpenFlags): boolean {
  return !flags.isTurnOver || flags.hasFailedOutbox || flags.hasFailure;
}

export function shouldFoldLogOnBlur(flags: DockLogFoldFlags): boolean {
  return flags.isTurnOver && !flags.isAddressedTurnRunning && !flags.hasFailedOutbox && !flags.hasFailure;
}

export function claimPendingSends(
  pendingSends: readonly PendingSend[],
  entries: readonly ChatOutboxEntry[],
): void {
  const claimedEntryIds = new Set<string>();
  for (const pending of pendingSends) {
    const dispatchedEntryIds = pending.entryIdsAtDispatch;
    if (pending.isClaimed || dispatchedEntryIds === null) continue;
    const claimedEntry = entries.find((entry) => (
      entry.text === pending.text
      && !dispatchedEntryIds.has(entry.entryId)
      && !claimedEntryIds.has(entry.entryId)
    ));
    if (claimedEntry === undefined) continue;
    claimedEntryIds.add(claimedEntry.entryId);
    pending.isClaimed = true;
  }
}

export function insertProgressAnswersByTime<Row extends { at: number | null }>(
  partRows: readonly Row[],
  progressRows: readonly { askedAt: number; row: Row }[],
): Row[] {
  const merged = [...partRows];
  for (const { askedAt, row } of progressRows) {
    const laterIndex = merged.findIndex((candidate) => candidate.at !== null && candidate.at > askedAt);
    if (laterIndex >= 0) {
      merged.splice(laterIndex, 0, row);
      continue;
    }
    merged.push(row);
  }
  return merged;
}

export function progressAnswerRowsList(answers: readonly SessionProgressAnswer[]): readonly SessionProgressAnswer[] {
  const seen = new Set<string>();
  const unique: SessionProgressAnswer[] = [];
  for (const answer of answers) {
    const key = String(answer.askedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(answer);
  }
  return unique;
}
