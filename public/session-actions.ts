import { DEFAULT_REPLY_TIMEOUT_MS, reportUnsourcedError, requestFailureText } from './action-status.ts';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import { addSessionRefusalText, openAddSessionDialogForFolderWithoutWorktree } from './dialogs.ts';
import type { SessionRow } from './focus-view/attention-core.ts';
import { buildSessionRows } from './focus-view/attention-core.ts';
import type { SessionOpenStatePolicy } from './session-actions-core.ts';
import { decideSessionOpenAction, pickRestorableSessionId } from './session-actions-core.ts';
import { sendSessionAction } from './session-card/card-dom.ts';
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
  reportUnsourcedError(NOT_CONNECTED_TEXT);
  return false;
}

async function requestQuickAdd(path: string, label: string | null | undefined) {
  try {
    const name = suggestSessionName(label);
    const reply = await sendControlRequest('add-session', { name, path }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (reply.type === 'add-session-result' && reply.ok) return;
    if (reply.type === 'add-session-result' && reply.reason === 'not-git') {
      openAddSessionDialogForFolderWithoutWorktree({ name, path });
      return;
    }
    reportUnsourcedError(addSessionRefusalText(reply));
  } catch (reason) {
    reportUnsourcedError(`The session was not added: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}`);
  }
}

export function quickAddSession(path: string | null | undefined, label: string | null | undefined) {
  if (!path) return;
  void requestQuickAdd(path, label);
}

const REMOTE_REMOVAL_TIMEOUT_MS = 65 * 60_000;

async function requestRemoteSessionRemoval(ui: SessionUi, id: string, discardRemoteWork: boolean) {
  try {
    const reply = await sendControlRequest('remove-session', { id, discardRemoteWork }, { timeoutMs: REMOTE_REMOVAL_TIMEOUT_MS });
    if (reply.type !== 'remove-session-result' || reply.ok) return;
    if (!reply.canDiscardRemoteWork) {
      reportUnsourcedError(`The session was not removed: ${reply.error ?? 'unknown error'}`);
      return;
    }
    openConfirmDialog({
      title: 'Remote work not saved',
      message: `${reply.error}. Removing "${sessionName(ui)}" deletes its Coder workspace and that work with it. Push it from the session first to keep it.`,
      confirmLabel: 'Discard remote work',
      danger: true,
      onConfirm: () => { void requestRemoteSessionRemoval(ui, id, true); },
    });
  } catch (reason) {
    reportUnsourcedError(`The session was not removed: ${requestFailureText(reason, REMOTE_REMOVAL_TIMEOUT_MS)}`);
  }
}

export function requestSessionRemoval(id: string, mergeStatus?: string) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  const currentMergeStatus = mergeStatus || ui.card?.dataset.merge || 'none';
  const hasUnmergedWork = currentMergeStatus === 'pending-review' || currentMergeStatus === 'parked';
  const isRemote = Boolean(ui.card?.dataset.remoteWorkspace);
  openConfirmDialog({
    title: 'Remove Session',
    message: hasUnmergedWork
      ? `"${sessionName(ui)}" has unmerged worktree changes that will be permanently discarded if you remove it. Merge or review them first to keep them. Remove anyway?`
      : `Remove session "${sessionName(ui)}"?`,
    confirmLabel: hasUnmergedWork ? 'Discard & Remove' : 'Remove',
    danger: true,
    onConfirm: () => {
      if (isRemote) {
        void requestRemoteSessionRemoval(ui, id, false);
        return;
      }
      sendSessionAction(ui, { type: 'remove-session', id });
    },
  });
}
