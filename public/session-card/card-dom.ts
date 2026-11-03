import { writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildMenuItem } from '../menu.ts';
import { refreshHoverTip, installHoverTips } from '../hover-tip.ts';
import { BOLT_ICON_PATH, CLOSE_ICON_PATH, createLineIcon, createSvgIcon, createSvgShape, IMAGE_ICON_PATH, MORE_ICON_PATH, SHIELD_ICON_PATH, SHIELDED_BOLT_FILL_PATH, TERMINAL_ICON_PATH, USAGE_ICON_PATH } from '../svg-dom.ts';
import type { CardOptions } from './card-options-core.ts';
import { buildDialogShell } from './modal.ts';
import { findSessionUi } from './card-registry.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';
import { paintTaskTitle } from './card-titles.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';

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

function buildTagIcon(className: string, ariaLabel: string) {
  const tagIcon = el('span', `tag-icon ${className}`);
  tagIcon.tabIndex = 0;
  tagIcon.setAttribute('role', 'img');
  tagIcon.setAttribute('aria-label', ariaLabel);
  return tagIcon;
}

function createFilledIcon(fillPath: string) {
  const icon = createSvgIcon(16, 16);
  icon.classList.add('line-icon');
  icon.append(createSvgShape('path', { d: fillPath, fill: 'currentColor' }));
  return icon;
}

function createSaneYoloIcon() {
  const icon = createLineIcon(SHIELD_ICON_PATH, '1.5');
  icon.append(createSvgShape('path', { d: SHIELDED_BOLT_FILL_PATH, fill: 'currentColor' }));
  return icon;
}

export type { CardOptions };

export function remoteWorkspaceHoverText(remoteWorkspace: string): string {
  return `Runs in Coder workspace ${remoteWorkspace}`;
}

function paintPermsBadge(permsBadge: HTMLElement, saneYolo: boolean) {
  const label = saneYolo ? 'Sane YOLO' : 'YOLO';
  permsBadge.setAttribute('aria-label', label);
  permsBadge.dataset.tipLabel = label;
  permsBadge.dataset.tipDetail = saneYolo
    ? 'Skips permission prompts; Sane YOLO blocks catastrophic commands'
    : 'Running with --dangerously-skip-permissions';
  permsBadge.replaceChildren(saneYolo ? createSaneYoloIcon() : createFilledIcon(BOLT_ICON_PATH));
  refreshHoverTip(permsBadge);
}

export function setSessionSaneYolo(sessionId: unknown, saneYolo: boolean) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  if (saneYolo) ui.card.dataset.saneYolo = '';
  if (!saneYolo) delete ui.card.dataset.saneYolo;
  const permsBadge = ui.tags.querySelector<HTMLElement>('.perms-badge');
  if (permsBadge) paintPermsBadge(permsBadge, saneYolo);
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
  if (options.remoteWorkspace) card.dataset.remoteWorkspace = options.remoteWorkspace;
  if (options.ephemeral) card.dataset.ephemeral = '';
  if (options.path) card.dataset.path = String(options.path);

  const header = el('div', 'session-card-header');

  const nameEl = el('span', 'session-name', sessionName);
  nameEl.title = 'Double-click or press F2 to rename';
  nameEl.tabIndex = 0;
  const permsBadge = options.skipPerms ? buildTagIcon('perms-badge', 'YOLO') : null;
  if (permsBadge) paintPermsBadge(permsBadge, options.saneYolo === true);
  const taskTitleEl = el('span', 'session-task-title');
  paintTaskTitle(taskTitleEl, options.taskTitle);

  const actions = el('div', 'session-actions');

  const sessionMenuWrap = el('div', 'session-overflow');
  const btnSessionMenu = button({ variant: 'icon', size: 'small', label: 'Session actions', icon: createLineIcon(MORE_ICON_PATH), action: 'session-menu' });
  btnSessionMenu.setAttribute('aria-haspopup', 'menu');
  btnSessionMenu.setAttribute('aria-expanded', 'false');
  const sessionMenu = el('div', 'popup-menu session-overflow-menu');
  sessionMenu.id = `session-menu-${sessionId}`;
  sessionMenu.setAttribute('role', 'menu');
  btnSessionMenu.setAttribute('aria-controls', sessionMenu.id);

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
  const paintCoherenceJournalItem = () => btnCoherenceJournal.classList.toggle('visible', cardCoherenceJournal?.isReadable(sessionId) === true);
  btnSessionMenu.onclick = paintCoherenceJournalItem;
  btnSessionMenu.onkeydown = paintCoherenceJournalItem;
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
  const btnDebug = buildMenuItem('Debug state', 'overflow-debug');
  const btnTrace = buildMenuItem('Trace', 'overflow-trace');
  sessionMenu.append(btnWorkspaceRepos, btnCoherenceJournal, btnSessionSetup, btnLinkPr, btnConnectBoard, btnDebug, btnTrace, btnRestart);
  sessionMenuWrap.append(btnSessionMenu, sessionMenu);

  const btnRemove = button({ variant: 'icon', size: 'small', label: 'Remove session', icon: createLineIcon(CLOSE_ICON_PATH), action: 'remove-session' });
  const btnRemoveMenuItem = buildMenuItem('Remove session', 'overflow-remove visible');
  btnRemoveMenuItem.onclick = () => btnRemove.click();
  sessionMenu.append(btnRemoveMenuItem);

  const btnPlan = button({ variant: 'quiet', size: 'small', label: 'Plan', action: 'show-plan', hidden: true });
  const btnDocs = button({ variant: 'quiet', size: 'small', label: 'Docs', action: 'open-docs', hidden: true });

  const faceTabs = el('div', 'card-face-tabs');
  faceTabs.setAttribute('role', 'tablist');
  faceTabs.setAttribute('aria-label', 'Card view');
  const btnTerminalTab = createPressable('card-face-tab');
  btnTerminalTab.title = 'Terminal';
  btnTerminalTab.setAttribute('aria-label', 'Terminal');
  btnTerminalTab.append(createLineIcon(TERMINAL_ICON_PATH), el('span', 'card-face-tab-label', 'Terminal'));
  btnTerminalTab.setAttribute('role', 'tab');
  const btnShownTab = createPressable('card-face-tab card-face-tab-shown');
  btnShownTab.setAttribute('role', 'tab');
  btnShownTab.title = 'Files the agent showed you';
  btnShownTab.setAttribute('aria-label', 'Shown');
  btnShownTab.append(createLineIcon(IMAGE_ICON_PATH), el('span', 'card-face-tab-label', 'Shown'));
  const shownUnopenedCount = el('span', 'shown-unopened-count');
  shownUnopenedCount.hidden = true;
  shownUnopenedCount.title = 'Shown files you have not opened';
  faceTabs.append(btnTerminalTab, btnShownTab, shownUnopenedCount);

  actions.append(faceTabs, btnDocs, btnPlan, sessionMenuWrap, btnRemove);
  const tags = el('div', 'session-card-tags');
  const usageBadge = buildTagIcon('usage-badge', 'Usage');
  usageBadge.append(createLineIcon(USAGE_ICON_PATH, '2.2'));
  if (permsBadge) tags.append(permsBadge);
  tags.append(usageBadge);
  installHoverTips();
  const ownershipEl = el('span', 'session-ownership');
  ownershipEl.hidden = true;
  header.append(nameEl, taskTitleEl, ownershipEl, tags, actions);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, nameEl, taskTitleEl, btnRestart, btnSessionMenu, btnWorkspaceRepos, tags, btnTrace, btnRemove, btnPlan, btnDocs, btnTerminalTab, btnShownTab, shownUnopenedCount, btnDebug, sessionMenu, termWrap };
}

function openLinkPullRequestDialog(sessionId: string) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Pull requests' });
  const hint = el('p', 'dialog-message', 'Link one by pasting a GitHub pull request URL or owner/repo#number.');
  const input = el('input', 'dialog-input');
  input.type = 'text';
  input.placeholder = 'owner/repo#123';
  input.autocomplete = 'off';
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
  const ownershipEl = card.querySelector<HTMLElement>('.session-ownership');
  if (!ownershipEl) return;
  writeTextIfChanged(ownershipEl, ownershipText ?? '');
  writeHiddenIfChanged(ownershipEl, ownershipText === null);
}
