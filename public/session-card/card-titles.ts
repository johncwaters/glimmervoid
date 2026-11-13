import { SESSION_NAME_PATTERN, SESSION_NAME_RULE_TEXT, TASK_TITLE_MAX_LENGTH } from '#shared/contracts/session.ts';
import { firstCodePoints } from '#shared/text.ts';
import { markAsNotCredential } from '../dom-helpers.ts';
import type { SessionUi } from './card-registry.ts';
import { sessionUIs } from './card-registry.ts';
import { sessionActionStatus, sendSessionAction } from './card-actions.ts';

export function makeTitleEditable(titleEl: HTMLElement, onActivate: () => void) {
  titleEl.tabIndex = 0;
  titleEl.setAttribute('role', 'button');
  titleEl.addEventListener('click', onActivate);
  titleEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  });
}

export function paintTaskTitle(titleEl: HTMLElement, taskTitle: string | null | undefined) {
  if (taskTitle) titleEl.removeAttribute('aria-label');
  if (!taskTitle) titleEl.setAttribute('aria-label', 'Describe the task');
  if (titleEl.querySelector('input')) return;
  titleEl.textContent = taskTitle ?? '';
}

export function startInlineTitleEdit(ui: SessionUi, sessionId: string) {
  const targetEl = ui.titleTargetEl?.isConnected ? ui.titleTargetEl : ui.taskTitleEl;
  if (targetEl.querySelector('input')) return;
  const input = markAsNotCredential(document.createElement('input'));
  input.type = 'text';
  input.className = 'session-title-input';
  input.setAttribute('aria-label', 'Task');
  input.value = ui.taskTitleIsCustom ? ui.taskTitle ?? '' : '';
  input.placeholder = ui.taskTitle ?? 'What is this session working on?';
  const previousRole = targetEl.getAttribute('role');
  const previousTabIndex = targetEl.getAttribute('tabindex');
  targetEl.removeAttribute('role');
  targetEl.removeAttribute('tabindex');
  targetEl.replaceChildren(input);
  input.focus();
  input.select();

  function finish(shouldCommit: boolean) {
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('input', cutToMaxLength);
    if (shouldCommit) sendSessionAction(ui, { type: 'set-session-title', id: sessionId, title: firstCodePoints(input.value.trim(), TASK_TITLE_MAX_LENGTH) });
    targetEl.replaceChildren();
    if (previousRole !== null) targetEl.setAttribute('role', previousRole);
    if (previousTabIndex !== null) targetEl.setAttribute('tabindex', previousTabIndex);
    paintTaskTitle(targetEl, ui.taskTitle);
  }

  function commit() {
    finish(true);
  }

  function onKey(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  }

  function cutToMaxLength(event: Event) {
    if (event instanceof InputEvent && event.isComposing) return;
    const cutTitle = firstCodePoints(input.value, TASK_TITLE_MAX_LENGTH);
    if (cutTitle !== input.value) input.value = cutTitle;
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
  input.addEventListener('input', cutToMaxLength);
}

const RENAME_INPUT_CLASS = 'session-rename-input';

export function isRenameInProgress(targetEl: Element | null | undefined) {
  return !!targetEl?.querySelector(`.${RENAME_INPUT_CLASS}`);
}

export function startInlineRename(ui: SessionUi, sessionId: string, { returnsFocusToTerminal = true } = {}) {
  const targetEl = ui.renameTargetEl?.isConnected ? ui.renameTargetEl : ui.nameEl;
  if (!targetEl || isRenameInProgress(targetEl)) return;

  const nameBeforeEdit = ui.card?.dataset.session ?? targetEl.textContent ?? '';

  const input = markAsNotCredential(document.createElement('input'));
  input.type = 'text';
  input.className = RENAME_INPUT_CLASS;
  input.value = nameBeforeEdit;
  input.maxLength = 64;

  targetEl.textContent = '';
  targetEl.appendChild(input);
  input.focus();
  input.select();

  const status = sessionActionStatus(ui);

  function refusalFor(newName: string) {
    if (ui.card.dataset.ephemeral !== undefined) return 'This session cannot be renamed';
    if (!SESSION_NAME_PATTERN.test(newName)) return SESSION_NAME_RULE_TEXT;
    const isTakenByAnother = [...sessionUIs.values()].some((other) => other !== ui && other.card.dataset.session === newName);
    return isTakenByAnother ? `Session "${newName}" already exists.` : '';
  }

  function finishEditing(shownName = ui.card?.dataset.session ?? nameBeforeEdit) {
    targetEl.textContent = shownName;
    if (ui.nameEl && ui.nameEl !== targetEl) ui.nameEl.textContent = shownName;
    if (returnsFocusToTerminal) ui.term?.focus();
  }

  function submitFromKeyboard() {
    const newName = input.value.trim();
    const refusal = newName && newName !== nameBeforeEdit ? refusalFor(newName) : '';
    if (!refusal) { commit(); return; }
    status.show('error', refusal);
    input.select();
  }

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (!newName || newName === nameBeforeEdit) {
      finishEditing();
      return;
    }
    const refusal = refusalFor(newName);
    if (refusal) {
      status.show('error', refusal);
      finishEditing();
      return;
    }
    if (!sendSessionAction(ui, { type: 'rename-session', id: sessionId, newName })) {
      finishEditing();
      return;
    }
    finishEditing(newName);
  }

  function cancel() {
    cleanup();
    finishEditing();
  }

  function cleanup() {
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submitFromKeyboard(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}
