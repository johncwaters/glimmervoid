import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALM_SHEET_HISTORY_STATE,
  decideCalmSheetOpened,
  decidePhonePopState,
  isCalmSheetHistoryState,
  shouldConsumeCalmSheetEntry,
} from '../public/phone/phone-history-core.ts';

const screenState = { glimmervoidScreen: 'terminal' };

test('isCalmSheetHistoryState: recognizes only the calm sheet marker', () => {
  assert.equal(isCalmSheetHistoryState(CALM_SHEET_HISTORY_STATE), true);
  assert.equal(isCalmSheetHistoryState(structuredClone(CALM_SHEET_HISTORY_STATE)), true);
  assert.equal(isCalmSheetHistoryState(screenState), false);
  assert.equal(isCalmSheetHistoryState(null), false);
  assert.equal(isCalmSheetHistoryState(undefined), false);
  assert.equal(isCalmSheetHistoryState('glimmervoidCalmSheet'), false);
});

test('decidePhonePopState: back while the sheet is open closes the sheet instead of navigating', () => {
  assert.equal(decidePhonePopState({ poppedState: null, isCalmSheetOpen: true, isOwnSheetPopPending: false }), 'close-sheet');
});

test('decidePhonePopState: back with no sheet open navigates as before', () => {
  assert.equal(decidePhonePopState({ poppedState: null, isCalmSheetOpen: false, isOwnSheetPopPending: false }), 'navigate');
  assert.equal(decidePhonePopState({ poppedState: screenState, isCalmSheetOpen: false, isOwnSheetPopPending: false }), 'navigate');
});

test('decidePhonePopState: the echo of the shell consuming its own sheet entry never closes or navigates', () => {
  assert.equal(decidePhonePopState({ poppedState: null, isCalmSheetOpen: false, isOwnSheetPopPending: true }), 'own-sheet-pop');
  assert.equal(decidePhonePopState({ poppedState: null, isCalmSheetOpen: true, isOwnSheetPopPending: true }), 'own-sheet-pop');
});

test('decidePhonePopState: forward onto a sheet entry with no sheet open consumes the stray entry', () => {
  assert.equal(decidePhonePopState({ poppedState: CALM_SHEET_HISTORY_STATE, isCalmSheetOpen: false, isOwnSheetPopPending: false }), 'consume-stray-sheet-entry');
});

test('decidePhonePopState: landing on a sheet entry while the sheet is open adopts it', () => {
  assert.equal(decidePhonePopState({ poppedState: CALM_SHEET_HISTORY_STATE, isCalmSheetOpen: true, isOwnSheetPopPending: false }), 'adopt-sheet-entry');
});

test('decideCalmSheetOpened: pushes one entry only when the shell holds none', () => {
  assert.equal(decideCalmSheetOpened({ pushedEntry: 'none', isOwnSheetPopPending: false }), 'push-sheet-entry');
  assert.equal(decideCalmSheetOpened({ pushedEntry: 'calm-sheet', isOwnSheetPopPending: false }), 'keep-history');
  assert.equal(decideCalmSheetOpened({ pushedEntry: 'screen', isOwnSheetPopPending: false }), 'keep-history');
});

test('decideCalmSheetOpened: a reopen during a pending own pop waits for that pop to land', () => {
  assert.equal(decideCalmSheetOpened({ pushedEntry: 'none', isOwnSheetPopPending: true }), 'defer-until-own-pop');
});

test('shouldConsumeCalmSheetEntry: consumes only a sheet entry still on top', () => {
  assert.equal(shouldConsumeCalmSheetEntry({ pushedEntry: 'calm-sheet', topState: CALM_SHEET_HISTORY_STATE, isOwnSheetPopPending: false }), true);
  assert.equal(shouldConsumeCalmSheetEntry({ pushedEntry: 'screen', topState: screenState, isOwnSheetPopPending: false }), false);
  assert.equal(shouldConsumeCalmSheetEntry({ pushedEntry: 'calm-sheet', topState: screenState, isOwnSheetPopPending: false }), false);
  assert.equal(shouldConsumeCalmSheetEntry({ pushedEntry: 'none', topState: null, isOwnSheetPopPending: false }), false);
});

test('shouldConsumeCalmSheetEntry: never pops twice while an own pop is in flight', () => {
  assert.equal(shouldConsumeCalmSheetEntry({ pushedEntry: 'calm-sheet', topState: CALM_SHEET_HISTORY_STATE, isOwnSheetPopPending: true }), false);
});
