import { clearHeaderError, DEFAULT_REPLY_TIMEOUT_MS, reportHeaderError, requestFailureText } from './action-status.ts';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import type { SessionRow } from './focus-view/attention-core.ts';
import { buildSessionRows } from './focus-view/attention-core.ts';
import type { SessionOpenStatePolicy } from './session-actions-core.ts';
import { decideSessionOpenAction, pickRestorableSessionId } from './session-actions-core.ts';
import { sendSessionAction } from './session-card/card-dom.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { SHELL_AGENT_ID } from './session-card/agent-core.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { sessionName, sessionUIs } from './session-card/card-registry.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { suggestSessionName } from './session-card/naming.ts';
import { setSelectedId } from './sidebar/selection.ts';
import { getLastFocusedSessionId, setLastFocusedSessionId } from './ui-prefs.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';

export function requestSessionOpen(id: string, statePolicy: SessionOpenStatePolicy = 'explicit-state') {
  const ui = sessionUIs.get(id);
  if (!ui) return null;
  const action = decideSessionOpenAction(ui.currentState, statePolicy);
  if (action) sendSessionAction(ui, { type: action, id });
  return ui;
}

export function selectSession(id: string, { rememberFocus = true }: { rememberFocus?: boolean } = {}) {
  setSelectedId(id);
  if (rememberFocus) setLastFocusedSessionId(id);
}

export function getRestorableSessionId() {
  return pickRestorableSessionId(getLastFocusedSessionId(), sessionUIs);
}

export function readSessionRows(): SessionRow<SessionUi>[];
export function readSessionRows<Name extends string | null>(nameOf: (ui: SessionUi) => Name): SessionRow<SessionUi, Name>[];
export function readSessionRows(nameOf: (ui: SessionUi) => string | null = sessionName) {
  const operatorSessions = [...sessionUIs];
  return buildSessionRows(operatorSessions, nameOf);
}

export function sendForSession(id: string, message: Record<string, unknown>): boolean {
  const ui = sessionUIs.get(id);
  if (ui) return sendSessionAction(ui, message);
  if (sendControlMsg(message)) return true;
  reportHeaderError({ source: 'Session action', sessionId: id, message: `${NOT_CONNECTED_TEXT} Try the action again once the header shows Connected.` });
  return false;
}

const ADD_SESSION_ERROR_SOURCE = 'Add session';

export function addSessionRefusalText(reply: ServerMessage): string {
  if (reply.type === 'add-session-result' && reply.error) return reply.error;
  if (reply.type === 'error') return reply.message;
  return 'The session was not added.';
}

type DialogsModule = typeof import('./dialogs.ts');

let isDialogOpening = false;

function openWithDialogs(openDialog: (dialogs: DialogsModule) => void) {
  if (isDialogOpening) return;
  isDialogOpening = true;
  import('./dialogs.ts').then((dialogs) => {
    isDialogOpening = false;
    openDialog(dialogs);
  }, () => {
    isDialogOpening = false;
    reportHeaderError({ source: ADD_SESSION_ERROR_SOURCE, message: 'The Add session dialog did not load. Reload the page, then add the session again.' });
  });
}

export function openAddSessionDialog() {
  openWithDialogs((dialogs) => dialogs.createAddSessionDialog());
}

export function openShellSessionDialog() {
  openWithDialogs((dialogs) => dialogs.createAddSessionDialog({ preferredAgentId: SHELL_AGENT_ID }));
}

let revealSessionInView: (id: string) => void = selectSession;

export function setAddedSessionRevealer(reveal: (id: string) => void) {
  revealSessionInView = reveal;
}

export function revealAddedSession(sessionId: string | null | undefined) {
  clearHeaderError(ADD_SESSION_ERROR_SOURCE);
  if (sessionId) revealSessionInView(sessionId);
}

async function requestQuickAdd(path: string, label: string | null | undefined) {
  try {
    const name = suggestSessionName(label);
    const reply = await sendControlRequest('add-session', { name, path }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (reply.type === 'add-session-result' && reply.ok) {
      revealAddedSession(reply.sessionId);
      return;
    }
    reportHeaderError({ source: ADD_SESSION_ERROR_SOURCE, message: addSessionRefusalText(reply) });
  } catch (reason) {
    reportHeaderError({ source: ADD_SESSION_ERROR_SOURCE, message: `The session was not added: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)} Add it again once the server answers.` });
  }
}

export function quickAddSession(path: string | null | undefined, label: string | null | undefined) {
  if (!path) return;
  void requestQuickAdd(path, label);
}

async function requestQuickSession(sourceId: string) {
  try {
    const reply = await sendControlRequest('quick-session', { id: sourceId }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (reply.type === 'add-session-result' && reply.ok) {
      revealAddedSession(reply.sessionId);
      return;
    }
    reportHeaderError({ source: ADD_SESSION_ERROR_SOURCE, sessionId: sourceId, message: addSessionRefusalText(reply) });
  } catch (reason) {
    reportHeaderError({ source: ADD_SESSION_ERROR_SOURCE, sessionId: sourceId, message: `The session was not added: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)} Add it again once the server answers.` });
  }
}

export function spawnQuickSession(sourceId: string) {
  void requestQuickSession(sourceId);
}

const SESSION_REMOVAL_TIMEOUT_MS = 65 * 60_000;
const REMOVE_SESSION_ERROR_SOURCE = 'Remove session';

async function requestCheckedSessionRemoval(ui: SessionUi, id: string, discardWork: boolean, confirmedKeptPaths: string[] = []) {
  try {
    const reply = await sendControlRequest('remove-session', { id, discardWork, confirmedKeptPaths }, { timeoutMs: SESSION_REMOVAL_TIMEOUT_MS });
    if (reply.type !== 'remove-session-result' || reply.ok) return;
    if (!reply.canDiscardWork) {
      reportHeaderError({ source: REMOVE_SESSION_ERROR_SOURCE, sessionId: id, message: `"${sessionName(ui)}" was not removed: ${reply.error ?? 'the server gave no reason'}. Try Remove again from its actions menu.` });
      return;
    }
    openConfirmDialog({
      title: 'Remove Session',
      message: reply.error ?? `Remove session "${sessionName(ui)}"?`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => { void requestCheckedSessionRemoval(ui, id, true, (reply.keptPaths ?? []).map((kept) => kept.path)); },
    });
  } catch (reason) {
    reportHeaderError({ source: REMOVE_SESSION_ERROR_SOURCE, sessionId: id, message: `"${sessionName(ui)}" was not removed: ${requestFailureText(reason, SESSION_REMOVAL_TIMEOUT_MS)} Try Remove again from its actions menu.` });
  }
}

export function requestSessionRemoval(id: string) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  void requestCheckedSessionRemoval(ui, id, false);
}
