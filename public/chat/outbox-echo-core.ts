import type { ChatOutboxEntry } from '#shared/contracts/session.ts';
import type { ChatPart } from './chat-part.ts';

const SENT_OUTBOX_STATES: ReadonlySet<ChatOutboxEntry['state']> = new Set(['sending', 'submitted']);

interface OutboxEchoState {
  standInByEntryId: Map<string, ChatPart>;
  entryIdsTakenByPrompt: Set<string>;
  isSentOutsideTurnByEntryId: Map<string, boolean>;
  entryIdsAwaitingTurn: Set<string>;
}

interface OutboxEchoUpdate {
  addedStandIns: ChatPart[];
  removedStandInEntryIds: string[];
  queuedEntries: ChatOutboxEntry[];
  clearedStandInEntryIds: string[];
}

export function createOutboxEchoState(): OutboxEchoState {
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

function isShownAsSent(state: OutboxEchoState, entry: ChatOutboxEntry, isStalled: boolean): boolean {
  if (SENT_OUTBOX_STATES.has(entry.state)) return true;
  return (entry.state === 'held' || entry.state === 'next') && state.isSentOutsideTurnByEntryId.get(entry.entryId) === true && !isStalled;
}

function noteOutboxEntries(state: OutboxEchoState, entries: readonly ChatOutboxEntry[], isTurnRunning: boolean): void {
  const activeEntryIds = new Set(entries.map((entry) => entry.entryId));
  for (const entryId of state.isSentOutsideTurnByEntryId.keys()) {
    if (activeEntryIds.has(entryId)) continue;
    state.isSentOutsideTurnByEntryId.delete(entryId);
    state.entryIdsAwaitingTurn.delete(entryId);
  }
  for (const entry of entries) {
    if (state.isSentOutsideTurnByEntryId.has(entry.entryId)) continue;
    state.isSentOutsideTurnByEntryId.set(entry.entryId, !isTurnRunning);
    if (!isTurnRunning) state.entryIdsAwaitingTurn.add(entry.entryId);
  }
}

export function reconcileOutboxEcho(state: OutboxEchoState, entries: readonly ChatOutboxEntry[], isTurnRunning: boolean, nowMs: number): OutboxEchoUpdate {
  noteOutboxEntries(state, entries, isTurnRunning);
  const isStalled = isOutboxStalled(entries);
  const sentEntries = entries.filter((entry) => isShownAsSent(state, entry, isStalled));
  const sentEntryIds = new Set(sentEntries.map((entry) => entry.entryId));
  for (const entryId of state.entryIdsTakenByPrompt) {
    if (!sentEntryIds.has(entryId)) state.entryIdsTakenByPrompt.delete(entryId);
  }
  const addedStandIns: ChatPart[] = [];
  for (const entry of sentEntries) {
    if (state.standInByEntryId.has(entry.entryId) || state.entryIdsTakenByPrompt.has(entry.entryId)) continue;
    const standIn: ChatPart = { kind: 'prompt', id: `sent-${entry.entryId}`, text: entry.text, at: nowMs, attachments: [...entry.attachments], isBoardAnswer: false };
    state.standInByEntryId.set(entry.entryId, standIn);
    addedStandIns.push(standIn);
  }
  const queuedEntries = entries.filter((entry) => !sentEntryIds.has(entry.entryId));
  const removedStandInEntryIds = queuedEntries.map((entry) => entry.entryId).filter((entryId) => state.standInByEntryId.has(entryId));
  const activeEntryIds = new Set(entries.map((entry) => entry.entryId));
  const clearedStandInEntryIds = [...state.standInByEntryId.keys()].filter((entryId) => !activeEntryIds.has(entryId));
  return { addedStandIns, removedStandInEntryIds, queuedEntries, clearedStandInEntryIds };
}

export function takeStandInsForPrompts(state: OutboxEchoState, newPromptCount: number): string[] {
  const takenEntryIds = [...state.standInByEntryId.keys()].slice(0, newPromptCount);
  for (const entryId of takenEntryIds) state.entryIdsTakenByPrompt.add(entryId);
  return takenEntryIds;
}

export function isOutboxAwaitingTurn(state: OutboxEchoState, entries: readonly ChatOutboxEntry[], isTurnRunning: boolean): boolean {
  if (isTurnRunning) state.entryIdsAwaitingTurn.clear();
  if (isOutboxStalled(entries)) return false;
  return entries.some((entry) => (entry.state === 'held' || entry.state === 'next' || entry.state === 'sending') && state.entryIdsAwaitingTurn.has(entry.entryId));
}

export function queuedOutboxEntriesOf(state: OutboxEchoState, entries: readonly ChatOutboxEntry[]): ChatOutboxEntry[] {
  const isStalled = isOutboxStalled(entries);
  return entries.filter((entry) => !isShownAsSent(state, entry, isStalled));
}

export function newestCancellableOutboxEntryOf(state: OutboxEchoState, entries: readonly ChatOutboxEntry[]): ChatOutboxEntry | undefined {
  const isStalled = isOutboxStalled(entries);
  return entries.findLast((entry) => (entry.state === 'held' || entry.state === 'next' || entry.state === 'failed') && !isShownAsSent(state, entry, isStalled));
}
