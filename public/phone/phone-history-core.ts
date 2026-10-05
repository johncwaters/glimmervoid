export type PushedPhoneHistoryEntry = 'none' | 'screen' | 'calm-sheet';

export type PhonePopStateDecision = 'own-sheet-pop' | 'close-sheet' | 'adopt-sheet-entry' | 'consume-stray-sheet-entry' | 'navigate';

export type CalmSheetOpenedDecision = 'push-sheet-entry' | 'defer-until-own-pop' | 'keep-history';

const CALM_SHEET_STATE_KEY = 'glimmervoidCalmSheet';

export const CALM_SHEET_HISTORY_STATE = Object.freeze({ [CALM_SHEET_STATE_KEY]: true });

export function isCalmSheetHistoryState(state: unknown) {
  if (typeof state !== 'object' || state === null) return false;
  return CALM_SHEET_STATE_KEY in state;
}

export function decidePhonePopState({ poppedState, isCalmSheetOpen, isOwnSheetPopPending }: {
  poppedState: unknown;
  isCalmSheetOpen: boolean;
  isOwnSheetPopPending: boolean;
}): PhonePopStateDecision {
  if (isOwnSheetPopPending) return 'own-sheet-pop';
  const isSheetEntry = isCalmSheetHistoryState(poppedState);
  if (isSheetEntry && isCalmSheetOpen) return 'adopt-sheet-entry';
  if (isSheetEntry) return 'consume-stray-sheet-entry';
  if (isCalmSheetOpen) return 'close-sheet';
  return 'navigate';
}

export function decideCalmSheetOpened({ pushedEntry, isOwnSheetPopPending }: {
  pushedEntry: PushedPhoneHistoryEntry;
  isOwnSheetPopPending: boolean;
}): CalmSheetOpenedDecision {
  if (pushedEntry !== 'none') return 'keep-history';
  if (isOwnSheetPopPending) return 'defer-until-own-pop';
  return 'push-sheet-entry';
}

export function shouldConsumeCalmSheetEntry({ pushedEntry, topState, isOwnSheetPopPending }: {
  pushedEntry: PushedPhoneHistoryEntry;
  topState: unknown;
  isOwnSheetPopPending: boolean;
}) {
  if (isOwnSheetPopPending) return false;
  return pushedEntry === 'calm-sheet' && isCalmSheetHistoryState(topState);
}
