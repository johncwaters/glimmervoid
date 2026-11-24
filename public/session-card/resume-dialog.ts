import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { elapsedText } from '#shared/display-text.ts';
import type { ActionStatus } from '../action-status.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText, requestWithStatus } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { sendSessionAction } from './card-actions.ts';
import { sessionUIs } from './card-registry.ts';
import type { SessionUi } from './card-registry.ts';
import { buildDialogShell, openConfirmDialog } from './modal.ts';
import { runRestartChoice } from './restart-menu-core.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { createLineIcon, PLUS_ICON_PATH } from '../svg-dom.ts';
import { clock } from '#shared/clock.ts';

const DORMANT = 'DORMANT';

type RestartTarget = { kind: 'this' } | { kind: 'fresh' } | { kind: 'earlier'; conversationId: string };

function relTime(ms: number | null | undefined) {
  if (!ms) return '';
  return elapsedText(clock.nowMs() - ms, { rounding: 'round', wording: 'compact', suffix: ' ago', justNowBelowSeconds: 60 });
}

type ResumableConversation = ServerMessageOf<'conversations'>['conversations'][number];

const BRANCH_ICON_PATH = 'M4.5 5v6 M11.5 7c0 3-7 2-7 4 M6 3.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M6 12.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z M13 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 1 1 3 0z';
const CONTINUE_ICON_PATH = 'M13 8a5 5 0 1 1-1.5-3.6 M13 2.5v3h-3';

function buildOption(className: string) {
  const option = createPressable(className);
  option.setAttribute('role', 'option');
  option.setAttribute('aria-selected', 'false');
  option.tabIndex = -1;
  return option;
}

function buildTile(iconPath: string, title: string, description: string, cost?: string) {
  const tile = buildOption('resume-tile');
  const descriptionEl = el('span', 'resume-tile-description', description);
  if (cost) descriptionEl.append(' ', el('span', 'resume-tile-cost', cost));
  tile.append(createLineIcon(iconPath, '1.5'), el('span', 'resume-tile-title', title), descriptionEl);
  return tile;
}

function buildEarlierRow(conv: ResumableConversation) {
  const row = buildOption('resume-item');
  const meta = el('span', 'resume-item-meta');
  const branch = conv.gitBranch ? conv.gitBranch.replace(/^refs\/heads\//, '') : null;
  meta.append(createLineIcon(BRANCH_ICON_PATH, '1.5'));
  if (branch) meta.append(el('span', null, branch));
  meta.append(el('span', 'resume-item-worktree', branch ? `in ${conv.worktreeName}` : conv.worktreeName));
  row.append(el('span', 'resume-item-title', conv.title || conv.id), el('span', 'resume-item-age', relTime(conv.mtime)), meta);
  return row;
}

function buildKeyHint() {
  const hint = el('span', 'resume-key-hint');
  hint.append(el('kbd', null, 'Up'), ' ', el('kbd', null, 'Down'), ' choose, ', el('kbd', null, 'Enter'), ' restart');
  return hint;
}

const NEXT_OPTION_STEP_BY_KEY: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

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

  const picker = el('div', 'resume-picker');
  picker.setAttribute('role', 'listbox');
  picker.setAttribute('aria-label', 'Conversation to restart into');
  const tiles = el('div', 'resume-tiles');
  picker.append(tiles);

  const btnRestart = button({ variant: 'primary', label: 'Restart' });
  actions.prepend(buildKeyHint());
  actions.append(btnRestart);

  const applyStatus = createActionStatus('dialog-error');
  dialog.append(picker, applyStatus.element, actions);

  const targetByOption = new Map<HTMLButtonElement, RestartTarget>();
  let selectedOption: HTMLButtonElement | null = null;

  function selectOption(option: HTMLButtonElement) {
    selectedOption?.setAttribute('aria-selected', 'false');
    if (selectedOption) selectedOption.tabIndex = -1;
    option.setAttribute('aria-selected', 'true');
    option.tabIndex = 0;
    selectedOption = option;
  }

  function addOption(option: HTMLButtonElement, target: RestartTarget, container: HTMLElement) {
    targetByOption.set(option, target);
    option.addEventListener('click', () => selectOption(option));
    container.append(option);
    return option;
  }

  const continueTile = addOption(buildTile(CONTINUE_ICON_PATH, 'Continue', 'Keeps this conversation going'), { kind: 'this' }, tiles);
  addOption(buildTile(PLUS_ICON_PATH, 'Fresh start', 'New conversation.', 'This one ends.'), { kind: 'fresh' }, tiles);
  selectOption(continueTile);

  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      restartIntoSelected();
      return;
    }
    const step = NEXT_OPTION_STEP_BY_KEY[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const options = [...targetByOption.keys()];
    const currentIndex = selectedOption ? options.indexOf(selectedOption) : 0;
    const next = options[Math.min(options.length - 1, Math.max(0, currentIndex + step))];
    if (!next) return;
    selectOption(next);
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  });

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
    const selectedTarget = (selectedOption && targetByOption.get(selectedOption)) ?? { kind: 'this' };
    if (readState() === DORMANT) { void startDormantSessionInto(ui, selectedTarget); return; }
    close();
    restartLiveSessionInto(ui, sessionId, selectedTarget, readState);
  }

  btnCancel.addEventListener('click', close);
  btnRestart.addEventListener('click', restartIntoSelected);
  requestAnimationFrame(() => continueTile.focus());

  if (!canListEarlier) return;

  const sectionCount = el('span', 'resume-section-count');
  const section = el('div', 'resume-section', 'Earlier in this repo');
  section.append(sectionCount);
  const listEl = el('div', 'resume-list');
  listEl.setAttribute('role', 'group');
  listEl.setAttribute('aria-label', 'Earlier in this repo');
  picker.append(section, listEl);

  function showListMessage(message: string) {
    listEl.replaceChildren(el('div', 'resume-empty', message));
  }
  showListMessage('Loading earlier conversations');

  sendControlRequest('list-conversations', { id: sessionId }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
    .then((res) => {
      if (!overlay.isConnected) return;
      if (res.error) {
        showListMessage(`Could not list earlier conversations: ${res.error}`);
        return;
      }
      const currentId = res.type === 'conversations' ? res.current ?? null : null;
      const earlierConversations = (res.type === 'conversations' ? res.conversations : []).filter((conv) => conv.id !== currentId);
      sectionCount.textContent = String(earlierConversations.length);
      if (earlierConversations.length === 0) {
        showListMessage('No earlier conversations in this repo yet.');
        return;
      }
      listEl.replaceChildren();
      for (const conv of earlierConversations) addOption(buildEarlierRow(conv), { kind: 'earlier', conversationId: conv.id }, listEl);
    })
    .catch((err) => {
      if (!overlay.isConnected) return;
      showListMessage(`Could not list earlier conversations: ${requestFailureText(err, DEFAULT_REPLY_TIMEOUT_MS)}`);
    });
}
