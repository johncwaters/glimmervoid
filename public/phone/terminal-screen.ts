import { STATES } from '#shared/states.ts';
import { createActionStatus } from '../action-status.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { adoptElement, el, queryTag, releaseElement } from '../dom-helpers.ts';
import { isRenameInProgress, makeTitleEditable, paintTaskTitle, startInlineRename, startInlineTitleEdit } from '../session-card/card-dom.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { sendTerminalInput, setTerminalActiveViewer } from '../session-card/terminal.ts';
import { paintSessionRowStatus } from '../session-row.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { controlBytesForCharacter, createMobileKeyStrip } from './mobile-key-strip.ts';

const BACK_GLYPH = String.fromCharCode(0x2039);

export function createTerminalScreen({ onBack }: { onBack?: () => void }) {
  const screen = el('div', 'phone-terminal');

  const topBar = el('header', 'phone-topbar phone-terminal-bar');
  const backBtn = el('button', 'phone-back', BACK_GLYPH);
  backBtn.type = 'button';
  backBtn.setAttribute('aria-label', 'Back to board');
  backBtn.addEventListener('click', () => onBack?.());

  const identity = el('div', 'phone-terminal-identity');
  const nameEl = el('span', 'phone-terminal-name');
  nameEl.title = 'Double-tap to rename';
  nameEl.addEventListener('dblclick', () => renameShownSession());
  const taskTitleEl = el('span', 'session-task-title phone-terminal-title');
  makeTitleEditable(taskTitleEl, () => editShownTitle());
  const badgeEl = el('span', 'phone-terminal-badge');
  badgeEl.innerHTML = '<span class="phone-terminal-glyph" aria-hidden="true"></span>'
    + '<span class="phone-terminal-label"></span>'
    + '<span class="phone-terminal-elapsed" aria-hidden="true"></span>';
  const glyphEl = queryTag(badgeEl, '.phone-terminal-glyph', 'span');
  const labelEl = queryTag(badgeEl, '.phone-terminal-label', 'span');
  const elapsedEl = queryTag(badgeEl, '.phone-terminal-elapsed', 'span');
  labelEl.before(nameEl);
  identity.append(taskTitleEl, badgeEl);

  const actionSlot = el('div', 'phone-terminal-actions');

  topBar.append(backBtn, identity, actionSlot);

  const cardSlot = el('div', 'phone-card-slot');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title">No session selected</p>'
    + '<p class="phone-empty-desc">Select a session from the board to watch it here.</p>';

  const keyStatus = createActionStatus('phone-key-status m-0 px-3 py-1');
  const { element: keyStrip, takeHeldControl } = createMobileKeyStrip({
    send: sendToShownTerminal,
    getSessionId: () => shownId,
    reportProblem: (text) => keyStatus.show('error', text),
  });
  screen.append(topBar, cardSlot, emptyEl, keyStatus.element, keyStrip);

  let shownId: string | null = null;

  let adoptedActions: HTMLDivElement | null = null;
  let renameTargetUi: SessionUi | null = null;

  function sendToShownTerminal(data: string | null | undefined) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui) return;
    if (sendTerminalInput(ui, data)) { keyStatus.clear(); return; }
    keyStatus.show('error', NOT_CONNECTED_TEXT);
  }

  function focusShownTerminal() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui?.term) return;
    ui.term.focus();
  }

  cardSlot.addEventListener('click', focusShownTerminal);

  function sendHeldControlChord(typedCharacter: string) {
    const controlBytes = controlBytesForCharacter(typedCharacter);
    if (!controlBytes || !takeHeldControl()) return false;
    sendToShownTerminal(controlBytes);
    return true;
  }

  cardSlot.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!sendHeldControlChord(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  cardSlot.addEventListener('input', (event) => {
    if (!(event instanceof InputEvent) || !event.data) return;
    if (!sendHeldControlChord(event.data.slice(-1))) return;
    event.stopPropagation();
    const ui = shownId ? sessionUIs.get(shownId) : null;
    ui?._resetSoftKeyboardBuffer?.();
  }, true);

  function renameShownSession() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui || !shownId) return;
    startInlineRename(ui, shownId, { returnsFocusToTerminal: false });
  }

  function editShownTitle() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui || !shownId) return;
    startInlineTitleEdit(ui, shownId);
  }

  function paint() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    const hasSession = !!ui;
    emptyEl.hidden = hasSession;
    cardSlot.hidden = !hasSession;
    keyStrip.hidden = !hasSession;
    identity.hidden = !hasSession;
    if (!hasSession) {
      topBar.removeAttribute('data-state');
      topBar.removeAttribute('data-monitoring');
      topBar.removeAttribute('data-prompt');
      return;
    }
    const state = ui.currentState || STATES.DORMANT;
    paintSessionRowStatus(topBar, { glyph: glyphEl, label: labelEl }, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);

    const sessionName = ui.card?.dataset.session || shownId;
    if (!isRenameInProgress(nameEl)) nameEl.textContent = sessionName;
    taskTitleEl.dataset.sessionName = sessionName ?? '';
    paintTaskTitle(taskTitleEl, ui.taskTitle);
    elapsedEl.textContent = sessionElapsedText(ui);
  }

  function releaseBorrowedChrome() {
    if (renameTargetUi) {
      delete renameTargetUi.renameTargetEl;
      delete renameTargetUi.titleTargetEl;
      renameTargetUi = null;
    }

    nameEl.replaceChildren();
    if (!adoptedActions) return;
    releaseElement(adoptedActions);

    if (adoptedActions.parentElement === actionSlot) adoptedActions.remove();
    adoptedActions = null;
  }

  function show(sessionId: string) {
    const ui = sessionUIs.get(sessionId);
    if (!ui) return;
    const alreadyShown = shownId === sessionId
      && getBorrowedCardId() === sessionId
      && ui.card.parentElement === cardSlot;
    if (alreadyShown) {
      paint();
      return;
    }
    releaseBorrowedChrome();
    shownId = sessionId;
    borrowCard(ui, sessionId, cardSlot, { className: 'phone-centered' });
    adoptedActions = queryTag(ui.card, '.session-actions', 'div');
    adoptElement(adoptedActions, actionSlot);

    ui.renameTargetEl = nameEl;
    ui.titleTargetEl = taskTitleEl;
    renameTargetUi = ui;
    paint();
  }

  function clear() {
    releaseBorrowedChrome();
    if (getBorrowedCardId() === shownId) releaseCard();
    shownId = null;
    paint();
  }

  function refresh() {
    if (!shownId) {
      paint();
      return;
    }
    const ui = sessionUIs.get(shownId);
    if (!ui) {
      clear();
      return;
    }
    if (ui.card.parentElement !== cardSlot) {
      show(shownId);
      if (!screen.hidden) setTerminalActiveViewer(ui, shownId, true);
      return;
    }
    paint();
  }

  function unview() {
    const currentId = shownId;
    if (!currentId) return;
    setTerminalActiveViewer(sessionUIs.get(currentId), currentId, false);
  }

  function reveal() {
    refresh();
    const currentId = shownId;
    if (!currentId) return;
    const ui = sessionUIs.get(currentId);
    if (!ui) return;
    setTerminalActiveViewer(ui, currentId, true);
    markSessionSeen(currentId);
  }

  onSessionTick(() => {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (ui) elapsedEl.textContent = sessionElapsedText(ui);
  });

  paint();

  return {
    el: screen,
    show,
    clear,
    refresh,
    reveal,
    unview,
    getSessionId: () => shownId,
  };
}
