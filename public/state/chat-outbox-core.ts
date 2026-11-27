import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import type { ChatPart } from '../chat/chat-part.ts';
import type { CollectionHelpers } from './define-collection.ts';

export const OPTIMISTIC_OUTBOX_ENTRY_PREFIX = 'optimistic-chat-';

const SENT_OUTBOX_STATES: ReadonlySet<ChatOutboxEntry['state']> = new Set(['sending', 'submitted']);

export interface ChatOutboxCollectionState {
  bySessionId: Record<string, ChatOutboxEntry[]>;
}

export const INITIAL_CHAT_OUTBOX_STATE: ChatOutboxCollectionState = {
  bySessionId: {},
};

interface OptimisticChatSendInput {
  sessionId: string;
  optimisticEntryId: string;
  text: string;
  attachments: readonly string[];
  isTurnRunning: boolean;
  knownServerEntryIds: ReadonlySet<string>;
  priorInFlightMatchCount: number;
}

interface ChatOutboxProjection {
  standInByEntryId: Map<string, ChatPart>;
  entryIdsTakenByPrompt: Set<string>;
  isSentOutsideTurnByEntryId: Map<string, boolean>;
  entryIdsAwaitingTurn: Set<string>;
}

interface ChatOutboxProjectionUpdate {
  addedStandIns: ChatPart[];
  removedStandInEntryIds: string[];
  queuedEntries: ChatOutboxEntry[];
  clearedStandInEntryIds: string[];
}

function cloneOutboxEntry(entry: ChatOutboxEntry): ChatOutboxEntry {
  return {
    ...entry,
    attachments: [...entry.attachments],
  };
}

function sameAttachmentList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function isOptimisticOutboxEntryId(entryId: string): boolean {
  return entryId.startsWith(OPTIMISTIC_OUTBOX_ENTRY_PREFIX);
}

export function applyChatOutboxServerMessage(
  draft: ChatOutboxCollectionState,
  message: ServerMessage,
  helpers: CollectionHelpers<ChatOutboxCollectionState>,
): void {
  if (message.type === 'snapshot') {
    const nextBySessionId: Record<string, ChatOutboxEntry[]> = {};
    for (const row of message.sessions) {
      if (!row.chatOutbox || row.chatOutbox.length === 0) continue;
      nextBySessionId[row.id] = row.chatOutbox.map(cloneOutboxEntry);
    }
    helpers.replace({ bySessionId: nextBySessionId });
    return;
  }
  if (message.type === 'session-status') {
    if (message.chatOutbox === undefined) return;
    if (message.chatOutbox.length === 0) {
      delete draft.bySessionId[message.id];
      return;
    }
    draft.bySessionId[message.id] = message.chatOutbox.map(cloneOutboxEntry);
    return;
  }
  if (message.type === 'session-removed') {
    delete draft.bySessionId[message.id];
  }
}

export function applyOptimisticChatSend(
  draft: ChatOutboxCollectionState,
  input: OptimisticChatSendInput,
): void {
  const existing = draft.bySessionId[input.sessionId] ?? [];
  const normalizedText = input.text.trim();
  const newServerMatchCount = existing.filter((entry) => (
    !isOptimisticOutboxEntryId(entry.entryId)
    && !input.knownServerEntryIds.has(entry.entryId)
    && entry.origin === 'operator'
    && entry.text === normalizedText
    && sameAttachmentList(entry.attachments, input.attachments)
  )).length;
  if (newServerMatchCount > input.priorInFlightMatchCount) return;
  const optimisticEntry: ChatOutboxEntry = {
    entryId: input.optimisticEntryId,
    text: normalizedText,
    attachments: [...input.attachments],
    state: input.isTurnRunning || existing.length > 0 ? 'held' : 'sending',
    failure: null,
    shouldOpenTerminal: false,
    origin: 'operator',
  };
  draft.bySessionId[input.sessionId] = [...existing, optimisticEntry];
}

export function applyOptimisticChatCancel(
  draft: ChatOutboxCollectionState,
  sessionId: string,
  entryId: string,
): void {
  const existing = draft.bySessionId[sessionId];
  if (!existing || existing.length === 0) return;
  const entryIndex = existing.findIndex((entry) => entry.entryId === entryId);
  if (entryIndex === -1) return;
  const target = existing[entryIndex];
  if (!target || target.state === 'sending' || target.state === 'submitted') return;
  const nextEntries = target.state === 'failed'
    ? existing.slice(0, entryIndex)
    : existing.filter((entry) => entry.entryId !== entryId);
  if (nextEntries.length === 0) {
    delete draft.bySessionId[sessionId];
    return;
  }
  draft.bySessionId[sessionId] = nextEntries;
}

export function createChatOutboxProjection(): ChatOutboxProjection {
  return {
    standInByEntryId: new Map(),
    entryIdsTakenByPrompt: new Set(),
    isSentOutsideTurnByEntryId: new Map(),
    entryIdsAwaitingTurn: new Set(),
  };
}

function isOutboxStalled(entries: readonly ChatOutboxEntry[]): boolean {
  return entries.some((entry) => entry.state === 'failed');
}

function isShownAsSent(projection: ChatOutboxProjection, entry: ChatOutboxEntry, isStalled: boolean): boolean {
  if (SENT_OUTBOX_STATES.has(entry.state)) return true;
  return (entry.state === 'held' || entry.state === 'next')
    && projection.isSentOutsideTurnByEntryId.get(entry.entryId) === true
    && !isStalled;
}

function adoptOptimisticStandIns(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
  activeEntryIds: ReadonlySet<string>,
): void {
  const orphanedOptimisticIds = [...projection.standInByEntryId.keys()]
    .filter((entryId) => isOptimisticOutboxEntryId(entryId) && !activeEntryIds.has(entryId));
  if (orphanedOptimisticIds.length === 0) return;

  for (const optimisticId of orphanedOptimisticIds) {
    const standIn = projection.standInByEntryId.get(optimisticId);
    if (!standIn || standIn.kind !== 'prompt') continue;
    const matchingServerEntry = entries.find((entry) => (
      !isOptimisticOutboxEntryId(entry.entryId)
      && !projection.isSentOutsideTurnByEntryId.has(entry.entryId)
      && !projection.standInByEntryId.has(entry.entryId)
      && !projection.entryIdsTakenByPrompt.has(entry.entryId)
      && entry.origin === 'operator'
      && entry.text === standIn.text
      && sameAttachmentList(entry.attachments, standIn.attachments)
    ));
    if (!matchingServerEntry) continue;
    projection.standInByEntryId.delete(optimisticId);
    projection.standInByEntryId.set(matchingServerEntry.entryId, standIn);
    const wasSentOutsideTurn = projection.isSentOutsideTurnByEntryId.get(optimisticId);
    if (wasSentOutsideTurn !== undefined) {
      projection.isSentOutsideTurnByEntryId.delete(optimisticId);
      projection.isSentOutsideTurnByEntryId.set(matchingServerEntry.entryId, wasSentOutsideTurn);
    }
    if (projection.entryIdsAwaitingTurn.delete(optimisticId)) {
      projection.entryIdsAwaitingTurn.add(matchingServerEntry.entryId);
    }
  }
}

function noteOutboxEntries(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
  isTurnRunning: boolean,
): void {
  const activeEntryIds = new Set(entries.map((entry) => entry.entryId));
  adoptOptimisticStandIns(projection, entries, activeEntryIds);
  for (const entryId of projection.isSentOutsideTurnByEntryId.keys()) {
    if (activeEntryIds.has(entryId)) continue;
    projection.isSentOutsideTurnByEntryId.delete(entryId);
    projection.entryIdsAwaitingTurn.delete(entryId);
  }
  for (const entry of entries) {
    if (projection.isSentOutsideTurnByEntryId.has(entry.entryId)) continue;
    projection.isSentOutsideTurnByEntryId.set(entry.entryId, !isTurnRunning);
    if (!isTurnRunning) projection.entryIdsAwaitingTurn.add(entry.entryId);
  }
}

export function reconcileChatOutboxProjection(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
  isTurnRunning: boolean,
  nowMs: number,
): ChatOutboxProjectionUpdate {
  noteOutboxEntries(projection, entries, isTurnRunning);
  const isStalled = isOutboxStalled(entries);
  const sentEntries = entries.filter((entry) => isShownAsSent(projection, entry, isStalled));
  const sentEntryIds = new Set(sentEntries.map((entry) => entry.entryId));
  for (const entryId of projection.entryIdsTakenByPrompt) {
    if (!sentEntryIds.has(entryId)) projection.entryIdsTakenByPrompt.delete(entryId);
  }
  const addedStandIns: ChatPart[] = [];
  for (const entry of sentEntries) {
    if (projection.standInByEntryId.has(entry.entryId) || projection.entryIdsTakenByPrompt.has(entry.entryId)) continue;
    const standIn: ChatPart = {
      kind: 'prompt',
      id: `sent-${entry.entryId}`,
      text: entry.text,
      at: nowMs,
      attachments: [...entry.attachments],
      isBoardAnswer: false,
    };
    projection.standInByEntryId.set(entry.entryId, standIn);
    addedStandIns.push(standIn);
  }
  const queuedEntries = entries.filter((entry) => !sentEntryIds.has(entry.entryId));
  const activeEntryIds = new Set(entries.map((entry) => entry.entryId));
  const removedStandInEntryIds = queuedEntries
    .map((entry) => entry.entryId)
    .filter((entryId) => projection.standInByEntryId.has(entryId));
  const clearedStandInEntryIds: string[] = [];
  for (const entryId of projection.standInByEntryId.keys()) {
    if (activeEntryIds.has(entryId)) continue;
    if (isOptimisticOutboxEntryId(entryId)) {
      removedStandInEntryIds.push(entryId);
      continue;
    }
    clearedStandInEntryIds.push(entryId);
  }
  return { addedStandIns, removedStandInEntryIds, queuedEntries, clearedStandInEntryIds };
}

export function takeStandInsForPrompts(projection: ChatOutboxProjection, newPromptCount: number): string[] {
  const takenEntryIds = [...projection.standInByEntryId.keys()].slice(0, newPromptCount);
  for (const entryId of takenEntryIds) projection.entryIdsTakenByPrompt.add(entryId);
  return takenEntryIds;
}

export function isChatOutboxAwaitingTurn(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
  isTurnRunning: boolean,
): boolean {
  if (isTurnRunning) projection.entryIdsAwaitingTurn.clear();
  if (isOutboxStalled(entries)) return false;
  return entries.some((entry) => (
    (entry.state === 'held' || entry.state === 'next' || entry.state === 'sending')
    && projection.entryIdsAwaitingTurn.has(entry.entryId)
  ));
}

export function queuedChatOutboxEntriesOf(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
): ChatOutboxEntry[] {
  const isStalled = isOutboxStalled(entries);
  return entries.filter((entry) => !isShownAsSent(projection, entry, isStalled));
}

export function newestCancellableChatOutboxEntryOf(
  projection: ChatOutboxProjection,
  entries: readonly ChatOutboxEntry[],
): ChatOutboxEntry | undefined {
  const isStalled = isOutboxStalled(entries);
  return entries.findLast((entry) => (
    !isOptimisticOutboxEntryId(entry.entryId)
    && (entry.state === 'held' || entry.state === 'next' || entry.state === 'failed')
    && !isShownAsSent(projection, entry, isStalled)
  ));
}
