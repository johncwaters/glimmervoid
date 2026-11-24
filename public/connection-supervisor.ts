import { HANDSHAKE_DEADLINE_MS, decideConnectionActions } from './connection-supervisor-core.ts';
import type { ConnectionAction, ConnectionEvent, SupervisorState, TenantWakeStatus } from './connection-supervisor-core.ts';
import { abandonControlSocket, onControlSocketChange, probeControl, raceControlHandshake, readLastAdoptedHandshake, replaceControlSocket, reportDashboardTelemetry } from './control-ws.ts';
import { noteOutageStart, reportRecovery } from './reconnect-report-core.ts';
import type { Outage } from './reconnect-report-core.ts';
import { offlinePageKind } from './offline-page-kind-core.ts';
import { reportTerminalColors } from './terminal-color-report.ts';
import { startWakeTimeline, noteWakeMark, noteNetworkMark } from './wake-timeline.ts';
import { holdTerminalInputDuringWakeCheck, releaseHeldTerminalInput } from './session-card/terminal.ts';
import { closeEveryTerminalUntilShown, reconnectShownTerminals } from './session-card/terminal-data-socket.ts';
import { clock } from '#shared/clock.ts';
import { DOORMAN_WAKE_POLL_HEADER, DoormanWakeStatus } from '#shared/contracts/doorman.ts';

let supervisorState: SupervisorState = { isVisible: document.visibilityState === 'visible', isFrozen: false, isProbing: false, isReplacing: false, isCheckingWake: false, isTenantWaking: false };
let hiddenSinceMs = document.visibilityState === 'visible' ? null : clock.nowMs();
let heartbeatTimer: number | null = null;
let handshakeTimer: number | null = null;
let wakeCheckTimer: number | null = null;
let tenantWakingListener: (isWaking: boolean) => void = () => {};
let currentOutage: Outage | null = null;
let hasControlEverOpened = false;

async function readTenantWakeStatus(): Promise<TenantWakeStatus> {
  const response = await fetch('/', { headers: { accept: 'application/json', [DOORMAN_WAKE_POLL_HEADER]: '1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(HANDSHAKE_DEADLINE_MS) });
  if (response.status === 204) return 'awake';
  if (response.status !== 202) return 'unknown';
  return DoormanWakeStatus.safeParse(await response.json()).success ? 'waking' : 'unknown';
}

function checkTenantWake() {
  void readTenantWakeStatus().catch((): TenantWakeStatus => 'unknown').then((status) => dispatchConnectionEvent({ kind: 'tenant-wake-status', status }));
}

function scheduleWakeCheck(inMs: number) {
  if (wakeCheckTimer !== null) window.clearTimeout(wakeCheckTimer);
  wakeCheckTimer = window.setTimeout(() => {
    wakeCheckTimer = null;
    dispatchConnectionEvent({ kind: 'wake-check-due' });
  }, inMs);
}

function cancelHeartbeat() {
  if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleHeartbeat(inMs: number) {
  cancelHeartbeat();
  const dueAtMs = clock.nowMs() + inMs;
  heartbeatTimer = window.setTimeout(() => {
    heartbeatTimer = null;
    dispatchConnectionEvent({ kind: 'heartbeat-due', lateByMs: clock.nowMs() - dueAtMs });
  }, inMs);
}

function cancelHandshakeDeadline() {
  if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function runConnectionAction(action: ConnectionAction) {
  switch (action.kind) {
    case 'probe-control':
      void probeControl(action.deadlineMs, action.isAnnounced).then((isAnswered) => {
        dispatchConnectionEvent({ kind: isAnswered ? 'pong' : 'pong-missed' });
      });
      return;
    case 'replace-control':
      replaceControlSocket();
      return;
    case 'race-control':
      raceControlHandshake();
      return;
    case 'close-sockets':
      cancelHandshakeDeadline();
      abandonControlSocket();
      closeEveryTerminalUntilShown();
      return;
    case 'reconnect-shown-terminals':
      reconnectShownTerminals();
      return;
    case 'hold-input':
      holdTerminalInputDuringWakeCheck();
      return;
    case 'release-input':
      releaseHeldTerminalInput();
      return;
    case 'schedule-heartbeat':
      scheduleHeartbeat(action.inMs);
      return;
    case 'cancel-heartbeat':
      cancelHeartbeat();
      return;
    case 'check-tenant-wake':
      checkTenantWake();
      return;
    case 'schedule-wake-check':
      scheduleWakeCheck(action.inMs);
      return;
    case 'show-tenant-waking':
      tenantWakingListener(action.isWaking);
      return;
  }
}

function reportRecoveredOutage() {
  const outage = currentOutage;
  const adopted = readLastAdoptedHandshake();
  currentOutage = null;
  if (!outage || !adopted) return;
  reportDashboardTelemetry('dashboard_reconnected', reportRecovery(outage, adopted, clock.nowMs(), offlinePageKind(location.hostname)));
}

function dispatchConnectionEvent(event: ConnectionEvent) {
  const decision = decideConnectionActions(supervisorState, event);
  supervisorState = decision.state;
  if (hasControlEverOpened) currentOutage = noteOutageStart(currentOutage, event, decision.actions, clock.nowMs());
  if (event.kind === 'control-opened') {
    reportRecoveredOutage();
    hasControlEverOpened = true;
  }
  for (const action of decision.actions) runConnectionAction(action);
}

function noteVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    hiddenSinceMs = clock.nowMs();
    dispatchConnectionEvent({ kind: 'hidden' });
    return;
  }
  const hiddenForMs = hiddenSinceMs === null ? 0 : clock.nowMs() - hiddenSinceMs;
  hiddenSinceMs = null;
  startWakeTimeline('shown', hiddenForMs);
  dispatchConnectionEvent({ kind: 'shown', hiddenForMs });
}

function noteControlSocketChange(change: 'connecting' | 'opened' | 'closed') {
  cancelHandshakeDeadline();
  noteWakeMark(`control-${change}`);
  if (change === 'connecting') {
    handshakeTimer = window.setTimeout(() => {
      handshakeTimer = null;
      dispatchConnectionEvent({ kind: 'handshake-overdue' });
    }, HANDSHAKE_DEADLINE_MS);
    return;
  }
  if (change === 'opened') reportTerminalColors();
  dispatchConnectionEvent({ kind: change === 'opened' ? 'control-opened' : 'control-closed' });
}

function noteResume() {
  startWakeTimeline('resumed', hiddenSinceMs === null ? 0 : clock.nowMs() - hiddenSinceMs);
  dispatchConnectionEvent({ kind: 'resumed' });
}

function watchNetworkChanges() {
  const networkInformation: unknown = Reflect.get(navigator, 'connection');
  if (!(networkInformation instanceof EventTarget)) return;
  networkInformation.addEventListener('change', () => {
    noteNetworkMark('link');
    dispatchConnectionEvent({ kind: 'network-changed' });
  });
}

export function onTenantWakingChange(listener: (isWaking: boolean) => void) {
  tenantWakingListener = listener;
}

export function superviseConnection() {
  onControlSocketChange(noteControlSocketChange);
  document.addEventListener('visibilitychange', noteVisibilityChange);
  document.addEventListener('freeze', () => dispatchConnectionEvent({ kind: 'frozen' }));
  document.addEventListener('resume', noteResume);
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) dispatchConnectionEvent({ kind: 'frozen' });
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) noteResume();
  });
  window.addEventListener('online', () => {
    noteNetworkMark('online');
    dispatchConnectionEvent({ kind: 'network-changed' });
  });
  window.addEventListener('offline', () => noteNetworkMark('offline'));
  watchNetworkChanges();
}
