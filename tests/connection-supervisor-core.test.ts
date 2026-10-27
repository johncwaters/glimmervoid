import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_DEADLINE_MS, HEARTBEAT_INTERVAL_MS, LONG_HIDE_MS, SUSPENSION_GAP_MS, WAKE_PROBE_DEADLINE_MS, decideConnectionActions } from '../public/connection-supervisor-core.ts';
import type { ConnectionAction, ConnectionEvent, SupervisorState } from '../public/connection-supervisor-core.ts';

const settled: SupervisorState = { isVisible: true, isFrozen: false, isProbing: false, isReplacing: false };
const replaceEverything: ConnectionAction[] = [{ kind: 'replace-control' }, { kind: 'reconnect-shown-terminals' }];

const decisions: Array<{ name: string; state: SupervisorState; event: ConnectionEvent; actions: ConnectionAction[] }> = [
  { name: 'a long hide replaces without probing', state: { ...settled, isVisible: false }, event: { kind: 'shown', hiddenForMs: LONG_HIDE_MS + 1 }, actions: replaceEverything },
  { name: 'a short hide probes with input held', state: { ...settled, isVisible: false }, event: { kind: 'shown', hiddenForMs: 1000 }, actions: [{ kind: 'hold-input' }, { kind: 'probe-control', deadlineMs: WAKE_PROBE_DEADLINE_MS, isAnnounced: true }] },
  { name: 'a freeze closes every socket', state: settled, event: { kind: 'frozen' }, actions: [{ kind: 'cancel-heartbeat' }, { kind: 'close-sockets' }] },
  { name: 'a resume replaces even past a replace started while freezing', state: { ...settled, isFrozen: true, isReplacing: true }, event: { kind: 'resumed' }, actions: replaceEverything },
  { name: 'a probe that fails because a freeze closed its socket opens nothing', state: { ...settled, isFrozen: true, isProbing: true }, event: { kind: 'pong-missed' }, actions: [{ kind: 'release-input' }] },
  { name: 'a replace in flight absorbs the wake after a resume', state: { ...settled, isReplacing: true }, event: { kind: 'shown', hiddenForMs: LONG_HIDE_MS + 1 }, actions: [] },
  { name: 'an on-time heartbeat probes quietly', state: settled, event: { kind: 'heartbeat-due', lateByMs: 0 }, actions: [{ kind: 'probe-control', deadlineMs: HEARTBEAT_DEADLINE_MS, isAnnounced: false }] },
  { name: 'a heartbeat late past the gap replaces', state: settled, event: { kind: 'heartbeat-due', lateByMs: SUSPENSION_GAP_MS + 1 }, actions: replaceEverything },
  { name: 'a hidden page ignores its heartbeat and network changes', state: { ...settled, isVisible: false }, event: { kind: 'network-changed' }, actions: [] },
  { name: 'a pong releases input and schedules the next heartbeat', state: { ...settled, isProbing: true }, event: { kind: 'pong' }, actions: [{ kind: 'release-input' }, { kind: 'schedule-heartbeat', inMs: HEARTBEAT_INTERVAL_MS }] },
  { name: 'a missed pong replaces, then releases input', state: { ...settled, isProbing: true }, event: { kind: 'pong-missed' }, actions: [...replaceEverything, { kind: 'release-input' }] },
  { name: 'an overdue handshake replaces only the control socket', state: settled, event: { kind: 'handshake-overdue' }, actions: [{ kind: 'replace-control' }] },
];

test('the connection supervisor decides each lifecycle event', () => {
  for (const decision of decisions) {
    assert.deepEqual(decideConnectionActions(decision.state, decision.event).actions, decision.actions, decision.name);
  }
});
