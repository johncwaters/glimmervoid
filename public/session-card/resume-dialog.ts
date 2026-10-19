import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { elapsedText } from '#shared/display-text.ts';
import { escapeMarkup } from '#shared/escape-markup.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText, requestWithStatus } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sendSessionAction, sessionActionStatus } from './card-dom.ts';
import { sessionUIs } from './card-registry.ts';
import { buildDialogShell } from './modal.ts';

const DORMANT = 'DORMANT';

function relTime(ms: number | null | undefined) {
  if (!ms) return '';
  return elapsedText(Date.now() - ms, { rounding: 'round', wording: 'compact', suffix: ' ago', justNowBelowSeconds: 60 });
}

type ResumableConversation = ServerMessageOf<'conversations'>['conversations'][number];

function buildItem(conv: ResumableConversation, currentId: string | null, onPick: (conversationId: string) => void) {
  const item = el('button', 'resume-item');
  item.type = 'button';
  item.setAttribute('role', 'option');
  if (conv.id === currentId) item.classList.add('resume-item-current');

  const meta = [conv.worktreeName, conv.gitBranch ? conv.gitBranch.replace(/^refs\/heads\//, '') : null, relTime(conv.mtime)]
    .filter(Boolean)
    .join(' · ');

  item.innerHTML =
    `<span class="resume-item-title">${escapeMarkup(conv.title || conv.id)}</span>` +
    `<span class="resume-item-meta">${escapeMarkup(meta)}${conv.id === currentId ? ' · current' : ''}</span>`;
  item.addEventListener('click', () => onPick(conv.id));
  return item;
}

export function openResumeDialog(sessionId: string, opts: { currentState?: string } = {}) {
  const isDormant = (opts.currentState || '') === DORMANT;

  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({
    title: 'Resume a conversation',
    dialogClass: 'dialog resume-dialog',
  });

  const hint = el('p', 'dialog-message', 'Pick a Claude conversation from this repo (any worktree) to continue in this card.');
  const listEl = el('div', 'resume-list');
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Resumable conversations');
  listEl.append(el('div', 'resume-empty', 'Loading conversations...'));

  const btnClear = el('button', 'btn-dialog btn-dialog-cancel', 'Start fresh');
  btnClear.title = 'Clear any resume binding so this card starts a new conversation';
  actions.prepend(btnClear);

  const applyStatus = createActionStatus('dialog-error');
  dialog.append(hint, listEl, applyStatus.element, actions);

  async function apply(conversationId: string | null) {
    if (dialog.dataset.applying !== undefined) return;
    dialog.dataset.applying = '';
    const reply = await requestWithStatus('resume-conversation', { id: sessionId, conversationId: conversationId || '' }, applyStatus);
    delete dialog.dataset.applying;
    if (!reply) return;
    if (reply.type !== 'resume-conversation-ack' || !reply.ok) {
      applyStatus.show('error', reply.type === 'error' ? reply.message : 'The conversation was not changed.');
      return;
    }
    close();
    const ui = sessionUIs.get(sessionId);
    if (!conversationId || !ui) return;
    if (isDormant) { sendSessionAction(ui, { type: 'start-session', id: sessionId }); return; }
    sessionActionStatus(ui).show('ok', "Conversation will resume on this session's next restart.");
  }

  btnCancel.addEventListener('click', close);
  btnClear.addEventListener('click', () => { void apply(null); });
  requestAnimationFrame(() => btnCancel.focus());

  sendControlRequest('list-conversations', { id: sessionId }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((res) => {
      if (!overlay.isConnected) return;
      const convs = res.type === 'conversations' ? res.conversations : [];
      listEl.innerHTML = '';
      if (res.error) {
        listEl.append(el('div', 'resume-empty', `Could not list conversations: ${res.error}`));
        return;
      }
      if (convs.length === 0) {
        listEl.append(el('div', 'resume-empty', 'No prior conversations found for this repo.'));
        return;
      }
      const currentId = res.type === 'conversations' ? res.current ?? null : null;
      for (const conv of convs) listEl.append(buildItem(conv, currentId, (conversationId) => { void apply(conversationId); }));
    })
    .catch((err) => {
      if (!overlay.isConnected) return;
      listEl.innerHTML = '';
      listEl.append(el('div', 'resume-empty', `Could not list conversations: ${requestFailureText(err, DEFAULT_REPLY_TIMEOUT_MS)}`));
    });
}
