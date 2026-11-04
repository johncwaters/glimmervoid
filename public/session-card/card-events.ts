import { openDocEditor } from '../doc-editor/doc-editor.ts';
import { createPlanHash } from '../plan/plan-link.ts';
import { setSelectedId } from '../review/selection.ts';
import { openTraceForSession } from '../trace-store.ts';
import { isRenameInProgress, makeTitleEditable, startInlineRename, startInlineTitleEdit } from './card-titles.ts';
import { closeDebugOverlay, openDebugOverlay } from './card-debug.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';
import { decidePlanHeaderAction } from './face-core.ts';
import { requestSessionRemoval } from '../session-actions.ts';
import { openWorkspaceReposDialog } from './workspace-repos-dialog.ts';
import { wirePopupMenuKeys } from '../menu.ts';
import { loadResumeDialog } from './deferred-loads.ts';
import { showSessionPlanFace } from './card-faces.ts';

function closeSessionMenu(ui: SessionUi) {
  ui.sessionMenu.classList.remove('open');
  ui.btnSessionMenu.setAttribute('aria-expanded', 'false');
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

  ui.btnRename.addEventListener('click', () => {
    closeSessionMenu(ui);
    startInlineRename(ui, sessionId, { returnsFocusToTerminal: !ui.renameTargetEl?.isConnected });
  });

  ui.btnRestart.addEventListener('click', () => {
    closeSessionMenu(ui);
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

  ui.btnPlan.addEventListener('click', () => {
    const action = decidePlanHeaderAction(ui);
    if (action === 'hidden') return;
    if (action === 'face') { showSessionPlanFace(sessionId); return; }
    location.hash = createPlanHash(sessionId);
  });

  ui.btnRemove.addEventListener('click', () => {
    closeSessionMenu(ui);
    requestSessionRemoval(sessionId);
  });

  function openSessionMenu() {
    for (const [, other] of sessionUIs) {
      if (other !== ui) closeSessionMenu(other);
    }
    ui.sessionMenu.classList.add('open');
    ui.btnSessionMenu.setAttribute('aria-expanded', 'true');
  }

  ui.btnSessionMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    if (ui.sessionMenu.classList.contains('open')) {
      closeSessionMenu(ui);
      return;
    }
    openSessionMenu();
  });

  wirePopupMenuKeys({
    trigger: ui.btnSessionMenu,
    menu: ui.sessionMenu,
    menuItems: () => [...ui.sessionMenu.querySelectorAll<HTMLElement>('.popup-menu-item.visible')].filter((item) => item.checkVisibility()),
    isOpen: () => ui.sessionMenu.classList.contains('open'),
    open: openSessionMenu,
    close: () => closeSessionMenu(ui),
    signal: ui.abortController.signal,
  });

  document.addEventListener('click', (event) => {
    const clicked = event.target instanceof Node ? event.target : null;
    if (!ui.sessionMenu.contains(clicked) && clicked !== ui.btnSessionMenu) closeSessionMenu(ui);
  }, { signal: ui.abortController.signal });

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
