
import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplayLog } from '../server/core/control-replay-core.ts';
import type { ReplayLog } from '../server/core/control-replay-core.ts';
import type { ControlConnection } from './helpers/control-harness.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';
import { plainSession } from './helpers/fake-session.ts';
import { STATES } from '../shared/states.ts';

interface DispatchFrame {
  type: string;
  seq?: number;
  n?: number;
  requestId?: string;
  serverBuild?: string | null;
}

function harness(): ControlConnection<DispatchFrame> {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<DispatchFrame>(server);
  connection.sent.length = 0;
  return connection;
}

test('inherited-key message types are ignored, not dispatched', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send({ type: '__proto__' }));
  assert.doesNotThrow(() => h.send({ type: 'constructor' }));
  assert.doesNotThrow(() => h.send({ type: 'hasOwnProperty' }));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('non-object payloads are ignored', () => {
  const h = harness();
  assert.doesNotThrow(() => h.send(null), 'a literal null frame must not crash the dispatch');
  assert.doesNotThrow(() => h.send(42));
  assert.doesNotThrow(() => h.send('kill'));
  assert.doesNotThrow(() => h.send(['type', 'kill']));
  assert.equal(h.sent.length, 0, 'nothing sent back');
});

test('ping with requestId replies pong on the requesting socket only', () => {
  const h = harness();
  h.send({ type: 'ping', requestId: 'r1' });
  assert.deepEqual(h.sent, [{ type: 'pong', requestId: 'r1' }]);
});

test('a completion-scoped dismiss arriving on a WAITING session leaves it WAITING, and an unscoped dismiss still answers it', () => {
  const session = plainSession('watched-session');
  session.state = STATES.WAITING;
  const server = createControlServer(controlDeps({ projects: [] }, { sessions: new Map([[session.id, session]]) }));
  const connection = connectControl<DispatchFrame>(server);
  try {
    connection.send({ type: 'dismiss', id: session.id, expectedState: STATES.COMPLETE });
    assert.equal(session.state, STATES.WAITING);
    connection.send({ type: 'dismiss', id: session.id });
    assert.equal(session.state, STATES.RUNNING);
  } finally {
    session.destroy();
  }
});

function harnessWithReplay(replayLog: ReplayLog) {
  const server = createControlServer(controlDeps({ projects: [] }, {
    broadcastControl: (msg) => { replayLog.stamp({ ...msg }); },
    controlReplayLog: replayLog,
  }));
  return {
    connect(url: string): DispatchFrame[] {
      const connection = connectControl<DispatchFrame>(server, { url });
      return connection.sent.filter((frame) => frame.type !== 'client-trust');
    },
  };
}

test('a reconnect with ?since replays only the missed replayable broadcasts, after the snapshot', () => {
  const replayLog = createReplayLog();
  const h = harnessWithReplay(replayLog);

  replayLog.stamp({ type: 'notify', message: 'hi' });
  replayLog.stamp({ type: 'session-changed', id: 'a' });

  const sent = h.connect('/control?since=0');
  assert.equal(sent.length, 2, 'snapshot then exactly one replayed notify');
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[1].type, 'notify');
});

test('a cached lane status replayed on connect carries no stale seq', () => {
  const replayLog = createReplayLog();
  const radarStatus = { type: 'radar-status', configured: true };
  const server = createControlServer(controlDeps({ projects: [] }, {
    broadcastControl: (msg) => { replayLog.stamp({ ...msg }); },
    controlReplayLog: replayLog,
    getRadarStatus: () => radarStatus,
  }));
  replayLog.stamp({ ...radarStatus });

  const { sent } = connectControl<DispatchFrame>(server, { url: '/control' });

  const replayed = sent.filter((m) => m.type === 'radar-status');
  assert.equal(replayed.length, 1, 'the cached lane status replays');
  for (const msg of replayed) assert.equal(msg.seq, undefined, `${msg.type} must be seq-less`);
});

test('the connect snapshot identifies the backend build it came from', () => {
  const server = createControlServer(controlDeps({ projects: [] }, { serverBuild: () => '0.22.0+deadbeef' }));
  const { sent } = connectControl<DispatchFrame>(server);
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].serverBuild, '0.22.0+deadbeef');
});

test('a caller that declares no build sends null rather than omitting the field', () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const { sent } = connectControl<DispatchFrame>(server);
  assert.equal(sent[0].serverBuild, null, 'an absent field would read as "unchanged" to the client');
});
