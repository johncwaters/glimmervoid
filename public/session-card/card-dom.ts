
import { TASK_TITLE_MAX_LENGTH } from '#shared/contracts/session.ts';
import { localClockText } from '#shared/display-text.ts';
import { STATES } from '#shared/states.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, escapeHtml } from '../dom-helpers.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import { showErrorToast } from './toast.ts';

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

interface TagBadgeSpec {
  cls: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
}

const TAG_BADGES: TagBadgeSpec[] = [
  { cls: 'agent-badge', title: 'Agent CLI this session supervises' },
  { cls: 'worktree-badge', text: 'worktree', title: 'Running in a linked git worktree', ariaLabel: 'Linked git worktree' },
  { cls: 'post-turn-badge', ariaHidden: true },
  { cls: 'usage-badge', title: 'Tokens and estimated API list-price cost for this conversation' },
  { cls: 'wakeup-badge' },
  { cls: 'prompt-badge', title: 'Waiting on a permission or input prompt' },
];

function buildTagBadge({ cls, text = '', title, ariaLabel, ariaHidden }: TagBadgeSpec) {
  const badge = el('span', cls, text);
  if (title) badge.title = title;
  if (ariaLabel) badge.setAttribute('aria-label', ariaLabel);
  if (ariaHidden) badge.setAttribute('aria-hidden', 'true');
  return badge;
}

export interface CardOptions {
  taskTitle?: string | null;
  taskTitleIsCustom?: boolean;
  skipPerms?: boolean;
  saneYolo?: boolean;
  worktree?: boolean;
  workspace?: boolean;
  path?: unknown;
  stateSince?: unknown;
}

function paintPermsBadge(permsBadge: HTMLElement, saneYolo: boolean) {
  permsBadge.textContent = saneYolo ? 'SANE YOLO' : 'YOLO';
  permsBadge.title = saneYolo
    ? 'Skips permission prompts; Sane YOLO blocks catastrophic commands'
    : 'Running with --dangerously-skip-permissions';
}

export function applyCardSaneYolo(card: HTMLElement, saneYolo: boolean) {
  if (saneYolo) card.dataset.saneYolo = '';
  if (!saneYolo) delete card.dataset.saneYolo;
  const permsBadge = card.querySelector<HTMLElement>('.perms-badge');
  if (permsBadge) paintPermsBadge(permsBadge, saneYolo);
}

export function setSessionSaneYolo(sessionId: unknown, saneYolo: boolean) {
  const ui = findSessionUi(sessionId);
  if (!ui) return;
  applyCardSaneYolo(ui.card, saneYolo);
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
  if (options.path) card.dataset.path = String(options.path);

  const header = el('div', 'session-card-header');

  const nameEl = el('span', 'session-name', sessionName);
  nameEl.title = 'Double-click or press F2 to rename';
  nameEl.tabIndex = 0;
  const permsBadge = options.skipPerms ? el('span', 'perms-badge') : null;
  if (permsBadge) paintPermsBadge(permsBadge, options.saneYolo === true);
  const taskTitleEl = el('span', 'session-task-title');
  paintTaskTitle(taskTitleEl, options.taskTitle);

  const elapsedEl = el('span', 'card-elapsed');
  elapsedEl.setAttribute('aria-hidden', 'true');

  const actions = el('div', 'session-actions');

  const restartMenuWrap = el('div', 'session-overflow');
  const btnRestartMenu = el('button', 'btn-action btn-restart-menu visible', String.fromCharCode(0x21bb));
  btnRestartMenu.type = 'button';
  btnRestartMenu.title = 'Restart';
  btnRestartMenu.setAttribute('aria-label', 'Restart');
  btnRestartMenu.setAttribute('aria-haspopup', 'menu');
  btnRestartMenu.setAttribute('aria-expanded', 'false');
  const restartMenu = el('div', 'session-overflow-menu');
  restartMenu.id = `restart-menu-${sessionId}`;
  restartMenu.setAttribute('role', 'menu');
  btnRestartMenu.setAttribute('aria-controls', restartMenu.id);

  const btnRestart = buildRestartMenuItem('Restart', 'Keeps this conversation', 'overflow-restart');
  const btnRestartFresh = buildRestartMenuItem('Restart fresh', 'Ends this conversation and starts a new one', 'overflow-restart-fresh');
  const btnResume = buildRestartMenuItem('Resume conversation...', 'Pick an earlier conversation', 'overflow-resume');
  restartMenu.append(btnRestart, btnRestartFresh, btnResume);
  restartMenuWrap.append(btnRestartMenu, restartMenu);

  const btnDebug = el('button', 'btn-action btn-debug', '\u2699');
  btnDebug.title = 'Debug state';
  btnDebug.setAttribute('aria-label', 'Debug session state');

  const btnTrace = el('button', 'btn-action btn-trace', String.fromCharCode(0x2261));
  btnTrace.type = 'button';
  btnTrace.title = 'Trace';
  btnTrace.setAttribute('aria-label', 'Trace');

  const btnRemove = el('button', 'btn-action btn-remove visible', String.fromCharCode(0xd7));
  btnRemove.type = 'button';
  btnRemove.title = 'Remove session';
  btnRemove.setAttribute('aria-label', 'Remove session');

  const btnPlan = el('button', 'btn-action btn-face-plan', 'Plan');
  btnPlan.type = 'button';
  btnPlan.title = 'Show plan';

  actions.append(btnPlan, btnDebug, btnTrace, restartMenuWrap, btnRemove);
  const tags = el('div', 'session-card-tags');
  const tagChildren = TAG_BADGES.map((spec) => buildTagBadge(spec));
  if (permsBadge) tagChildren.push(permsBadge);
  tags.append(...tagChildren);
  header.append(nameEl, elapsedEl, taskTitleEl, tags, actions);

  const termWrap = el('div', 'terminal-wrap');

  card.append(header, termWrap);

  return { card, header, nameEl, elapsedEl, taskTitleEl, btnRestart, btnRestartFresh, btnRestartMenu, btnResume, btnTrace, btnRemove, btnPlan, btnDebug, restartMenu, termWrap };
}

function buildRestartMenuItem(label: string, hint: string, className: string) {
  const button = el('button', `overflow-item ${className}`);
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-label', label);
  button.append(el('span', 'restart-menu-label', label), el('span', 'restart-menu-hint', hint));
  return button;
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
    if (shouldCommit) sendControlMsg({ type: 'set-session-title', id: sessionId, title: input.value.trim() });
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

export function startInlineRename(ui: SessionUi, sessionId: string) {
  const targetEl = ui.renameTargetEl?.isConnected ? ui.renameTargetEl : ui.nameEl;
  if (!targetEl || isRenameInProgress(targetEl)) return;

  const nameBeforeEdit = ui.card?.dataset.session ?? targetEl.textContent ?? '';

  function repaintName() {
    const name = ui.card?.dataset.session ?? nameBeforeEdit;
    targetEl.textContent = name;
    if (ui.nameEl && ui.nameEl !== targetEl) ui.nameEl.textContent = name;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = RENAME_INPUT_CLASS;
  input.value = nameBeforeEdit;
  input.maxLength = 64;

  targetEl.textContent = '';
  targetEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (!newName || newName === nameBeforeEdit) {
      repaintName();
      return;
    }
    for (const [, other] of sessionUIs) {
      if (other !== ui && other.card.dataset.session === newName) {
        repaintName();
        showErrorToast(`Session "${newName}" already exists.`);
        return;
      }
    }
    sendControlMsg({ type: 'rename-session', id: sessionId, newName });
    repaintName();
  }

  function cancel() {
    cleanup();
    repaintName();
  }

  function cleanup() {
    input.removeEventListener('blur', commit);
    input.removeEventListener('keydown', onKey);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', onKey);
}


const DEBUG_CLOSE_BTN = '<button type="button" class="debug-close" aria-label="Close debug overlay" title="Close">×</button>';

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
    const from = escapeHtml([d.signal, d.source].filter(Boolean).join('/'));
    if (d.action === 'transition') return `${at} ${from} → <span class="debug-label">${escapeHtml(d.event || '')}</span>`;
    if (d.action === 'gate-held') return `${at} ${from} → held <span class="debug-dim">(${Number(d.active) || 0} bg)</span>`;
    return `${at} ${from} → <span class="debug-dim">no-op</span>`;
  }
  if (d.kind === 'gate') {
    const repeats = (d.repeats ?? 0) > 1 ? ` <span class="debug-dim">x${Number(d.repeats)}</span>` : '';
    const evidence = gateEvidence(d);
    const why = evidence ? ` <span class="debug-dim">${evidence}</span>` : '';
    return `${at} gate <span class="debug-label">${escapeHtml(d.decision || '?')}</span>${why}${repeats}`;
  }
  if (d.kind === 'notify') {
    const what = escapeHtml(d.category || d.to || '?');
    if (d.category) return `${at} notify <span class="debug-label">${what}</span>: fired`;
    return `${at} notify ${what}: <span class="debug-dim">silent (${escapeHtml(d.reason || '')})</span>`;
  }
  if (d.kind === 'notify-state') {
    return `${at} notify ${escapeHtml(d.category || '?')}: <span class="debug-dim">${escapeHtml(d.from || '?')} → ${escapeHtml(d.to || '?')}</span>`;
  }
  return `${at} <span class="debug-dim">${escapeHtml(d.kind || 'decision')}</span>`;
}

function renderDebugOverlay(ui: SessionUi, payload: DebugStatePayload) {
  if (!ui.debugOverlay) return;
  const p = payload;

  let html = DEBUG_CLOSE_BTN;
  html += `<div class="debug-section"><div class="debug-section-title">State</div>`;
  html += `<div class="debug-field"><span class="debug-label">Current:</span> <span class="debug-value">${escapeHtml(p.state)}</span></div>`;
  html += `</div>`;

  html += `<div class="debug-section"><div class="debug-section-title">Transitions (last ${p.transitions.length})</div>`;
  if (p.transitions.length === 0) {
    html += `<div class="debug-field debug-dim">No transitions recorded</div>`;
  }
  if (p.transitions.length > 0) {
    for (const t of p.transitions) {
      const d = t.detail && typeof t.detail === 'object' ? t.detail : null;
      const tagParts = d ? [d.signal, d.source, d.deferred ? 'deferred' : null].filter(Boolean) : [];
      const tag = tagParts.length > 0 ? ` <span class="debug-dim">${escapeHtml(tagParts.join('/'))}</span>` : '';
      html += `<div class="debug-field"><span class="debug-dim">${formatTimestamp(t.timestamp)}</span> ${escapeHtml(t.from)} → ${escapeHtml(t.to)} <span class="debug-label">${escapeHtml(t.event)}</span>${tag}</div>`;
    }
  }
  html += `</div>`;

  const det = p.detection || {};
  const ls = det.lastSignal;
  const ts = det.titleState || {};
  html += `<div class="debug-section"><div class="debug-section-title">Detection</div>`;
  html += `<div class="debug-field"><span class="debug-label">Last signal:</span> <span class="debug-value">${ls ? `${escapeHtml(ls.signal)} (${escapeHtml(ls.source || '?')}${ls.confidence ? `/${escapeHtml(ls.confidence)}` : ''})` : 'none'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hooks injected:</span> <span class="debug-value">${det.hooksInjected ? 'yes' : 'no'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Hook seen:</span> <span class="debug-value">${det.hookSeen ? 'yes' : 'no (degraded → title)'}</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Title state:</span> <span class="debug-value">${escapeHtml(ts.lastKind || 'none')}${ts.hasSeenSpinner ? ' · spun' : ''}</span></div>`;
  html += `</div>`;

  const agents = det.agents || {};
  const gate = det.gate;
  html += `<div class="debug-section"><div class="debug-section-title">Agents</div>`;
  html += `<div class="debug-field"><span class="debug-label">Active:</span> <span class="debug-value">${Number(agents.active) || 0} (counted ${Number(agents.counted) || 0}, declared ${Number(agents.declared) || 0})</span></div>`;
  html += `<div class="debug-field"><span class="debug-label">Idle:</span> <span class="debug-value">${Number(agents.idleNames) || 0} names, ${Number(agents.idleTasks) || 0} tasks</span></div>`;
  const gateText = gate
    ? `held ${formatSeconds(gate.heldForMs)} (seq ${Number(gate.seq) || 0}, lastActivity ${Number(gate.lastActivitySeq) || 0})`
    : 'none';
  html += `<div class="debug-field"><span class="debug-label">Gate:</span> <span class="debug-value">${escapeHtml(gateText)}</span></div>`;
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
}

export function openDebugOverlay(ui: SessionUi, sessionId: string) {
  if (ui.debugOpen) { closeDebugOverlay(ui); return; }

  const overlay = document.createElement('div');
  overlay.className = 'debug-overlay';
  overlay.innerHTML = `${DEBUG_CLOSE_BTN}<div class="debug-field debug-dim">Loading...</div>`;
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
