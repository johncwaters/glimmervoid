import { writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { buildMenuItem } from '../menu.ts';
import { CLOSE_ICON_PATH, SWITCH_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { openSwitchAccountDialog } from './card-account.ts';
import type { CardOptions } from './card-options-core.ts';
import { buildDialogShell } from './modal.ts';
import { findSessionUi } from './card-registry.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { paintTaskTitle } from './card-titles.ts';
import { hasPendingWakes, openSessionWakes, paintWakeChip } from './session-wakes.ts';
import { button, menuButton } from '../ui/button.ts';

type LinkedPrsPainter = (slot: HTMLElement, sessionId: string) => void;
let paintLinkedPrs: LinkedPrsPainter | null = null;

export function setLinkedPrsPainter(painter: LinkedPrsPainter) {
  paintLinkedPrs = painter;
}

interface CardCoherenceJournal {
  isReadable: (sessionId: string) => boolean;
  open: (sessionId: string) => void;
}
let cardCoherenceJournal: CardCoherenceJournal | null = null;

export function setCardCoherenceJournal(journal: CardCoherenceJournal) {
  cardCoherenceJournal = journal;
}

let openCardSessionSetup: ((sessionId: string) => void) | null = null;
let openCardConnectBoard: ((sessionId: string) => void) | null = null;

export function setCardConnectBoard(open: (sessionId: string) => void) {
  openCardConnectBoard = open;
}

export function setCardSessionSetup(open: (sessionId: string) => void) {
  openCardSessionSetup = open;
}

export type { CardOptions };

export function setSessionSaneYolo(sessionId: unknown, saneYolo: boolean) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (saneYolo) ui.card.dataset.saneYolo = '';
  if (!saneYolo) delete ui.card.dataset.saneYolo;
}

export function sessionQuestionManagerOf(card: HTMLElement | null): boolean | null {
  const questionManagerState = card?.dataset.questionManager;
  if (questionManagerState === undefined) return null;
  return questionManagerState === 'on';
}

function paintQuestionManager(card: HTMLElement, menuItem: Element | null, isQuestionManagerOn: boolean | null) {
  menuItem?.classList.toggle('visible', isQuestionManagerOn !== null);
  menuItem?.setAttribute('aria-checked', String(isQuestionManagerOn === true));
  if (isQuestionManagerOn === null) {
    delete card.dataset.questionManager;
    return;
  }
  card.dataset.questionManager = isQuestionManagerOn ? 'on' : 'off';
}

export function setSessionQuestionManager(sessionId: unknown, isQuestionManagerOn: boolean | null) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  paintQuestionManager(ui.card, ui.sessionMenu.querySelector('.overflow-question-manager'), isQuestionManagerOn);
}

const headerByCard = new WeakMap<HTMLElement, HTMLElement>();

export function queryCardPart(card: HTMLElement, selector: string): HTMLElement | null {
  return card.querySelector<HTMLElement>(selector) ?? headerByCard.get(card)?.querySelector<HTMLElement>(selector) ?? null;
}

export function buildCardDOM(sessionId: string, sessionName: string, initialState: string, options: CardOptions = {}) {
  const state = initialState || STATES.INITIALIZING;
  const card = el('div', 'session-card');
  card.dataset.id = sessionId;
  card.dataset.session = sessionName;
  card.dataset.state = state;
  if (options.skipPerms) card.dataset.skipPerms = '';
  if (options.saneYolo) card.dataset.saneYolo = '';
  if (options.worktree) card.dataset.worktree = '';
  if (options.workspace) card.dataset.workspace = '';
  if (options.ephemeral) card.dataset.ephemeral = '';
  if (options.accountId) card.dataset.accountId = options.accountId;
  if (options.path) card.dataset.path = String(options.path);

  const header = el('div', 'session-card-header');

  const agentMarkEl = el('span', 'agent-mark session-agent-mark');
  agentMarkEl.setAttribute('aria-hidden', 'true');
  agentMarkEl.hidden = true;
  const nameEl = el('span', 'session-name', sessionName);
  nameEl.tabIndex = 0;
  const taskTitleEl = el('span', 'session-task-title');
  paintTaskTitle(taskTitleEl, options.taskTitle);

  const actions = el('div', 'session-actions');

  const sessionMenuWrap = el('div', 'session-overflow');
  const btnSessionMenu = menuButton({ label: 'Session actions', action: 'session-menu' });
  btnSessionMenu.setAttribute('aria-haspopup', 'menu');
  btnSessionMenu.setAttribute('aria-expanded', 'false');
  const sessionMenu = el('div', 'popup-menu session-overflow-menu');
  sessionMenu.id = `session-menu-${sessionId}`;
  sessionMenu.setAttribute('role', 'menu');
  btnSessionMenu.setAttribute('aria-controls', sessionMenu.id);

  const btnRename = buildMenuItem('Rename session', 'overflow-rename visible');
  const btnRestart = buildMenuItem('Restart', 'overflow-restart');
  btnRestart.setAttribute('aria-haspopup', 'dialog');
  const btnWorkspaceRepos = buildMenuItem('Edit repositories', 'overflow-workspace-repos');
  const btnLinkPr = buildMenuItem('Pull requests', 'overflow-link-pr visible');
  btnLinkPr.setAttribute('aria-haspopup', 'dialog');
  btnLinkPr.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openLinkPullRequestDialog(sessionId);
  };
  const btnConnectBoard = buildMenuItem('Connect board', 'overflow-connect-board visible');
  btnConnectBoard.setAttribute('aria-haspopup', 'dialog');
  btnConnectBoard.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openCardConnectBoard?.(sessionId);
  };
  const btnCoherenceJournal = buildMenuItem('Coherence journal', 'overflow-coherence-journal');
  btnCoherenceJournal.setAttribute('aria-haspopup', 'dialog');
  const btnWakes = buildMenuItem('Wakes', 'overflow-wakes');
  btnWakes.setAttribute('aria-haspopup', 'dialog');
  btnWakes.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openSessionWakes(sessionId);
  };
  const paintMenuItems = () => {
    btnCoherenceJournal.classList.toggle('visible', cardCoherenceJournal?.isReadable(sessionId) === true);
    btnWakes.classList.toggle('visible', hasPendingWakes(sessionId));
  };
  btnSessionMenu.onclick = paintMenuItems;
  btnSessionMenu.onkeydown = paintMenuItems;
  btnCoherenceJournal.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    cardCoherenceJournal?.open(sessionId);
  };
  const btnSessionSetup = buildMenuItem('Session setup', 'overflow-session-setup visible');
  btnSessionSetup.setAttribute('aria-haspopup', 'dialog');
  btnSessionSetup.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openCardSessionSetup?.(sessionId);
  };
  const btnQuestionManager = buildMenuItem('Question manager', 'overflow-question-manager');
  btnQuestionManager.setAttribute('role', 'menuitemcheckbox');
  paintQuestionManager(card, btnQuestionManager, options.isQuestionManagerOn ?? null);
  btnQuestionManager.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    sendControlMsg({ type: 'set-session-question-manager', id: sessionId, isOn: sessionQuestionManagerOf(card) !== true });
  };
  const btnSwitchAccountMenuItem = buildMenuItem('Switch account', 'overflow-switch-account');
  btnSwitchAccountMenuItem.setAttribute('aria-haspopup', 'dialog');
  btnSwitchAccountMenuItem.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openSwitchAccountDialog(sessionId);
  };
  const btnDebug = buildMenuItem('Debug state', 'overflow-debug');
  const btnTrace = buildMenuItem('Trace', 'overflow-trace');
  sessionMenu.append(btnRename, btnWorkspaceRepos, btnCoherenceJournal, btnSessionSetup, btnWakes, btnQuestionManager, btnLinkPr, btnConnectBoard, btnSwitchAccountMenuItem, btnDebug, btnTrace, btnRestart);
  sessionMenuWrap.append(btnSessionMenu, sessionMenu);

  const btnRemove = button({ variant: 'icon', size: 'small', label: 'Remove session', icon: createLineIcon(CLOSE_ICON_PATH), action: 'remove-session' });
  const btnRemoveMenuItem = buildMenuItem('Remove session', 'overflow-remove visible');
  btnRemoveMenuItem.onclick = () => btnRemove.click();
  const removeDivider = el('div', 'menu-divider');
  removeDivider.setAttribute('role', 'separator');
  sessionMenu.append(removeDivider, btnRemoveMenuItem);

  const btnDocs = button({ variant: 'quiet', size: 'small', label: 'Docs', action: 'open-docs', hidden: true });


  actions.append(sessionMenuWrap);
  const tags = el('div', 'session-card-tags');
  const wakeChipSlot = el('span', 'session-wake-chip-slot');
  paintWakeChip(wakeChipSlot, sessionId);
  const accountChip = el('span', 'session-account');
  accountChip.hidden = true;
  const btnSwitchAccount = button({ variant: 'icon', size: 'small', label: 'Switch account', icon: createLineIcon(SWITCH_ICON_PATH), action: 'switch-account', hidden: true });
  btnSwitchAccount.classList.add('session-account-switch');
  btnSwitchAccount.setAttribute('aria-haspopup', 'dialog');
  btnSwitchAccount.onclick = () => openSwitchAccountDialog(sessionId);
  tags.append(wakeChipSlot, accountChip, btnSwitchAccount);
  const ownershipEl = el('span', 'session-ownership');
  ownershipEl.hidden = true;
  header.append(agentMarkEl, nameEl, taskTitleEl, ownershipEl, tags, actions);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);
  headerByCard.set(card, header);

  return { card, header, nameEl, taskTitleEl, btnRename, btnRestart, btnSessionMenu, btnWorkspaceRepos, tags, btnTrace, btnRemove, btnDocs, btnDebug, sessionMenu, termWrap };
}

function openLinkPullRequestDialog(sessionId: string) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Pull requests' });
  const hint = el('p', 'dialog-message', 'Link one by pasting a GitHub pull request URL or owner/repo#number.');
  const input = markAsNotCredential(el('input', 'dialog-input'));
  input.type = 'text';
  input.placeholder = 'owner/repo#123';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Pull request URL or owner/repo#number');
  const errorEl = el('div', 'dialog-error');
  errorEl.setAttribute('role', 'alert');
  const linkedPrsEl = el('ul', 'linked-pr-rows');
  linkedPrsEl.setAttribute('aria-label', 'Linked pull requests');
  linkedPrsEl.hidden = true;
  paintLinkedPrs?.(linkedPrsEl, sessionId);
  const btnLink = button({ variant: 'primary', label: 'Link' });
  actions.append(btnLink);
  dialog.append(linkedPrsEl, hint, input, errorEl, actions);

  function submitLink() {
    const pullRequestKey = pullRequestKeyFromReference(input.value);
    if (!pullRequestKey) {
      errorEl.textContent = 'Enter a github.com pull request URL or owner/repo#number.';
      return;
    }
    if (!sendControlMsg({ type: 'link-session-pr', id: sessionId, key: pullRequestKey })) {
      errorEl.textContent = NOT_CONNECTED_TEXT;
      return;
    }
    close();
  }

  btnCancel.addEventListener('click', close);
  btnLink.addEventListener('click', submitLink);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitLink();
  });
  requestAnimationFrame(() => input.focus());
}

export function paintCardOwnership(card: HTMLElement, ownershipText: string | null) {
  const ownershipEl = queryCardPart(card, '.session-ownership');
  if (!ownershipEl) return;
  writeTextIfChanged(ownershipEl, ownershipText ?? '');
  writeHiddenIfChanged(ownershipEl, ownershipText === null);
}
