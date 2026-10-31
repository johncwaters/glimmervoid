
import { writeHiddenIfChanged, writeTextIfChanged } from '../status-paint.ts';
import { pullRequestKeyFromReference } from '#shared/contracts/control-messages.ts';
import { SESSION_NAME_PATTERN, SESSION_NAME_RULE_TEXT, TASK_TITLE_MAX_LENGTH } from '#shared/contracts/session.ts';
import { localClockText } from '#shared/display-text.ts';
import { STATES } from '#shared/states.ts';
import { createActionStatus, sendOrReport } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { sendControlMsg } from '../control-ws.ts';
import { escapeMarkup } from '#shared/escape-markup.ts';
import { el } from '../dom-helpers.ts';
import { buildMenuItem } from '../menu.ts';
import { refreshHoverTip, installHoverTips } from '../hover-tip.ts';
import { BOLT_ICON_PATH, CLOSE_ICON_PATH, createLineIcon, createSvgIcon, createSvgShape, IMAGE_ICON_PATH, MORE_ICON_PATH, SHIELD_ICON_PATH, SHIELDED_BOLT_FILL_PATH, TERMINAL_ICON_PATH, USAGE_ICON_PATH } from '../svg-dom.ts';
import type { CardOptions } from './card-options-core.ts';
import { buildDialogShell } from './modal.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import { NOT_CONNECTED_TEXT } from '../updates-view-core.ts';

const actionStatusBySessionUi = new WeakMap<SessionUi, ActionStatus>();

export function sessionActionStatus(ui: SessionUi): ActionStatus {
  const existing = actionStatusBySessionUi.get(ui);
  if (existing?.element.parentElement === ui.card) return existing;
  const status = existing ?? createActionStatus('session-action-status m-0 px-3 py-1');
  ui.termWrap.before(status.element);
  actionStatusBySessionUi.set(ui, status);
  return status;
}

export function sendSessionAction(ui: SessionUi, message: Record<string, unknown>): boolean {
  const status = sessionActionStatus(ui);
  if (!sendOrReport(message, status)) return false;
  status.clear();
  return true;
}

let _debugMode = false;
const debugModeListeners = new Set<(isEnabled: boolean) => void>();

export function setDebugMode(on: boolean) {
  _debugMode = !!on;
  updateDebugVisibility();
  for (const listener of debugModeListeners) listener(_debugMode);
}

export function onDebugModeChanged(listener: (isEnabled: boolean) => void) {
  debugModeListeners.add(listener);
  return () => debugModeListeners.delete(listener);
}

export function isDebugModeEnabled() {
  return _debugMode;
}

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
  const btnSessionMenu = el('button', 'btn-action btn-session-menu visible');
  btnSessionMenu.append(createLineIcon(MORE_ICON_PATH));
  btnSessionMenu.type = 'button';
  btnSessionMenu.title = 'Session actions';
  btnSessionMenu.setAttribute('aria-label', 'Session actions');
  btnSessionMenu.setAttribute('aria-haspopup', 'menu');
  btnSessionMenu.setAttribute('aria-expanded', 'false');
  const sessionMenu = el('div', 'popup-menu session-overflow-menu');
  sessionMenu.id = `session-menu-${sessionId}`;
  sessionMenu.setAttribute('role', 'menu');
  btnSessionMenu.setAttribute('aria-controls', sessionMenu.id);

  const btnRestart = buildMenuItem('Restart...', 'Into this conversation, a fresh one, or an earlier one', 'overflow-restart');
  btnRestart.setAttribute('aria-haspopup', 'dialog');
  const btnWorkspaceRepos = buildMenuItem('Edit repositories...', 'Add or remove repositories in this workspace', 'overflow-workspace-repos');
  const btnLinkPr = buildMenuItem('Link pull request...', 'Link or unlink pull requests for this session', 'overflow-link-pr visible');
  btnLinkPr.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openLinkPullRequestDialog(sessionId);
  };
  const btnConnectBoard = buildMenuItem('Connect board...', 'Connect or disconnect whiteboards for this session', 'overflow-connect-board visible');
  btnConnectBoard.setAttribute('aria-haspopup', 'dialog');
  btnConnectBoard.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openCardConnectBoard?.(sessionId);
  };
  const btnCoherenceJournal = buildMenuItem('Coherence journal', 'Decisions and notes this session recorded', 'overflow-coherence-journal');
  btnCoherenceJournal.setAttribute('aria-haspopup', 'dialog');
  const paintCoherenceJournalItem = () => btnCoherenceJournal.classList.toggle('visible', cardCoherenceJournal?.isReadable(sessionId) === true);
  btnSessionMenu.onclick = paintCoherenceJournalItem;
  btnSessionMenu.onkeydown = paintCoherenceJournalItem;
  btnCoherenceJournal.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    cardCoherenceJournal?.open(sessionId);
  };
  const btnSessionSetup = buildMenuItem('Session setup', 'MCP servers, plugins and hooks this session loaded', 'overflow-session-setup visible');
  btnSessionSetup.setAttribute('aria-haspopup', 'dialog');
  btnSessionSetup.onclick = () => {
    sessionMenu.classList.remove('open');
    btnSessionMenu.setAttribute('aria-expanded', 'false');
    openCardSessionSetup?.(sessionId);
  };
  const btnDebug = buildMenuItem('Debug state', 'State transitions and detection signals', 'overflow-debug');
  const btnTrace = buildMenuItem('Trace', 'Turns, tool calls and thinking this session recorded', 'overflow-trace');
  sessionMenu.append(btnRestart, btnWorkspaceRepos, btnCoherenceJournal, btnSessionSetup, btnLinkPr, btnConnectBoard, btnDebug, btnTrace);
  sessionMenuWrap.append(btnSessionMenu, sessionMenu);

  const btnRemove = el('button', 'btn-action btn-remove visible');
  btnRemove.append(createLineIcon(CLOSE_ICON_PATH));
  btnRemove.type = 'button';
  btnRemove.title = 'Remove session';
  btnRemove.setAttribute('aria-label', 'Remove session');

  const btnPlan = el('button', 'btn-action btn-face-plan', 'Plan');
  btnPlan.type = 'button';
  btnPlan.title = 'Show plan';

  const btnDocs = el('button', 'btn-action btn-face-plan btn-docs', 'Docs');
  btnDocs.type = 'button';
  btnDocs.title = 'Open docs the agent surfaced';

  const faceTabs = el('div', 'card-face-tabs');
  faceTabs.setAttribute('role', 'tablist');
  faceTabs.setAttribute('aria-label', 'Card view');
  const btnTerminalTab = el('button', 'card-face-tab');
  btnTerminalTab.type = 'button';
  btnTerminalTab.title = 'Terminal';
  btnTerminalTab.setAttribute('aria-label', 'Terminal');
  btnTerminalTab.append(createLineIcon(TERMINAL_ICON_PATH), el('span', 'card-face-tab-label', 'Terminal'));
  btnTerminalTab.setAttribute('role', 'tab');
  const btnShownTab = el('button', 'card-face-tab card-face-tab-shown');
  btnShownTab.type = 'button';
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
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Link pull request' });
  const hint = el('p', 'dialog-message', 'Paste a GitHub pull request URL or owner/repo#number.');
  const input = el('input', 'dialog-input');
  input.type = 'text';
  input.placeholder = 'owner/repo#123';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Pull request URL or owner/repo#number');
  const errorEl = el('div', 'dialog-error');
  errorEl.setAttribute('role', 'alert');
  const linkedPrsEl = el('div', 'session-pr-chips dialog-linked-prs');
  linkedPrsEl.hidden = true;
  paintLinkedPrs?.(linkedPrsEl, sessionId);
  const btnLink = el('button', 'btn-dialog btn-dialog-confirm', 'Link');
  btnLink.type = 'button';
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

export function paintCardOwnership(card: HTMLElement, ownershipText: string | null) {
  const ownershipEl = card.querySelector<HTMLElement>('.session-ownership');
  if (!ownershipEl) return;
  writeTextIfChanged(ownershipEl, ownershipText ?? '');
  writeHiddenIfChanged(ownershipEl, ownershipText === null);
}

export function paintTaskTitle(titleEl: HTMLElement, taskTitle: string | null | undefined) {
  titleEl.title = taskTitle ?? '';
  if (taskTitle) titleEl.removeAttribute('aria-label');
  if (!taskTitle) titleEl.setAttribute('aria-label', 'Describe the task');
  if (titleEl.querySelector('input')) return;
  titleEl.textContent = taskTitle ?? '';
}

export function startInlineTitleEdit(ui: SessionUi, sessionId: string) {
  const targetEl = ui.titleTargetEl?.isConnected ? ui.titleTargetEl : ui.taskTitleEl;
  if (targetEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.setAttribute('aria-label', 'Task');
  input.value = ui.taskTitleIsCustom ? ui.taskTitle ?? '' : '';
  input.placeholder = ui.taskTitle ?? 'What is this session working on?';
  input.maxLength = TASK_TITLE_MAX_LENGTH;
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
    if (shouldCommit) sendSessionAction(ui, { type: 'set-session-title', id: sessionId, title: input.value.trim() });
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

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}

const RENAME_INPUT_CLASS = 'session-rename-input';

export function isRenameInProgress(targetEl: Element | null | undefined) {
  return !!targetEl?.querySelector(`.${RENAME_INPUT_CLASS}`);
}

export function startInlineRename(ui: SessionUi, sessionId: string, { returnsFocusToTerminal = true } = {}) {
  const targetEl = ui.renameTargetEl?.isConnected ? ui.renameTargetEl : ui.nameEl;
  if (!targetEl || isRenameInProgress(targetEl)) return;

  const nameBeforeEdit = ui.card?.dataset.session ?? targetEl.textContent ?? '';

  const input = document.createElement('input');
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


function buildDebugCloseButton() {
  const button = el('button', 'debug-close');
  button.type = 'button';
  button.title = 'Close';
  button.setAttribute('aria-label', 'Close debug overlay');
  button.append(createLineIcon(CLOSE_ICON_PATH));
  return button;
}

function formatTimestamp(ts: number | undefined) {
  if (!ts) return '-';
  return localClockText(new Date(ts));
}

function formatSeconds(ms: number | undefined) {
  return `${(Number(ms || 0) / 1000).toFixed(1)}s`;
}

interface DecisionEntry {
  ts?: number;
  kind?: string;
  signal?: string;
  source?: string;
  action?: string;
  event?: string;
  active?: number;
  decision?: string;
  quietMs?: number;
  repeats?: number;
  category?: string;
  from?: string;
  to?: string;
  reason?: string;
}

interface TransitionDetail {
  signal?: string;
  source?: string;
  deferred?: boolean;
}

interface DebugStatePayload {
  state: string;
  transitions: { timestamp?: number; from: string; to: string; event: string; detail?: TransitionDetail | null }[];
  detection?: {
    lastSignal?: { signal?: string; source?: string; confidence?: string } | null;
    hooksInjected?: boolean;
    hookSeen?: boolean;
    titleState?: { lastKind?: string; hasSeenSpinner?: boolean } | null;
    agents?: { active?: number; counted?: number; declared?: number; idleNames?: number; idleTasks?: number } | null;
    gate?: { heldForMs?: number; seq?: number; lastActivitySeq?: number } | null;
  } | null;
  decisions?: DecisionEntry[];
}

function gateEvidence(d: DecisionEntry) {
  if (d.decision === 'gated') return `(${Number(d.active) || 0} bg)`;
  if (d.decision === 'wait' || d.decision === 'release') return `(quiet ${formatSeconds(d.quietMs)})`;
  return '';
}

function formatDecision(d: DecisionEntry) {
  const at = `<span class="debug-dim">${formatTimestamp(d.ts)}</span>`;
  if (d.kind === 'signal') {
    const from = escapeMarkup([d.signal, d.source].filter(Boolean).join('/'));
    if (d.action === 'transition') return `${at} ${from} → <span class="debug-label">${escapeMarkup(d.event || '')}</span>`;
    if (d.action === 'gate-held') return `${at} ${from} → held <span class="debug-dim">(${Number(d.active) || 0} bg)</span>`;
    return `${at} ${from} → <span class="debug-dim">no-op</span>`;
  }
  if (d.kind === 'gate') {
    const repeats = (d.repeats ?? 0) > 1 ? ` <span class="debug-dim">x${Number(d.repeats)}</span>` : '';
    const evidence = gateEvidence(d);
    const why = evidence ? ` <span class="debug-dim">${evidence}</span>` : '';
    return `${at} gate <span class="debug-label">${escapeMarkup(d.decision || '?')}</span>${why}${repeats}`;
  }
  if (d.kind === 'notify') {
    const what = escapeMarkup(d.category || d.to || '?');
    if (d.category) return `${at} notify <span class="debug-label">${what}</span>: fired`;
    return `${at} notify ${what}: <span class="debug-dim">silent (${escapeMarkup(d.reason || '')})</span>`;
  }
  if (d.kind === 'notify-state') {
    return `${at} notify ${escapeMarkup(d.category || '?')}: <span class="debug-dim">${escapeMarkup(d.from || '?')} → ${escapeMarkup(d.to || '?')}</span>`;
  }
  return `${at} <span class="debug-dim">${escapeMarkup(d.kind || 'decision')}</span>`;
}

function renderDebugOverlay(ui: SessionUi, payload: DebugStatePayload) {
  if (!ui.debugOverlay) return;
  const p = payload;

  let html = '';
  html += `<div class="debug-section"><div class="debug-section-title">State</div>`;
  html += `<div class="debug-field"><span class="debug-label">Current:</span> <span class="debug-value">${escapeMarkup(p.state)}</span></div>`;
  html += `</div>`;

  html += `<div class="debug-section"><div class="debug-section-title">Transitions (last ${p.transitions.length})</div>`;
  if (p.transitions.length === 0) {
    html += `<div class="debug-field debug-dim">No transitions recorded</div>`;
  }
  if (p.transitions.length > 0) {
    for (const t of p.transitions) {
      const d = t.detail && typeof t.detail === 'object' ? t.detail : null;
      const tagParts = d ? [d.signal, d.source, d.deferred ? 'deferred' : null].filter(Boolean) : [];
      const tag = tagParts.length > 0 ? ` <span class="debug-dim">${escapeMarkup(tagParts.join('/'))}</span>` : '';
      html += `<div class="debug-field"><span class="debug-dim">${formatTimestamp(t.timestamp)}</span> ${escapeMarkup(t.from)} → ${escapeMarkup(t.to)} <span class="debug-label">${escapeMarkup(t.event)}</span>${tag}</div>`;
    }
  }
  html += `</div>`;

  const det = p.detection || {};
  const ls = det.lastSignal;
  const ts = det.titleState || {};
  html += `<div class="debug-section"><div class="debug-section-title">Detection</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last signal:</span> <span class="debug-value">${ls ? `${escapeMarkup(ls.signal)} (${escapeMarkup(ls.source || '?')}${ls.confidence ? `/${escapeMarkup(ls.confidence)}` : ''})` : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hooks injected:</span> <span class="debug-value">${det.hooksInjected ? 'yes' : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hook seen:</span> <span class="debug-value">${det.hookSeen ? 'yes' : 'no (degraded → title)'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Title state:</span> <span class="debug-value">${escapeMarkup(ts.lastKind || 'none')}${ts.hasSeenSpinner ? ' · spun' : ''}</span></div>`;
  html += `</div>`;

  const agents = det.agents || {};
  const gate = det.gate;
  html += `<div class="debug-section"><div class="debug-section-title">Agents</div>`;
  html += `<div class="debug-field"><span class="debug-label">Active:</span> <span class="debug-value">${Number(agents.active) || 0} (counted ${Number(agents.counted) || 0}, declared ${Number(agents.declared) || 0})</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Idle:</span> <span class="debug-value">${Number(agents.idleNames) || 0} names, ${Number(agents.idleTasks) || 0} tasks</span></div>`;
  const gateText = gate
    ? `held ${formatSeconds(gate.heldForMs)} (seq ${Number(gate.seq) || 0}, lastActivity ${Number(gate.lastActivitySeq) || 0})`
    : 'none';
  html += `<div class="debug-field"><span class="debug-label">Gate:</span> <span class="debug-value">${escapeMarkup(gateText)}</span></div>`;
  html += `</div>`;

  const decisions = Array.isArray(p.decisions) ? p.decisions : [];
  html += `<div class="debug-section"><div class="debug-section-title">Decisions (last ${decisions.length})</div>`;
  if (decisions.length === 0) {
    html += `<div class="debug-field debug-dim">No decisions recorded</div>`;
  }
  for (const d of decisions) {
    html += `<div class="debug-field">${formatDecision(d)}</div>`;
  }
  html += `</div>`;

  ui.debugOverlay.innerHTML = html;
  ui.debugOverlay.prepend(buildDebugCloseButton());
}

export function openDebugOverlay(ui: SessionUi, sessionId: string) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = '<div class="debug-field debug-dim">Loading...</div>';
  overlay.prepend(buildDebugCloseButton());
  ui.card.appendChild(overlay);
  ui.debugOverlay = overlay;
  ui.debugOpen = true;

  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.debug-close')) closeDebugOverlay(ui);
  });

  sendControlMsg({ type: 'debug-state', id: sessionId });
}

export function closeDebugOverlay(ui: SessionUi) {
  if (ui.debugOverlay) {
    ui.debugOverlay.remove();
    ui.debugOverlay = null;
  }
  ui.debugOpen = false;
}

function updateDebugVisibility() {
  for (const [, ui] of sessionUIs) {
    ui.btnDebug.classList.toggle('visible', _debugMode);
    ui.btnTrace.classList.toggle('visible', _debugMode);
    if (_debugMode) continue;
    if (ui.debugOpen) closeDebugOverlay(ui);
  }
}

export function handleDebugStateResponse(msg: Record<string, unknown>) {
  const ui = typeof msg.id === 'string' ? sessionUIs.get(msg.id) : undefined;
  if (!ui?.debugOpen) return;
  renderDebugOverlay(ui, msg.payload as DebugStatePayload);
}

export function handleDebugStateRefresh(sessionId: unknown) {
  const ui = findSessionUi(sessionId);
  if (!ui?.debugOpen) return;
  sendControlMsg({ type: 'debug-state', id: sessionId });
}
