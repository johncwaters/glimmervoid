import type { MessageChannel, SeatId } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';

export type DiplomacyEntryKind = 'message' | 'note' | 'notice';

export interface SeatNote {
  tick: number;
  seatId: SeatId;
  text: string;
}

export interface DiplomacyEntry {
  key: string;
  tick: number;
  kind: DiplomacyEntryKind;
  from: SeatId;
  to: SeatId | null;
  channel: MessageChannel | null;
  text: string;
}

const KIND_ORDER_WITHIN_TURN: Readonly<Record<DiplomacyEntryKind, number>> = Object.freeze({
  note: 0,
  message: 1,
  notice: 2,
});

function isMessageVisible(pov: 'god' | SeatId, message: MatchState['messages'][number]): boolean {
  return pov === 'god' || message.from === pov || message.to === pov || message.channel === 'public';
}

export function diplomacyEntriesOf(state: MatchState, pov: 'god' | SeatId, notes: readonly SeatNote[]): DiplomacyEntry[] {
  const messageEntries = state.messages
    .filter((message) => isMessageVisible(pov, message))
    .map((message): DiplomacyEntry => ({
      key: message.id,
      tick: message.tick,
      kind: 'message',
      from: message.from,
      to: message.to,
      channel: message.channel,
      text: message.text,
    }));
  const noteEntries = notes.map((note, noteIndex): DiplomacyEntry => ({
    key: `note-${noteIndex}`,
    tick: note.tick,
    kind: 'note',
    from: note.seatId,
    to: null,
    channel: null,
    text: note.text,
  }));
  const noticeEntries = state.seatNotices.map((notice, noticeIndex): DiplomacyEntry => ({
    key: `notice-${noticeIndex}`,
    tick: notice.tick,
    kind: 'notice',
    from: notice.seatId,
    to: null,
    channel: null,
    text: notice.kind === 'offline' ? `Offline: ${notice.reason ?? 'no reason given'}` : 'Back online',
  }));
  const ordered = [...noteEntries, ...messageEntries, ...noticeEntries].map((entry, arrivalIndex) => ({ entry, arrivalIndex }));
  ordered.sort((left, right) => right.entry.tick - left.entry.tick
    || KIND_ORDER_WITHIN_TURN[right.entry.kind] - KIND_ORDER_WITHIN_TURN[left.entry.kind]
    || right.arrivalIndex - left.arrivalIndex);
  return ordered.map(({ entry }) => entry);
}

export type DiplomacyItem = { kind: 'entry'; entry: DiplomacyEntry } | { kind: 'thread'; key: string; entries: DiplomacyEntry[] };

function threadKeyOf(entry: DiplomacyEntry): string | null {
  if (entry.kind !== 'message' || entry.channel !== 'dm' || entry.to === null) return null;
  const pair = [entry.from, entry.to].sort().join('-');
  return `${entry.tick}:${pair}`;
}

export function diplomacyItemsOf(newestFirstEntries: readonly DiplomacyEntry[]): DiplomacyItem[] {
  const entriesByThreadKey = new Map<string, DiplomacyEntry[]>();
  for (const entry of newestFirstEntries) {
    const threadKey = threadKeyOf(entry);
    if (threadKey === null) continue;
    entriesByThreadKey.set(threadKey, [...(entriesByThreadKey.get(threadKey) ?? []), entry]);
  }
  const placedThreadKeys = new Set<string>();
  return newestFirstEntries.flatMap((entry): DiplomacyItem[] => {
    const threadKey = threadKeyOf(entry);
    const threadEntries = threadKey === null ? [] : entriesByThreadKey.get(threadKey) ?? [];
    if (threadKey === null || threadEntries.length < 2) return [{ kind: 'entry', entry }];
    if (placedThreadKeys.has(threadKey)) return [];
    placedThreadKeys.add(threadKey);
    return [{ kind: 'thread', key: threadKey, entries: [...threadEntries].reverse() }];
  });
}
