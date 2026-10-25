import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { elapsedText } from '#shared/display-text.ts';
import { escapeMarkup } from '#shared/escape-markup.ts';
import type { ActionStatus } from '../action-status.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText, requestWithStatus } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sendSessionAction } from './card-dom.ts';
import { sessionUIs } from './card-registry.ts';
import type { SessionUi } from './card-registry.ts';
import { buildDialogShell, openConfirmDialog } from './modal.ts';
import { runRestartChoice } from './restart-menu-core.ts';

const DORMANT = 'DORMANT';

type RestartTarget = { kind: 'this' } | { kind: 'fresh' } | { kind: 'earlier'; conversationId: string };

function relTime(ms: number | null | undefined) {
  if (!ms) return '';
  return elapsedText(Date.now() - ms, { rounding: 'round', wording: 'compact', suffix: ' ago', justNowBelowSeconds: 60 });
}

type ResumableConversation = ServerMessageOf<'conversations'>['conversations'][number];

function conversationMeta(conv: ResumableConversation) {
  return [conv.worktreeName, conv.gitBranch ? conv.gitBranch.replace(/^refs\/heads\//, '') : null, relTime(conv.mtime)]
    .filter(Boolean)
    .join(' · ');
}

function buildRow(title: string, meta: string) {
  const row = el('button', 'resume-item');
  row.type = 'button';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  row.innerHTML =
    `<span class="resume-item-title">${escapeMarkup(title)}</span>` +
    `<span class="resume-item-meta">${escapeMarkup(meta)}</span>`;
  return row;
}

async function bindConversation(sessionId: string, target: RestartTarget, status: ActionStatus) {
  if (target.kind === 'this') return true;
  const conversationId = target.kind === 'earlier' ? target.conversationId : '';
  const reply = await requestWithStatus('resume-conversation', { id: sessionId, conversationId }, status);
  if (!reply) return false;
  if (reply.type === 'resume-conversation-ack' && reply.ok) return true;
  status.show('error', reply.type === 'error' ? reply.message : 'The conversation was not changed.');
  return false;
}

const RESTART_CHOICE_BY_TARGET_KIND = { this: 'restart', fresh: 'restart-fresh', earlier: 'restart-into' } as const;

function restartLiveSessionInto(ui: SessionUi, sessionId: string, target: RestartTarget, readState: () => string) {
  const conversationId = target.kind === 'earlier' ? target.conversationId : '';
  runRestartChoice(RESTART_CHOICE_BY_TARGET_KIND[target.kind], sessionId, {
    readState,
    send: (message) => { sendSessionAction(ui, message); },
    confirm: openConfirmDialog,
  }, conversationId);
}

export function openRestartDialog(sessionId: string, { readState, canListEarlier }: { readState: () => string; canListEarlier: boolean }) {
  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({
    title: 'Restart',
    dialogClass: 'dialog resume-dialog',
  });

  const hint = el('p', 'dialog-message', canListEarlier
    ? 'Restart into this conversation, a fresh one, or an earlier one from this repo (any worktree).'
    : 'Restart into this conversation or a fresh one.');
  const listEl = el('div', 'resume-list');
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Conversation to restart into');

  const btnRestart = el('button', 'btn-dialog btn-dialog-confirm', 'Restart');
  btnRestart.type = 'button';
  actions.append(btnRestart);

  const applyStatus = createActionStatus('dialog-error');
  dialog.append(hint, listEl, applyStatus.element, actions);

  let selectedTarget: RestartTarget = { kind: 'this' };

  function selectRow(row: HTMLButtonElement, target: RestartTarget) {
    for (const other of listEl.querySelectorAll('.resume-item')) {
      other.classList.remove('resume-item-current');
      other.setAttribute('aria-selected', 'false');
    }
    row.classList.add('resume-item-current');
    row.setAttribute('aria-selected', 'true');
    selectedTarget = target;
  }

  function addRow(target: RestartTarget, title: string, meta: string) {
    const row = buildRow(title, meta);
    row.addEventListener('click', () => selectRow(row, target));
    listEl.append(row);
    return row;
  }

  selectRow(addRow({ kind: 'this' }, 'This conversation', 'Keeps the current conversation'), { kind: 'this' });
  addRow({ kind: 'fresh' }, 'Fresh conversation', 'Ends this conversation and starts a new one');

  async function startDormantSessionInto(ui: SessionUi, target: RestartTarget) {
    dialog.dataset.applying = '';
    const isBound = await bindConversation(sessionId, target, applyStatus);
    delete dialog.dataset.applying;
    if (!isBound) return;
    close();
    sendSessionAction(ui, { type: 'start-session', id: sessionId });
  }

  function restartIntoSelected() {
    if (dialog.dataset.applying !== undefined) return;
    const ui = sessionUIs.get(sessionId);
    if (!ui) { close(); return; }
    if (readState() === DORMANT) { void startDormantSessionInto(ui, selectedTarget); return; }
    close();
    restartLiveSessionInto(ui, sessionId, selectedTarget, readState);
  }

  btnCancel.addEventListener('click', close);
  btnRestart.addEventListener('click', restartIntoSelected);
  requestAnimationFrame(() => btnRestart.focus());

  if (!canListEarlier) return;

  const earlierStatusEl = el('div', 'resume-empty', 'Loading earlier conversations...');
  listEl.append(earlierStatusEl);
  sendControlRequest('list-conversations', { id: sessionId }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((res) => {
      if (!overlay.isConnected) return;
      if (res.error) {
        earlierStatusEl.textContent = `Could not list earlier conversations: ${res.error}`;
        return;
      }
      const currentId = res.type === 'conversations' ? res.current ?? null : null;
      const earlierConversations = (res.type === 'conversations' ? res.conversations : []).filter((conv) => conv.id !== currentId);
      if (earlierConversations.length === 0) {
        earlierStatusEl.textContent = 'No earlier conversations found for this repo.';
        return;
      }
      earlierStatusEl.remove();
      for (const conv of earlierConversations) addRow({ kind: 'earlier', conversationId: conv.id }, conv.title || conv.id, conversationMeta(conv));
    })
    .catch((err) => {
      if (!overlay.isConnected) return;
      earlierStatusEl.textContent = `Could not list earlier conversations: ${requestFailureText(err, DEFAULT_REPLY_TIMEOUT_MS)}`;
    });
}
