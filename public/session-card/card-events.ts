import { openDocEditor } from '../doc-editor/doc-editor.ts';
import { setSelectedId } from '../review/selection.ts';
import { openTraceForSession } from '../trace-store.ts';
import { isRenameInProgress, makeTitleEditable, startInlineRename, startInlineTitleEdit } from './card-titles.ts';
import { closeDebugOverlay, openDebugOverlay } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';
import { requestSessionRemoval } from '../session-actions.ts';
import { openWorkspaceReposDialog } from './workspace-repos-dialog.ts';
import { popupMenu } from '../ui/popup-menu.ts';
import type { PopupMenu } from '../ui/popup-menu.ts';
import { loadResumeDialog } from './deferred-loads.ts';
import { SHELL_AGENT_ID } from './agent-core.ts';
import { sendSessionAction } from './card-actions.ts';
import { openConfirmDialog } from './modal.ts';
import { runRestartChoice } from './restart-menu-core.ts';
import restartAction from '../state/actions/restart.ts';
import { STATES } from '#shared/states.ts';

const sessionMenus = new WeakMap<SessionUi, PopupMenu>();

function closeSessionMenu(ui: SessionUi) {
  sessionMenus.get(ui)?.close();
}

function restartShell(ui: SessionUi, sessionId: string) {
  if (ui.currentState === STATES.DORMANT) {
    sendSessionAction(ui, { type: 'start-session', id: sessionId });
    return;
  }
  runRestartChoice('restart', sessionId, {
    readState: () => ui.currentState,
    send: (message) => {
      if (message.type === 'restart') {
        void restartAction({ id: message.id, fresh: message.fresh, conversationId: message.conversationId });
        return;
      }
      sendSessionAction(ui, message);
    },
    confirm: openConfirmDialog,
  });
}

function wireCardEvents(ui: SessionUi, sessionId: string) {
  makeTitleEditable(ui.taskTitleEl, () => startInlineTitleEdit(ui, sessionId));
  ui.nameEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.nameEl.addEventListener('click', () => {
    if (isRenameInProgress(ui.nameEl)) return;
    setSelectedId(sessionId);
  });

  ui.nameEl.addEventListener('keydown', (event) => {
    if (event.target !== ui.nameEl) return;
    if (event.key !== 'F2' && event.key !== 'Enter') return;
    event.preventDefault();
    startInlineRename(ui, sessionId);
  });

  ui.btnRestart.addEventListener('click', () => {
    closeSessionMenu(ui);
    if (ui.agent === SHELL_AGENT_ID) { restartShell(ui, sessionId); return; }
    void loadResumeDialog().then((resumeDialog) => resumeDialog?.openRestartDialog(sessionId, { readState: () => ui.currentState, canListEarlier: ui.card.dataset.ephemeral === undefined }));
  });

  ui.btnWorkspaceRepos.addEventListener('click', () => {
    closeSessionMenu(ui);
    openWorkspaceReposDialog(sessionId);
  });

  ui.btnTrace.addEventListener('click', () => {
    closeSessionMenu(ui);
    openTraceForSession(sessionId);
  });

  ui.btnDocs.addEventListener('click', () => {
    closeSessionMenu(ui);
    openDocEditor(sessionId);
  });

  ui.btnRemove.addEventListener('click', () => {
    closeSessionMenu(ui);
    requestSessionRemoval(sessionId);
  });

  ui.btnSessionMenu.addEventListener('click', (event) => event.stopPropagation(), { signal: ui.abortController.signal });

  sessionMenus.set(ui, popupMenu({
    trigger: ui.btnSessionMenu,
    menu: ui.sessionMenu,
    onOpen: () => {
      for (const [, other] of sessionUIs) {
        if (other !== ui) closeSessionMenu(other);
      }
    },
    signal: ui.abortController.signal,
  }));

  ui.btnDebug.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSessionMenu(ui);
    openDebugOverlay(ui, sessionId);
  });

  document.addEventListener('click', (e) => {
    const clicked = e.target instanceof Node ? e.target : null;
    if (ui.debugOpen && !ui.card.contains(clicked)) {
      closeDebugOverlay(ui);
    }
  }, { signal: ui.abortController.signal });
}

export { wireCardEvents };
