export const LONG_HIDE_MS = 10_000;
export const WAKE_PROBE_DEADLINE_MS = 1_500;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_DEADLINE_MS = 3_000;
export const HANDSHAKE_DEADLINE_MS = 2_000;
export const SUSPENSION_GAP_MS = 5_000;

export type ConnectionEvent =
  | { kind: 'shown'; hiddenForMs: number }
  | { kind: 'hidden' }
  | { kind: 'frozen' }
  | { kind: 'resumed' }
  | { kind: 'network-changed' }
  | { kind: 'heartbeat-due'; lateByMs: number }
  | { kind: 'pong' }
  | { kind: 'pong-missed' }
  | { kind: 'handshake-overdue' }
  | { kind: 'control-opened' }
  | { kind: 'control-closed' };

export type ConnectionAction =
  | { kind: 'probe-control'; deadlineMs: number; isAnnounced: boolean }
  | { kind: 'replace-control' }
  | { kind: 'close-sockets' }
  | { kind: 'reconnect-shown-terminals' }
  | { kind: 'hold-input' }
  | { kind: 'release-input' }
  | { kind: 'schedule-heartbeat'; inMs: number }
  | { kind: 'cancel-heartbeat' };

export interface SupervisorState {
  isVisible: boolean;
  isFrozen: boolean;
  isProbing: boolean;
  isReplacing: boolean;
}

interface Decision {
  state: SupervisorState;
  actions: ConnectionAction[];
}

const REPLACE_EVERYTHING: ConnectionAction[] = [{ kind: 'reconnect-shown-terminals' }, { kind: 'replace-control' }];

function replaceEverything(state: SupervisorState): Decision {
  if (state.isReplacing) return { state, actions: [] };
  return { state: { ...state, isReplacing: true }, actions: REPLACE_EVERYTHING };
}

function probe(state: SupervisorState, deadlineMs: number, isAnnounced: boolean): Decision {
  if (state.isProbing || state.isReplacing) return { state, actions: [] };
  const probeAction: ConnectionAction = { kind: 'probe-control', deadlineMs, isAnnounced };
  const actions: ConnectionAction[] = isAnnounced ? [{ kind: 'hold-input' }, probeAction] : [probeAction];
  return { state: { ...state, isProbing: true }, actions };
}

function heartbeatWhileVisible(state: SupervisorState): ConnectionAction[] {
  return state.isVisible ? [{ kind: 'schedule-heartbeat', inMs: HEARTBEAT_INTERVAL_MS }] : [];
}

export function decideConnectionActions(state: SupervisorState, event: ConnectionEvent): Decision {
  switch (event.kind) {
    case 'shown': {
      const shownState = { ...state, isVisible: true };
      if (event.hiddenForMs > LONG_HIDE_MS) return replaceEverything(shownState);
      return probe(shownState, WAKE_PROBE_DEADLINE_MS, true);
    }
    case 'hidden':
      return { state: { ...state, isVisible: false }, actions: [{ kind: 'cancel-heartbeat' }] };
    case 'frozen':
      return {
        state: { ...state, isFrozen: true, isProbing: false, isReplacing: false },
        actions: [{ kind: 'cancel-heartbeat' }, { kind: 'close-sockets' }],
      };
    case 'resumed':
      if (state.isFrozen) return { state: { ...state, isFrozen: false, isReplacing: true }, actions: REPLACE_EVERYTHING };
      return replaceEverything(state);
    case 'network-changed':
      if (!state.isVisible) return { state, actions: [] };
      return probe(state, HEARTBEAT_DEADLINE_MS, false);
    case 'heartbeat-due':
      if (!state.isVisible) return { state, actions: [] };
      if (event.lateByMs > SUSPENSION_GAP_MS) return replaceEverything(state);
      return probe(state, HEARTBEAT_DEADLINE_MS, false);
    case 'pong':
      if (state.isFrozen) return { state: { ...state, isProbing: false }, actions: [{ kind: 'release-input' }] };
      return { state: { ...state, isProbing: false }, actions: [{ kind: 'release-input' }, ...heartbeatWhileVisible(state)] };
    case 'pong-missed': {
      if (state.isFrozen) return { state: { ...state, isProbing: false }, actions: [{ kind: 'release-input' }] };
      const replaced = replaceEverything({ ...state, isProbing: false });
      return { state: replaced.state, actions: [...replaced.actions, { kind: 'release-input' }] };
    }
    case 'handshake-overdue':
      return { state: { ...state, isReplacing: true }, actions: [{ kind: 'replace-control' }] };
    case 'control-opened':
      return { state: { ...state, isReplacing: false }, actions: heartbeatWhileVisible(state) };
    case 'control-closed':
      return { state: { ...state, isReplacing: false }, actions: [{ kind: 'cancel-heartbeat' }] };
  }
}
