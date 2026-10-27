import { HANDSHAKE_DEADLINE_MS, decideConnectionActions } from './connection-supervisor-core.ts';
import type { ConnectionAction, ConnectionEvent, SupervisorState } from './connection-supervisor-core.ts';
import { abandonControlSocket, onControlSocketChange, probeControl, replaceControlSocket } from './control-ws.ts';
import { startWakeTimeline, noteWakeMark } from './wake-timeline.ts';
import { closeEveryTerminalUntilShown, holdTerminalInputDuringWakeCheck, reconnectShownTerminals, releaseHeldTerminalInput } from './session-card/terminal.ts';

let supervisorState: SupervisorState = { isVisible: document.visibilityState === 'visible', isFrozen: false, isProbing: false, isReplacing: false };
let hiddenSinceMs = document.visibilityState === 'visible' ? null : Date.now();
let heartbeatTimer: number | null = null;
let handshakeTimer: number | null = null;

function cancelHeartbeat() {
  if (heartbeatTimer !== null) window.clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleHeartbeat(inMs: number) {
  cancelHeartbeat();
  const dueAtMs = Date.now() + inMs;
  heartbeatTimer = window.setTimeout(() => {
    heartbeatTimer = null;
    dispatchConnectionEvent({ kind: 'heartbeat-due', lateByMs: Date.now() - dueAtMs });
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
  }
}

function dispatchConnectionEvent(event: ConnectionEvent) {
  const decision = decideConnectionActions(supervisorState, event);
  supervisorState = decision.state;
  for (const action of decision.actions) runConnectionAction(action);
}

function noteVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    hiddenSinceMs = Date.now();
    dispatchConnectionEvent({ kind: 'hidden' });
    return;
  }
  const hiddenForMs = hiddenSinceMs === null ? 0 : Date.now() - hiddenSinceMs;
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
  dispatchConnectionEvent({ kind: change === 'opened' ? 'control-opened' : 'control-closed' });
}

function noteResume() {
  startWakeTimeline('resumed', hiddenSinceMs === null ? 0 : Date.now() - hiddenSinceMs);
  dispatchConnectionEvent({ kind: 'resumed' });
}

function watchNetworkChanges() {
  const networkInformation: unknown = Reflect.get(navigator, 'connection');
  if (!(networkInformation instanceof EventTarget)) return;
  networkInformation.addEventListener('change', () => dispatchConnectionEvent({ kind: 'network-changed' }));
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
  window.addEventListener('online', () => dispatchConnectionEvent({ kind: 'network-changed' }));
  watchNetworkChanges();
}
