import { byteSizeText, twoUnitDurationText } from '#shared/display-text.ts';
import { sendControlMsg } from './control-ws.ts';
import { escapeMarkup } from '#shared/escape-markup.ts';
import { el } from './dom-helpers.ts';
import { anomalyCount, shouldShowHealthMonitor } from './health-monitor-core.ts';
import type { HealthAnomalies } from './health-monitor-core.ts';

const STATE_ABBREV: Record<string, string> = {
  DORMANT: 'DOR', INITIALIZING: 'INI', STARTING: 'STA',
  RUNNING: 'RUN', WAITING: 'WAI', IDLE: 'IDL',
  COMPLETE: 'CMP', DONE: 'DON', FAILED: 'FAI',
};

interface HealthSession {
  name: string;
  state: string;
  hasPty: boolean;
  ptyPid: number | null;
  outputBufferBytes: number;
  outputBufferEntries: number;
  dataListenerCount: number;
  destroyed: boolean;
  pendingRestart: boolean;
  timers: Record<string, unknown>;
}

export interface HealthSnapshot {
  uptimeSeconds: number;
  process: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    activeResources: number;
  };
  sessions: {
    total: number;
    alivePty: number;
    totalDataListeners: number;
    totalOutputBufferBytes: number;
    list: HealthSession[];
  };
  memoryGate?: { headroomBytes: number | null; headroomReadAtMs: number | null; heldStartCount: number };
  websockets: { control: number; data: number; dataPerSessionTotal: number };
  anomalies: HealthAnomalies;
}

let _latest: HealthSnapshot | null = null;
let _debugModeEnabled = false;
let _expanded = false;
let _root: HTMLDivElement | null = null;
let _statsEl: HTMLElement | null = null;
let _detailEl: HTMLDivElement | null = null;

const NO_VALUE = String.fromCharCode(0x2014);

function formatBytes(n: number | null | undefined) {
  if (n == null) return NO_VALUE;
  return byteSizeText(n, 'GB');
}

function formatUptime(s: number | null | undefined) {
  if (s == null) return NO_VALUE;
  return twoUnitDurationText(s, { smallestUnit: 's', dropsZeroRemainder: false });
}

function formatReadAge(readAtMs: number | null | undefined) {
  if (readAtMs == null) return NO_VALUE;
  return `${formatUptime(Math.max(0, Math.round((Date.now() - readAtMs) / 1000)))} ago`;
}

function buildPanel() {
  const root = el('div', 'health-footer');
  root.dataset.expanded = 'false';

  root.hidden = true;

  const summary = el('div', 'health-summary');
  const toggle = el('button', 'health-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'health-detail');
  const chevron = el('span', 'health-chev', '\u25b2');
  chevron.setAttribute('aria-hidden', 'true');
  toggle.append(chevron, el('span', 'health-toggle-label', 'Health'));
  const stats = el('div', 'health-stats');
  summary.append(toggle, stats);

  const detail = el('div', 'health-detail');
  detail.id = 'health-detail';
  detail.hidden = true;

  toggle.addEventListener('click', () => {
    _expanded = !_expanded;
    root.dataset.expanded = String(_expanded);
    toggle.setAttribute('aria-expanded', String(_expanded));
    detail.hidden = !_expanded;
    if (_expanded) {
      sendControlMsg({ type: 'request-health-snapshot' });
      renderDetail();
    }
  });

  root.append(summary, detail);
  _root = root;
  _statsEl = stats;
  _detailEl = detail;
  return root;
}

function renderSummary() {
  if (!_statsEl || !_latest) return;
  const s = _latest;
  const anomalies = anomalyCount(s.anomalies);
  _statsEl.innerHTML = `
    <span class="health-stat" title="V8 heap used"><span class="health-stat-label">Heap</span> ${formatBytes(s.process.heapUsed)}</span>
    <span class="health-stat" title="Resident set size (process memory)"><span class="health-stat-label">RSS</span> ${formatBytes(s.process.rss)}</span>
    <span class="health-stat" title="External buffers (PTY data lives here)"><span class="health-stat-label">Ext</span> ${formatBytes(s.process.external)}</span>
    <span class="health-stat" title="Active resources (handles + requests)"><span class="health-stat-label">Hdl</span> ${s.process.activeResources}</span>
    <span class="health-stat" title="Memory headroom at the last start check, and starts held for memory"><span class="health-stat-label">Mem</span> ${formatBytes(s.memoryGate?.headroomBytes)} / ${s.memoryGate?.heldStartCount ?? 0} held</span>
    <span class="health-stat" title="Sessions: alivePty / total"><span class="health-stat-label">Sess</span> ${s.sessions.alivePty}/${s.sessions.total}</span>
    <span class="health-stat" title="WebSockets: control + data"><span class="health-stat-label">WS</span> ${s.websockets.control}+${s.websockets.data}</span>
    <span class="health-stat" title="Server uptime"><span class="health-stat-label">Up</span> ${formatUptime(s.uptimeSeconds)}</span>
    ${anomalies > 0 ? `<span class="health-anomaly" title="${anomalies} anomaly type(s), expand for details">⚠ ${anomalies}</span>` : ''}
  `;
}

function renderDetail() {
  if (!_detailEl || !_latest) return;
  const s = _latest;
  const p = s.process;
  const w = s.websockets;
  const sess = s.sessions;
  const a = s.anomalies;

  let anomaliesHtml = '';
  if (anomalyCount(a) > 0) {
    const lines: string[] = [];
    if (a.listenerMismatch) lines.push('Listener count mismatch: data WS listener leaked or missing');
    if (a.orphanPty) lines.push('Orphan PTY: session has live PTY but state is DONE/FAILED/DORMANT');
    if (a.destroyedReachable) lines.push('Destroyed session still reachable in sessions map');
    anomaliesHtml = `
      <div class="health-section health-section-warn">
        <div class="health-section-title">⚠ Anomalies</div>
        ${lines.map((l) => `<div class="health-row">${l}</div>`).join('')}
      </div>
    `;
  }

  const sessionRows = sess.list.map((sx) => {
    const flags: string[] = [];
    if (sx.destroyed) flags.push('destroyed');
    if (sx.pendingRestart) flags.push('pendingRestart');
    const timers = Object.entries(sx.timers).filter(([, v]) => v).map(([k]) => k).join(',') || 'none';
    return `
      <tr>
        <td>${escapeMarkup(sx.name)}</td>
        <td class="health-mono">${STATE_ABBREV[sx.state] || sx.state}</td>
        <td class="health-mono">${sx.hasPty ? sx.ptyPid : NO_VALUE}</td>
        <td class="health-mono">${formatBytes(sx.outputBufferBytes)}</td>
        <td class="health-mono">${sx.outputBufferEntries}</td>
        <td class="health-mono">${sx.dataListenerCount}</td>
        <td class="health-mono health-dim">${timers}</td>
        <td class="health-mono health-dim">${flags.join(' ') || ''}</td>
      </tr>
    `;
  }).join('');

  _detailEl.innerHTML = `
    ${anomaliesHtml}
    <div class="health-section">
      <div class="health-section-title">Process</div>
      <div class="health-grid">
        <div class="health-row"><span class="health-label">Heap used</span><span class="health-mono">${formatBytes(p.heapUsed)}</span></div>
        <div class="health-row"><span class="health-label">Heap total</span><span class="health-mono">${formatBytes(p.heapTotal)}</span></div>
        <div class="health-row"><span class="health-label">RSS</span><span class="health-mono">${formatBytes(p.rss)}</span></div>
        <div class="health-row"><span class="health-label">External</span><span class="health-mono">${formatBytes(p.external)}</span></div>
        <div class="health-row"><span class="health-label">Array buffers</span><span class="health-mono">${formatBytes(p.arrayBuffers)}</span></div>
        <div class="health-row"><span class="health-label">Active resources</span><span class="health-mono">${p.activeResources}</span></div>
        <div class="health-row"><span class="health-label">Uptime</span><span class="health-mono">${formatUptime(s.uptimeSeconds)}</span></div>
      </div>
    </div>

    <div class="health-section">
      <div class="health-section-title">Memory gate</div>
      <div class="health-grid">
        <div class="health-row"><span class="health-label">Headroom</span><span class="health-mono">${formatBytes(s.memoryGate?.headroomBytes)}</span></div>
        <div class="health-row"><span class="health-label">Read</span><span class="health-mono">${formatReadAge(s.memoryGate?.headroomReadAtMs)}</span></div>
        <div class="health-row"><span class="health-label">Starts held</span><span class="health-mono">${s.memoryGate?.heldStartCount ?? 0}</span></div>
      </div>
    </div>

    <div class="health-section">
      <div class="health-section-title">WebSockets</div>
      <div class="health-grid">
        <div class="health-row"><span class="health-label">Control clients</span><span class="health-mono">${w.control}</span></div>
        <div class="health-row"><span class="health-label">Data clients</span><span class="health-mono">${w.data}</span></div>
        <div class="health-row"><span class="health-label">Tracked per session</span><span class="health-mono">${w.dataPerSessionTotal}</span></div>
      </div>
    </div>

    <div class="health-section">
      <div class="health-section-title">Sessions (${sess.total} total · ${sess.alivePty} alive PTY)</div>
      <div class="health-row health-dim">Listeners ${sess.totalDataListeners} · Output buffer ${formatBytes(sess.totalOutputBufferBytes)}</div>
      <table class="health-table">
        <thead>
          <tr>
            <th>Name</th><th>State</th><th>PID</th><th>Buffer</th><th>Entries</th><th>Listeners</th><th>Timers</th><th>Flags</th>
          </tr>
        </thead>
        <tbody>${sessionRows || '<tr><td colspan="8" class="health-dim">No sessions</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function updateHealthMonitorVisibility() {
  if (!_root) return;
  const isVisible = shouldShowHealthMonitor(_debugModeEnabled, _latest?.anomalies);
  const wasHidden = _root.hidden;
  _root.hidden = !isVisible;
  if (isVisible && wasHidden && _latest) {
    renderSummary();
    if (_expanded) renderDetail();
  }
}

export function setHealthMonitorDebugMode(on: boolean) {
  _debugModeEnabled = on;
  updateHealthMonitorVisibility();
}

export function mountHealthMonitor(parent: HTMLElement) {
  if (_root) return _root;
  const panel = buildPanel();
  parent.appendChild(panel);
  updateHealthMonitorVisibility();
  return panel;
}

export function applyHealthSnapshot(stats: HealthSnapshot) {
  _latest = stats;
  updateHealthMonitorVisibility();
  if (!_root || _root.hidden) return;
  renderSummary();
  if (_expanded) renderDetail();
}
