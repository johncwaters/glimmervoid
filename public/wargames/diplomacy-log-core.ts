import type { ContractRecord, MessageChannel, SeatId } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';

export type DiplomacyEntryKind = 'message' | 'note' | 'proposed' | 'accepted' | 'breached' | 'expired';

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
  contractKind: ContractRecord['terms']['kind'] | null;
  text: string;
}

const KIND_ORDER_WITHIN_TURN: Readonly<Record<DiplomacyEntryKind, number>> = Object.freeze({
  note: 0,
  message: 1,
  proposed: 2,
  accepted: 3,
  expired: 4,
  breached: 5,
});

function isMessageVisible(pov: 'god' | SeatId, message: MatchState['messages'][number]): boolean {
  return pov === 'god' || message.from === pov || message.to === pov || message.channel === 'public';
}

function contractEntriesOf(contract: ContractRecord): DiplomacyEntry[] {
  const shared = { from: contract.proposer, to: contract.counterparty, channel: null, contractKind: contract.terms.kind, text: '' };
  const entries: DiplomacyEntry[] = [{ ...shared, key: `${contract.id}-proposed`, tick: contract.proposedTick, kind: 'proposed' }];
  if (contract.activatedTick !== null) {
    entries.push({ ...shared, key: `${contract.id}-accepted`, tick: contract.activatedTick, kind: 'accepted', from: contract.counterparty, to: contract.proposer });
  }
  if (contract.breachedTick !== null && contract.breachedBy !== null) {
    const wronged = contract.breachedBy === contract.proposer ? contract.counterparty : contract.proposer;
    entries.push({ ...shared, key: `${contract.id}-breached`, tick: contract.breachedTick, kind: 'breached', from: contract.breachedBy, to: wronged });
  }
  if (contract.status === 'expired' && contract.endTick !== null) {
    entries.push({ ...shared, key: `${contract.id}-expired`, tick: contract.endTick, kind: 'expired' });
  }
  return entries;
}

function isContractVisible(pov: 'god' | SeatId, contract: ContractRecord): boolean {
  return pov === 'god' || contract.proposer === pov || contract.counterparty === pov;
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
      contractKind: null,
      text: message.text,
    }));
  const contractEntries = [...state.contracts.values()]
    .filter((contract) => isContractVisible(pov, contract))
    .flatMap(contractEntriesOf);
  const noteEntries = notes.map((note, noteIndex): DiplomacyEntry => ({
    key: `note-${noteIndex}`,
    tick: note.tick,
    kind: 'note',
    from: note.seatId,
    to: null,
    channel: null,
    contractKind: null,
    text: note.text,
  }));
  const ordered = [...noteEntries, ...messageEntries, ...contractEntries].map((entry, arrivalIndex) => ({ entry, arrivalIndex }));
  ordered.sort((left, right) => right.entry.tick - left.entry.tick
    || KIND_ORDER_WITHIN_TURN[right.entry.kind] - KIND_ORDER_WITHIN_TURN[left.entry.kind]
    || right.arrivalIndex - left.arrivalIndex);
  return ordered.map(({ entry }) => entry);
}
