import { localClockText } from '#shared/display-text.ts';
import { sendControlMsg } from '../control-ws.ts';
import { escapeMarkup } from '#shared/escape-markup.ts';
import { el } from '../dom-helpers.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import type { SessionUi } from './card-registry.ts';
import { findSessionUi, sessionUIs } from './card-registry.ts';
import { button } from '../ui/button.ts';

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


function buildDebugCloseButton() {
  const closeSlot = el('div', 'debug-close');
  closeSlot.append(button({ variant: 'icon', size: 'small', label: 'Close debug overlay', icon: createLineIcon(CLOSE_ICON_PATH) }));
  return closeSlot;
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
