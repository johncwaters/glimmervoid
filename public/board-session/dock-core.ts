import { BRANCH_PROMPT_MAX_CHARS, PROGRESS_QUESTION_MAX_CHARS } from '#shared/contracts/control/board-session-messages.ts';
import { CHAT_SEND_MAX_CHARS } from '#shared/contracts/control/session-messages.ts';
import type { SessionProgressAnswer } from '#shared/contracts/director-digests.ts';
import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import {
  type createChatOutboxProjection,
  isOptimisticOutboxEntryId,
  reconcileChatOutboxProjection,
} from '../state/chat-outbox-core.ts';
import {
  boxMentionAt,
  matchingBoxChoices,
  placeTitleOf,
  textWithoutMention,
} from './branch-core.ts';
import type { BoxChoice, BoxMention, DockAddress } from './branch-core.ts';

type ChatOutboxProjection = ReturnType<typeof createChatOutboxProjection>;

export const MAIN_ADDRESS: DockAddress = { kind: 'main' };
export const NOT_SENT_TEXT = 'The message was not sent.';
const PENDING_RUNNING_STATUS_TEXT = 'Queued';
const PENDING_IDLE_STATUS_TEXT = 'Sending';

export interface DockBranchDescriptor {
  sessionId: string;
  name: string;
  workingDirectory: string | null;
  agentId: string | null;
  aboutTitle: string;
}

export interface FeedSpeaker<Branch extends DockBranchDescriptor = DockBranchDescriptor> {
  sessionId: string;
  name: string;
  agentId: string | null;
  branch: Branch | null;
}

export interface PartRowEntry<Branch extends DockBranchDescriptor = DockBranchDescriptor> {
  kind: 'part';
  key: string;
  sessionId: string;
  part: ChatPart;
  speaker: FeedSpeaker<Branch>;
  at: number | null;
}

export interface ProgressQuestionRowEntry {
  kind: 'progress-question';
  key: string;
  question: string;
  at: number;
}

export interface ProgressAnswerRowEntry {
  kind: 'progress-answer';
  key: string;
  answer: string;
  at: number;
}

type LogRowEntry<Branch extends DockBranchDescriptor = DockBranchDescriptor> =
  | PartRowEntry<Branch>
  | ProgressQuestionRowEntry
  | ProgressAnswerRowEntry;

export interface TurnStart {
  at: number;
  isRelayNews: boolean;
}

interface TurnShownText {
  kind: 'chat-line' | 'last-reply';
  text: string;
}

export interface PendingSend {
  id: number;
  text: string;
  entryIdsAtDispatch: ReadonlySet<string> | null;
  isClaimed: boolean;
  isAwaitingOutboxEcho: boolean;
}

interface QueueDisplayState {
  standInPrompts: Extract<ChatPart, { kind: 'prompt' }>[];
  queuedEntries: ChatOutboxEntry[];
  pendingSends: { text: string; statusText: string }[];
}

interface DockLogState<Branch extends DockBranchDescriptor = DockBranchDescriptor> {
  partEntries: readonly PartRowEntry<Branch>[];
  progressAnswers: readonly SessionProgressAnswer[];
  speakersBySessionId: ReadonlyMap<string, FeedSpeaker<Branch>>;
  turnStartsBySessionId: ReadonlyMap<string, ReadonlyMap<string, TurnStart>>;
  shownPromptPartIds: ReadonlySet<string>;
}

interface DockMentionState {
  active: BoxMention | null;
  choices: readonly BoxChoice[];
  activeIndex: number;
}

interface DockQueueState {
  nextPendingSendId: number;
  pendingSends: readonly PendingSend[];
  cancellingEntryIds: ReadonlySet<string>;
  queueView: QueueDisplayState;
}

type MentionKeydownDecision =
  | { kind: 'none' }
  | { kind: 'address-main'; preventDefault: boolean }
  | { kind: 'close-mentions' }
  | { kind: 'step-mention'; nextState: DockMentionState }
  | { kind: 'pick-mention'; choice: BoxChoice };

type SendDispatchPlan =
  | { kind: 'branch-spawn'; parentId: string; aboutBoxId: string; aboutTitle: string; prompt: string }
  | { kind: 'branch-send'; sessionId: string; text: string }
  | { kind: 'main-send'; sessionId: string; text: string; shouldAskProgress: boolean };

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

export const EMPTY_MENTION_STATE: DockMentionState = {
  active: null,
  choices: [],
  activeIndex: 0,
};

export function createInitialLogState<Branch extends DockBranchDescriptor>(
  mainSpeaker: FeedSpeaker<Branch>,
): DockLogState<Branch> {
  return {
    partEntries: [],
    progressAnswers: [],
    speakersBySessionId: new Map([[mainSpeaker.sessionId, mainSpeaker]]),
    turnStartsBySessionId: new Map(),
    shownPromptPartIds: new Set(),
  };
}

export function createInitialQueueState(): DockQueueState {
  return {
    nextPendingSendId: 1,
    pendingSends: [],
    cancellingEntryIds: new Set(),
    queueView: {
      standInPrompts: [],
      queuedEntries: [],
      pendingSends: [],
    },
  };
}

function rowKeyOf(sessionId: string, partId: string): string {
  return `${sessionId}:${partId}`;
}

function partTimeOf(part: ChatPart): number | null {
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

function upsertPartEntries<Branch extends DockBranchDescriptor>(
  previous: readonly PartRowEntry<Branch>[],
  sessionId: string,
  speaker: FeedSpeaker<Branch>,
  parts: readonly ChatPart[],
  droppedPartIds: readonly string[],
): PartRowEntry<Branch>[] {
  const next: (PartRowEntry<Branch> | null)[] = [...previous];
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < next.length; i += 1) {
    const entry = next[i];
    if (entry !== null) indexByKey.set(entry.key, i);
  }
  for (const part of parts) {
    const key = rowKeyOf(sessionId, part.id);
    const existingIndex = indexByKey.get(key);
    if (part.kind !== 'prompt' && part.kind !== 'turn' && part.kind !== 'card') {
      if (existingIndex !== undefined) {
        next[existingIndex] = null;
        indexByKey.delete(key);
      }
      continue;
    }
    const entry: PartRowEntry<Branch> = {
      kind: 'part',
      key,
      sessionId,
      part,
      speaker,
      at: partTimeOf(part),
    };
    if (existingIndex !== undefined) {
      next[existingIndex] = entry;
      continue;
    }
    indexByKey.set(key, next.length);
    next.push(entry);
  }
  for (const partId of droppedPartIds) {
    const key = rowKeyOf(sessionId, partId);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) continue;
    next[existingIndex] = null;
    indexByKey.delete(key);
  }
  return next.filter((entry): entry is PartRowEntry<Branch> => entry !== null);
}

function updateTurnStartsForParts(
  previous: ReadonlyMap<string, ReadonlyMap<string, TurnStart>>,
  sessionId: string,
  parts: readonly ChatPart[],
  droppedPartIds: readonly string[],
): Map<string, ReadonlyMap<string, TurnStart>> {
  const nextBySession = new Map(previous);
  const existing = nextBySession.get(sessionId);
  let sessionStarts: Map<string, TurnStart> | null = null;
  for (const part of parts) {
    if (part.kind !== 'prompt' && part.kind !== 'system-line') continue;
    sessionStarts ??= new Map(existing ?? []);
    sessionStarts.set(part.id, { at: part.at, isRelayNews: part.kind === 'system-line' && part.isRelayNews });
  }
  for (const partId of droppedPartIds) {
    if (!existing?.has(partId) && !sessionStarts?.has(partId)) continue;
    sessionStarts ??= new Map(existing ?? []);
    sessionStarts.delete(partId);
  }
  if (sessionStarts !== null) nextBySession.set(sessionId, sessionStarts);
  return nextBySession;
}

export function applyPartsChanged<Branch extends DockBranchDescriptor>(
  state: DockLogState<Branch>,
  sessionId: string,
  changedParts: readonly ChatPart[],
  droppedPartIds: readonly string[],
  isLive: boolean,
): { state: DockLogState<Branch>; newLivePromptCount: number } {
  const speaker = state.speakersBySessionId.get(sessionId);
  if (!speaker) return { state, newLivePromptCount: 0 };

  let shownPromptPartIds = state.shownPromptPartIds;
  let newLivePromptCount = 0;
  if (speaker.branch === null) {
    const nextShown = new Set(shownPromptPartIds);
    for (const droppedPartId of droppedPartIds) nextShown.delete(droppedPartId);
    for (const part of changedParts) {
      if (part.kind !== 'prompt' || part.isBoardAnswer || nextShown.has(part.id)) continue;
      nextShown.add(part.id);
      if (isLive) newLivePromptCount += 1;
    }
    shownPromptPartIds = nextShown;
  }

  const turnStartsBySessionId = updateTurnStartsForParts(
    state.turnStartsBySessionId,
    sessionId,
    changedParts,
    droppedPartIds,
  );
  const partEntries = changedParts.length === 0 && droppedPartIds.length === 0
    ? state.partEntries
    : upsertPartEntries(state.partEntries, sessionId, speaker, changedParts, droppedPartIds);

  return {
    state: {
      ...state,
      partEntries,
      turnStartsBySessionId,
      shownPromptPartIds,
    },
    newLivePromptCount,
  };
}

export function applySessionRebuilt<Branch extends DockBranchDescriptor>(
  state: DockLogState<Branch>,
  sessionId: string,
  rebuiltParts: readonly ChatPart[],
  replacedPartIds: readonly string[],
  progressAnswers: readonly SessionProgressAnswer[],
): DockLogState<Branch> {
  const speaker = state.speakersBySessionId.get(sessionId);
  if (!speaker) return state;

  const clearedStarts = new Map(state.turnStartsBySessionId);
  clearedStarts.delete(sessionId);
  const turnStartsBySessionId = updateTurnStartsForParts(clearedStarts, sessionId, rebuiltParts, []);

  if (speaker.branch !== null) {
    const replacedKeys = new Set(replacedPartIds.map((partId) => rowKeyOf(sessionId, partId)));
    const remaining = state.partEntries.filter(
      (entry) => entry.sessionId !== sessionId && !replacedKeys.has(entry.key),
    );
    return {
      ...state,
      partEntries: upsertPartEntries(remaining, sessionId, speaker, rebuiltParts, []),
      turnStartsBySessionId,
    };
  }

  const nextShown = new Set<string>();
  for (const part of rebuiltParts) {
    if (part.kind === 'prompt') nextShown.add(part.id);
  }
  return {
    ...state,
    partEntries: upsertPartEntries([], sessionId, speaker, rebuiltParts, []),
    progressAnswers: [...progressAnswers],
    turnStartsBySessionId,
    shownPromptPartIds: nextShown,
  };
}

export function applySessionReset<Branch extends DockBranchDescriptor>(
  state: DockLogState<Branch>,
  sessionId: string,
): DockLogState<Branch> {
  const speaker = state.speakersBySessionId.get(sessionId);
  const turnStartsBySessionId = new Map(state.turnStartsBySessionId);
  turnStartsBySessionId.delete(sessionId);
  return {
    ...state,
    partEntries: state.partEntries.filter((entry) => entry.sessionId !== sessionId),
    turnStartsBySessionId,
    shownPromptPartIds: speaker?.branch === null ? new Set() : state.shownPromptPartIds,
  };
}

export function setLogProgressAnswers<Branch extends DockBranchDescriptor>(
  state: DockLogState<Branch>,
  progressAnswers: readonly SessionProgressAnswer[],
): DockLogState<Branch> {
  return {
    ...state,
    progressAnswers: [...progressAnswers],
  };
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

export function selectAttributionBySessionId<
  Branch extends DockBranchDescriptor,
  Change extends BoardChangeTiming,
>(
  logState: DockLogState<Branch>,
  boardChangesBySessionId: ReadonlyMap<string, readonly Change[]>,
  mapBoardId: string | null,
): Map<string, TurnAttribution<Change>> {
  const turnsBySession = new Map<string, TurnDescriptor[]>();
  for (const entry of logState.partEntries) {
    if (entry.part.kind !== 'turn') continue;
    const list = turnsBySession.get(entry.sessionId) ?? [];
    list.push({ id: entry.part.id, openedAt: entry.part.openedAt });
    turnsBySession.set(entry.sessionId, list);
  }
  const attributions = new Map<string, TurnAttribution<Change>>();
  for (const [sessionId, turns] of turnsBySession) {
    const turnStarts = [...(logState.turnStartsBySessionId.get(sessionId)?.values() ?? [])];
    attributions.set(
      sessionId,
      computeSessionTurnAttribution(
        turns,
        turnStarts,
        boardChangesBySessionId.get(sessionId) ?? [],
        mapBoardId,
      ),
    );
  }
  return attributions;
}

export function selectTurnDisplay<
  Branch extends DockBranchDescriptor,
  Change extends BoardChangeTiming,
>(
  partRow: PartRowEntry<Branch>,
  attributionBySessionId: ReadonlyMap<string, TurnAttribution<Change>>,
  digestOf: (sessionId: string, openedAt: number) => string | null,
): { shown: TurnShownText | null; boardChange: Change | null } {
  if (partRow.part.kind !== 'turn') return { shown: null, boardChange: null };
  const attribution = attributionBySessionId.get(partRow.sessionId);
  const chatLine = partRow.part.openedAt === null
    ? null
    : digestOf(partRow.sessionId, partRow.part.openedAt);
  const isBranchNews = attribution?.branchNewsTurnIds.has(partRow.part.id) ?? false;
  return {
    shown: shownTextOfTurn(partRow.part, partRow.speaker.branch !== null, chatLine, isBranchNews),
    boardChange: attribution?.boardChangeByTurnId.get(partRow.part.id) ?? null,
  };
}

function progressAnswerRowsList(answers: readonly SessionProgressAnswer[]): readonly SessionProgressAnswer[] {
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

export function insertProgressAnswersByTime<Row extends { at: number | null }>(
  partRows: readonly Row[],
  progressRows: readonly { askedAt: number; row: Row }[],
): Row[] {
  if (progressRows.length === 0) return [...partRows];
  const sortedProgress = progressRows
    .map((entry, order) => ({ askedAt: entry.askedAt, row: entry.row, order }))
    .sort((left, right) => left.askedAt - right.askedAt || left.order - right.order);

  const merged: Row[] = [];
  let progressCursor = 0;
  for (const partRow of partRows) {
    if (partRow.at !== null) {
      while (progressCursor < sortedProgress.length && sortedProgress[progressCursor].askedAt < partRow.at) {
        merged.push(sortedProgress[progressCursor].row);
        progressCursor += 1;
      }
    }
    merged.push(partRow);
  }
  while (progressCursor < sortedProgress.length) {
    merged.push(sortedProgress[progressCursor].row);
    progressCursor += 1;
  }
  return merged;
}

export function selectMergedLogRows<Branch extends DockBranchDescriptor>(
  logState: DockLogState<Branch>,
): LogRowEntry<Branch>[] {
  const uniqueAnswers = progressAnswerRowsList(logState.progressAnswers);
  const answerRows = uniqueAnswers.flatMap((entry) => [
    {
      askedAt: entry.askedAt,
      row: {
        kind: 'progress-question' as const,
        key: `progress-q:${entry.askedAt}`,
        question: entry.question,
        at: entry.askedAt,
      },
    },
    {
      askedAt: entry.askedAt,
      row: {
        kind: 'progress-answer' as const,
        key: `progress-a:${entry.askedAt}`,
        answer: entry.answer,
        at: entry.askedAt,
      },
    },
  ]);
  return insertProgressAnswersByTime<LogRowEntry<Branch>>(logState.partEntries, answerRows);
}

function stepMentionIndex(currentIndex: number, step: 1 | -1, choiceCount: number): number {
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

export function activeDescendantIdOf(mention: DockMentionState): string | null {
  return mention.choices.length === 0 ? null : `bs-mention-${mention.activeIndex}`;
}

export function readDockMention(
  inputValue: string,
  selectionStart: number | null,
  boxChoices: readonly BoxChoice[],
): DockMentionState {
  const active = boxMentionAt(inputValue, selectionStart ?? inputValue.length);
  if (active === null) return EMPTY_MENTION_STATE;
  return {
    active,
    choices: matchingBoxChoices(boxChoices, active.query),
    activeIndex: 0,
  };
}

export function pickDockMentionChoice(
  mention: DockMentionState,
  inputValue: string,
  choice: BoxChoice,
): { nextInputValue: string; nextAddress: DockAddress } | null {
  if (mention.active === null) return null;
  return {
    nextInputValue: textWithoutMention(inputValue, mention.active),
    nextAddress: {
      kind: 'new-branch',
      aboutBoxId: choice.boxId,
      aboutTitle: placeTitleOf(choice.repoName, choice.title),
    },
  };
}

export function decideMentionKeydown(
  mention: DockMentionState,
  address: DockAddress,
  key: string,
  inputLength: number,
): MentionKeydownDecision {
  if (key === 'Backspace' && inputLength === 0 && address.kind !== 'main') {
    return { kind: 'address-main', preventDefault: false };
  }
  if (key === 'Escape' && mention.choices.length === 0 && address.kind === 'new-branch') {
    return { kind: 'address-main', preventDefault: true };
  }
  if (mention.choices.length === 0) return { kind: 'none' };
  if (key === 'Escape') return { kind: 'close-mentions' };
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    return {
      kind: 'step-mention',
      nextState: {
        ...mention,
        activeIndex: stepMentionIndex(mention.activeIndex, step, mention.choices.length),
      },
    };
  }
  if (key !== 'Enter' && key !== 'Tab') return { kind: 'none' };
  const choice = mention.choices[mention.activeIndex];
  return choice ? { kind: 'pick-mention', choice } : { kind: 'none' };
}

export function addressedSessionIdOf(address: DockAddress, mainSessionId: string): string | null {
  if (address.kind === 'branch') return address.sessionId;
  if (address.kind === 'main') return mainSessionId;
  return null;
}

export function maxLengthForAddress(address: DockAddress): number {
  return address.kind === 'new-branch' ? BRANCH_PROMPT_MAX_CHARS : CHAT_SEND_MAX_CHARS;
}

export function resolveAddressForSession(
  mainSessionId: string,
  sessionId: string | null,
  name: string,
): DockAddress {
  if (sessionId === null || sessionId === mainSessionId) return MAIN_ADDRESS;
  return { kind: 'branch', sessionId, aboutTitle: name };
}

export function resolveAddressForBranch(branch: Pick<DockBranchDescriptor, 'sessionId' | 'aboutTitle'>): DockAddress {
  return { kind: 'branch', sessionId: branch.sessionId, aboutTitle: branch.aboutTitle };
}

export function resolveAddressForBox(boxId: string, title: string): DockAddress {
  return { kind: 'new-branch', aboutBoxId: boxId, aboutTitle: title };
}

export function isTargetSessionTurnRunning(
  mainSessionId: string,
  targetId: string,
  isMainTurnOver: boolean,
  isBranchTurnOver: (sessionId: string) => boolean,
): boolean {
  if (targetId === mainSessionId) return !isMainTurnOver;
  return !isBranchTurnOver(targetId);
}

export function isAddressedSessionTurnRunning(
  address: DockAddress,
  mainSessionId: string,
  isMainTurnOver: boolean,
  hasBranchFeed: (sessionId: string) => boolean,
  isBranchTurnOver: (sessionId: string) => boolean,
): boolean {
  const sessionId = addressedSessionIdOf(address, mainSessionId);
  if (sessionId === null) return false;
  if (sessionId === mainSessionId) return !isMainTurnOver;
  return hasBranchFeed(sessionId) && !isBranchTurnOver(sessionId);
}

export function hasFailedOutboxEntry(entries: readonly ChatOutboxEntry[]): boolean {
  return entries.some((entry) => entry.state === 'failed');
}

export function shouldOpenLogOnRefresh(flags: DockLogOpenFlags): boolean {
  return !flags.isTurnOver || flags.hasFailedOutbox || flags.hasFailure;
}

export function shouldFoldLogOnBlur(flags: DockLogFoldFlags): boolean {
  return flags.isTurnOver && !flags.isAddressedTurnRunning && !flags.hasFailedOutbox && !flags.hasFailure;
}

export function toggleExpandedRowKey(previous: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function reconcileDockBranches<Branch extends DockBranchDescriptor>(
  logState: DockLogState<Branch>,
  currentAddress: DockAddress,
  mainSessionId: string,
  openFeedSessionIds: ReadonlySet<string>,
  branches: readonly Branch[],
): {
  logState: DockLogState<Branch>;
  nextAddress: DockAddress;
  sessionIdsToClose: string[];
  branchesToOpen: Branch[];
} {
  const shownBranchIds = new Set(branches.map((branch) => branch.sessionId));
  const sessionIdsToClose: string[] = [];
  const nextSpeakers = new Map(logState.speakersBySessionId);
  const nextTurnStarts = new Map(logState.turnStartsBySessionId);
  let nextAddress = currentAddress;

  for (const sessionId of openFeedSessionIds) {
    if (sessionId === mainSessionId || shownBranchIds.has(sessionId)) continue;
    sessionIdsToClose.push(sessionId);
    nextSpeakers.delete(sessionId);
    nextTurnStarts.delete(sessionId);
    if (nextAddress.kind === 'branch' && nextAddress.sessionId === sessionId) {
      nextAddress = MAIN_ADDRESS;
    }
  }

  const branchesToOpen: Branch[] = [];
  for (const branch of branches) {
    nextSpeakers.set(branch.sessionId, {
      sessionId: branch.sessionId,
      name: branch.name,
      agentId: branch.agentId,
      branch,
    });
    if (!openFeedSessionIds.has(branch.sessionId)) branchesToOpen.push(branch);
  }

  return {
    logState: {
      ...logState,
      speakersBySessionId: nextSpeakers,
      turnStartsBySessionId: nextTurnStarts,
    },
    nextAddress,
    sessionIdsToClose,
    branchesToOpen,
  };
}

export function claimPendingSends(
  pendingSends: readonly PendingSend[],
  entries: readonly ChatOutboxEntry[],
): PendingSend[] {
  const claimedEntryIds = new Set<string>();
  return pendingSends.map((pending) => {
    const dispatchedEntryIds = pending.entryIdsAtDispatch;
    if (pending.isClaimed || dispatchedEntryIds === null) return pending;
    const claimedEntry = entries.find((entry) => (
      entry.text === pending.text
      && !dispatchedEntryIds.has(entry.entryId)
      && !claimedEntryIds.has(entry.entryId)
    ));
    if (claimedEntry === undefined) return pending;
    claimedEntryIds.add(claimedEntry.entryId);
    return { ...pending, isClaimed: true };
  });
}

export function enqueuePendingSend(
  state: DockQueueState,
  text: string,
): { state: DockQueueState; pendingId: number } {
  const pendingId = state.nextPendingSendId;
  const pending: PendingSend = {
    id: pendingId,
    text,
    entryIdsAtDispatch: null,
    isClaimed: false,
    isAwaitingOutboxEcho: false,
  };
  return {
    pendingId,
    state: {
      ...state,
      nextPendingSendId: pendingId + 1,
      pendingSends: [...state.pendingSends, pending],
    },
  };
}

export function markPendingSendDispatched(
  state: DockQueueState,
  pendingId: number,
  outboxEntries: readonly ChatOutboxEntry[],
): DockQueueState {
  const entryIdsAtDispatch = new Set(outboxEntries.map((entry) => entry.entryId));
  return {
    ...state,
    pendingSends: state.pendingSends.map((pending) => (
      pending.id === pendingId ? { ...pending, entryIdsAtDispatch } : pending
    )),
  };
}

export function markPendingSendOutcome(
  state: DockQueueState,
  pendingId: number,
  sendFailure: string | null,
): DockQueueState {
  return {
    ...state,
    pendingSends: state.pendingSends.map((pending) => (
      pending.id === pendingId ? { ...pending, isAwaitingOutboxEcho: sendFailure === null } : pending
    )),
  };
}

export function settleDockPendingSend(state: DockQueueState, pendingId: number): DockQueueState {
  const target = state.pendingSends.find((candidate) => candidate.id === pendingId);
  if (!target || (target.isAwaitingOutboxEcho && !target.isClaimed)) return state;
  return {
    ...state,
    pendingSends: state.pendingSends.filter((candidate) => candidate.id !== pendingId),
  };
}

export function reconcileOutboxEcho(
  state: DockQueueState,
  outboxEntries: readonly ChatOutboxEntry[],
): DockQueueState {
  const claimed = claimPendingSends(state.pendingSends, outboxEntries);
  return {
    ...state,
    pendingSends: claimed.filter((pending) => !pending.isAwaitingOutboxEcho),
  };
}

export function reconcileDockQueue(
  state: DockQueueState,
  outboxProjection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
  isTurnOver: boolean,
  nowMs: number,
): {
  state: DockQueueState;
  removedStandInEntryIds: string[];
  clearedStandInEntryIds: string[];
  shouldOpenLog: boolean;
  shouldRefreshMainFeed: boolean;
} {
  const update = reconcileChatOutboxProjection(outboxProjection, entries, !isTurnOver, nowMs);
  for (const entryId of update.removedStandInEntryIds) {
    outboxProjection.standInByEntryId.delete(entryId);
  }
  const claimedPendingSends = claimPendingSends(state.pendingSends, entries);
  const shownPendingSends = claimedPendingSends
    .filter((pending) => !pending.isClaimed)
    .map((pending) => ({
      text: pending.text,
      statusText: isTurnOver ? PENDING_IDLE_STATUS_TEXT : PENDING_RUNNING_STATUS_TEXT,
    }));
  const standInPrompts = [...outboxProjection.standInByEntryId.values()].filter(
    (standIn): standIn is Extract<ChatPart, { kind: 'prompt' }> => standIn.kind === 'prompt',
  );
  return {
    state: {
      ...state,
      pendingSends: claimedPendingSends,
      queueView: {
        standInPrompts,
        queuedEntries: update.queuedEntries,
        pendingSends: shownPendingSends,
      },
    },
    removedStandInEntryIds: update.removedStandInEntryIds,
    clearedStandInEntryIds: update.clearedStandInEntryIds,
    shouldOpenLog: hasFailedOutboxEntry(update.queuedEntries),
    shouldRefreshMainFeed: update.clearedStandInEntryIds.length > 0,
  };
}

export function setCancellingEntry(
  state: DockQueueState,
  entryId: string,
  isCancelling: boolean,
): DockQueueState {
  const next = new Set(state.cancellingEntryIds);
  if (isCancelling) next.add(entryId);
  if (!isCancelling) next.delete(entryId);
  return {
    ...state,
    cancellingEntryIds: next,
  };
}

export function isOutboxCancelDisabled(
  entry: Pick<ChatOutboxEntry, 'entryId' | 'state'>,
  cancellingEntryIds: ReadonlySet<string>,
): boolean {
  return entry.state === 'sending'
    || isOptimisticOutboxEntryId(entry.entryId)
    || cancellingEntryIds.has(entry.entryId);
}

export function planSendDispatch(
  sentAddress: DockAddress,
  mainSessionId: string,
  text: string,
): SendDispatchPlan {
  if (sentAddress.kind === 'new-branch') {
    return {
      kind: 'branch-spawn',
      parentId: mainSessionId,
      aboutBoxId: sentAddress.aboutBoxId,
      aboutTitle: sentAddress.aboutTitle,
      prompt: text,
    };
  }
  if (sentAddress.kind === 'branch') {
    return { kind: 'branch-send', sessionId: sentAddress.sessionId, text };
  }
  return {
    kind: 'main-send',
    sessionId: mainSessionId,
    text,
    shouldAskProgress: text.trim().length <= PROGRESS_QUESTION_MAX_CHARS,
  };
}

export function decideBranchSpawnReply(
  outcome: { ok: true; reply: { type: string; branchId?: string | null } } | { ok: false; error: { message: string } },
): { branchId: string | null; failureText: string } {
  if (!outcome.ok) return { branchId: null, failureText: outcome.error.message || NOT_SENT_TEXT };
  if (outcome.reply.type !== 'branch-spawn-result' || !outcome.reply.branchId) {
    return { branchId: null, failureText: NOT_SENT_TEXT };
  }
  return { branchId: outcome.reply.branchId, failureText: '' };
}

export function decideCancelReply(
  outcome:
    | { ok: true; reply: { type: string; cancelledTexts?: readonly string[] } }
    | { ok: false; error: { message: string } },
): { failureText: string | null; restoredText: string | null } {
  if (!outcome.ok) {
    return { failureText: `Could not cancel the message: ${outcome.error.message}`, restoredText: null };
  }
  if (outcome.reply.type !== 'chat-cancel-result' || !outcome.reply.cancelledTexts?.length) {
    return { failureText: null, restoredText: null };
  }
  return { failureText: null, restoredText: outcome.reply.cancelledTexts.join('\n\n') };
}
