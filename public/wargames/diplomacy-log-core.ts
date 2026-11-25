import type { MessageChannel, SeatId } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';

export type DiplomacyEntryKind = 'message' | 'note';

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
  const ordered = [...noteEntries, ...messageEntries].map((entry, arrivalIndex) => ({ entry, arrivalIndex }));
  ordered.sort((left, right) => right.entry.tick - left.entry.tick
    || KIND_ORDER_WITHIN_TURN[right.entry.kind] - KIND_ORDER_WITHIN_TURN[left.entry.kind]
    || right.arrivalIndex - left.arrivalIndex);
  return ordered.map(({ entry }) => entry);
}
