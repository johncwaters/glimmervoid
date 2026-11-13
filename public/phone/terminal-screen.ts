import { STATES } from '#shared/states.ts';
import { createActionStatus } from '../action-status.ts';
import { borrowCard, getBorrowedCardId, releaseCard } from '../card-host.ts';
import { adoptElement, el, queryTag, releaseElement } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { isRenameInProgress, makeTitleEditable, paintTaskTitle, startInlineRename, startInlineTitleEdit } from '../session-card/card-titles.ts';
import type { SessionUi } from '../session-card/card-registry.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { openSelectSheet } from '../session-card/select-sheet.ts';
import { copyLastOutput, copyScreen } from '../session-card/touch-select.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { markSessionSeen } from '../session-card/lifecycle.ts';
import { onSessionTick, sessionElapsedText } from '../session-card/session-tick.ts';
import { setTerminalActiveViewer } from '../session-card/terminal.ts';
import { sendTerminalInput } from '../session-card/terminal-input.ts';
import { paintSessionRowStatus } from '../session-row.ts';
import { createSessionPageButtons } from '../session-pages/session-pages.ts';
import { BACK_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { decideIsRawTyping, decideStripContext, isTextForCompose } from '../mobile-keys.ts';
import type { TerminalTextAction } from '../mobile-keys.ts';
import { createComposeBar } from '../touch/compose-bar.ts';
import { createMobileKeyStrip } from './mobile-key-strip.ts';

export function createTerminalScreen({ onBack }: { onBack?: () => void }) {
  const screen = el('div', 'phone-terminal');

  const topBar = el('header', 'phone-topbar phone-terminal-bar');
  const backBtn = button({ variant: 'icon', label: 'Back to board', icon: createLineIcon(BACK_ICON_PATH), action: 'back-to-board', onClick: () => onBack?.() });

  const identity = el('div', 'phone-terminal-identity');
  const nameEl = el('span', 'phone-terminal-name');
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
  const agentMarkEl = el('span', 'agent-mark');
  agentMarkEl.setAttribute('aria-hidden', 'true');
  agentMarkEl.hidden = true;
  labelEl.before(agentMarkEl, nameEl);
  identity.append(taskTitleEl, badgeEl);

  const pageButtons = createSessionPageButtons({ style: 'phone' });

  const actionSlot = el('div', 'phone-terminal-actions');

  topBar.append(backBtn, identity, pageButtons.element, actionSlot);

  const cardSlot = el('div', 'phone-card-slot');

  const emptyEl = el('div', 'phone-empty');
  emptyEl.innerHTML = '<p class="phone-empty-title">No session selected</p>'
    + '<p class="phone-empty-desc">Select a session from the board to watch it here.</p>';

  const keyStatus = createActionStatus('phone-key-status m-0 px-3 py-1');
  const composeBar = createComposeBar({ submit: submitComposedText });
  const { element: keyStrip, takeModifiedCharacter, setKeyboardOpen, setContext: setStripContext, setRawTypingChosen } = createMobileKeyStrip({
    send: sendFromStrip,
    getSessionId: () => shownId,
    reportProblem: (text) => keyStatus.show('error', text),
    toggleKeyboard: toggleActiveInputKeyboard,
    toggleRawTyping,
    pasteText: pasteIntoActiveInput,
    runTextAction: runTerminalTextAction,
  });
  screen.append(topBar, cardSlot, emptyEl, keyStatus.element, composeBar.element, keyStrip);

  let shownId: string | null = null;

  let adoptedActions: HTMLDivElement | null = null;
  let adoptedTags: HTMLDivElement | null = null;
  let renameTargetUi: SessionUi | null = null;
  let bufferChangeSubscription: { dispose: () => void } | null = null;
  let bufferWatchedTerminal: SessionUi['term'] | null = null;
  let isRawTypingChosen = false;
  let isRawTyping = false;

  function sendToShownTerminal(data: string | null | undefined) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui) return;
    if (sendTerminalInput(ui, data)) { keyStatus.clear(); return; }
    keyStatus.show('error', NOT_CONNECTED_TEXT);
  }

  function sendFromStrip(data: string | null | undefined) {
    if (data && !isRawTyping && isTextForCompose(data)) {
      composeBar.insertText(data);
      return;
    }
    sendToShownTerminal(data);
  }

  function submitComposedText(text: string) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui?.term) {
      keyStatus.show('error', NOT_CONNECTED_TEXT);
      return false;
    }
    if (text !== '') ui.term.paste(text);
    sendToShownTerminal('\r');
    return true;
  }

  function runTerminalTextAction(action: TerminalTextAction) {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui?.term) {
      keyStatus.show('error', NOT_CONNECTED_TEXT);
      return;
    }
    if (action === 'select') {
      blurActiveInput();
      openSelectSheet(ui);
      return;
    }
    if (action === 'copy-screen') {
      copyScreen(ui);
      return;
    }
    copyLastOutput(ui);
  }

  function pasteIntoActiveInput(text: string) {
    if (!isRawTyping) {
      composeBar.insertText(text.replace(/\r\n?/g, '\n'));
      return;
    }
    const ui = shownId ? sessionUIs.get(shownId) : null;
    if (!ui?.term) {
      keyStatus.show('error', NOT_CONNECTED_TEXT);
      return;
    }
    ui.term.paste(text);
  }

  function isShownTerminalFocused() {
    const ui = shownId ? sessionUIs.get(shownId) : null;
    const textarea = ui?.term?.textarea;
    return !!textarea && document.activeElement === textarea;
  }

  function isActiveInputFocused() {
    if (isRawTyping) return isShownTerminalFocused();
    return composeBar.isFocused();
  }

  function focusActiveInput() {
    if (!isRawTyping) {
      composeBar.focus();
      return;
    }
    const ui = shownId ? sessionUIs.get(shownId) : null;
    ui?.term?.focus();
  }

  function blurActiveInput() {
    if (!isRawTyping) {
      composeBar.blur();
      return;
    }
    const ui = shownId ? sessionUIs.get(shownId) : null;
    ui?.term?.blur();
  }

  function toggleActiveInputKeyboard() {
    if (isActiveInputFocused()) {
      blurActiveInput();
      return;
    }
    focusActiveInput();
  }

  function toggleRawTyping() {
    isRawTypingChosen = !isRawTypingChosen;
    setRawTypingChosen(isRawTypingChosen);
    paint();
    focusActiveInput();
  }

  function applyRawTyping(nextIsRawTyping: boolean) {
    if (nextIsRawTyping === isRawTyping) return;
    const wasTyping = isActiveInputFocused();
    isRawTyping = nextIsRawTyping;
    composeBar.setVisible(!isRawTyping);
    if (wasTyping) focusActiveInput();
  }

  function syncKeyboardOpen() {
    setKeyboardOpen(isActiveInputFocused());
  }

  cardSlot.addEventListener('click', focusActiveInput);
  for (const inputHost of [cardSlot, composeBar.element]) {
    inputHost.addEventListener('focusin', syncKeyboardOpen);
    inputHost.addEventListener('focusout', () => queueMicrotask(syncKeyboardOpen));
  }

  function sendHeldControlChord(typedCharacter: string) {
    if (typedCharacter.length !== 1) return false;
    const modifiedBytes = takeModifiedCharacter(typedCharacter);
    if (!modifiedBytes) return false;
    sendToShownTerminal(modifiedBytes);
    return true;
  }

  cardSlot.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!sendHeldControlChord(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  composeBar.field.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!sendHeldControlChord(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  composeBar.field.addEventListener('input', (event) => {
    if (!(event instanceof InputEvent) || !event.data) return;
    if (!sendHeldControlChord(event.data.slice(-1))) return;
    composeBar.removeTypedCharacterBeforeCaret();
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
    pageButtons.element.hidden = !hasSession;
    pageButtons.showSession(hasSession ? shownId : null);
    composeBar.showSession(hasSession ? shownId : null);
    if (hasSession) applyRawTyping(decideIsRawTyping({ isRawTypingChosen, bufferType: ui.term?.buffer.active.type, agentDrawsAlternateScreen: ui.agentDrawsAlternateScreen === true }));
    composeBar.setVisible(hasSession && !isRawTyping);
    syncKeyboardOpen();
    if (!hasSession) {
      topBar.removeAttribute('data-state');
      topBar.removeAttribute('data-monitoring');
      topBar.removeAttribute('data-prompt');
      return;
    }
    const state = ui.currentState || STATES.DORMANT;
    watchBufferOf(ui.term);
    setStripContext(decideStripContext({ pendingPromptKind: ui.pendingPromptKind, state, bufferType: ui.term?.buffer.active.type, agentDrawsAlternateScreen: ui.agentDrawsAlternateScreen === true }));
    paintSessionRowStatus(topBar, { glyph: glyphEl, label: labelEl }, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);

    paintAgentMark(agentMarkEl, ui.agent ?? null);
    const sessionName = ui.card?.dataset.session || shownId;
    if (!isRenameInProgress(nameEl)) nameEl.textContent = sessionName;
    taskTitleEl.dataset.sessionName = sessionName ?? '';
    paintTaskTitle(taskTitleEl, ui.taskTitle);
    elapsedEl.textContent = sessionElapsedText(ui);
  }

  function stopWatchingBuffer() {
    bufferChangeSubscription?.dispose();
    bufferChangeSubscription = null;
    bufferWatchedTerminal = null;
  }

  function watchBufferOf(terminal: SessionUi['term'] | null | undefined) {
    if (!terminal || terminal === bufferWatchedTerminal) return;
    stopWatchingBuffer();
    bufferWatchedTerminal = terminal;
    bufferChangeSubscription = terminal.buffer.onBufferChange(() => paint());
  }

  function releaseBorrowedChrome() {
    stopWatchingBuffer();
    if (renameTargetUi) {
      delete renameTargetUi.renameTargetEl;
      delete renameTargetUi.titleTargetEl;
      renameTargetUi = null;
    }

    nameEl.replaceChildren();
    returnToCard(adoptedTags, badgeEl);
    adoptedTags = null;
    returnToCard(adoptedActions, actionSlot);
    adoptedActions = null;
  }

  function returnToCard(adopted: HTMLElement | null, borrowingSlot: HTMLElement) {
    if (!adopted) return;
    releaseElement(adopted);
    if (adopted.parentElement === borrowingSlot) adopted.remove();
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
    adoptedTags = ui.tags;
    adoptElement(adoptedTags, badgeEl);

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
