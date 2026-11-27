import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import NodeWebSocket from 'ws';

import { createBackend } from '../server/backend/backend.ts';
import { ServerMessage } from '../shared/contracts/control-messages.ts';
import { SERVER_MESSAGE_CLASS } from '../shared/contracts/control/message-classes.ts';
import { closeSocket, dashboardClient, openRecordingSocket, openSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const SESSION_ID = 'reconnect-test-session';

const OVERSIZED_INPUT = 'x'.repeat(20000);

interface ControlFrame {
  type: string;
  id?: string;
  seq?: number;
  appliedSeq?: number;
  requestId?: string | null;
  ok?: boolean;
  sessions?: { id: string }[];
  settings?: Record<string, unknown>;
}

function withBackend(fn: (client: DashboardClient, configPath: string) => Promise<void>) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-reconnect-'));
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      projects: [{ id: SESSION_ID, name: 'reconnect probe', path: tmpDir }],
      teams: [], repoRoots: [],
    }, null, 2), 'utf8');
    const prevEnv = process.env.GLIMMERVOID_CONFIG;
    process.env.GLIMMERVOID_CONFIG = cfgPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);

    const client = await dashboardClient(boundPort(server));

    try {
      await fn(client, cfgPath);
    } finally {
      await settleBackendShutdown(backend);
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLIMMERVOID_CONFIG;
      if (prevEnv != null) process.env.GLIMMERVOID_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

const isSessionError = (m: ControlFrame) => m.type === 'session-error';

test('a control reconnect carrying a replay cursor connects and gets snapshot then replay', withBackend(async (client) => {
  const first = await openRecordingSocket<ControlFrame>(client, '/control');
  const snapshot = await waitForMessage(first.received, (m) => m.type === 'snapshot', 'the snapshot');
  assert.deepEqual(snapshot.sessions?.map((s) => s.id), [SESSION_ID]);

  const dataConnection = await openSocket(client, `/terminals/${SESSION_ID}?probe=1`);
  const dataCloseCode = new Promise<number>((resolve) => { dataConnection.once('close', (code: number) => resolve(code)); });

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const beforeCursor = await waitForMessage(first.received, isSessionError, 'the first session-error');
  assert.equal(beforeCursor.id, SESSION_ID, 'the query string never became part of the session id');
  assert.equal(typeof beforeCursor.seq, 'number');
  const cursorSeq = beforeCursor.seq ?? 0;

  dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
  const afterCursor = await waitForMessage(
    first.received,
    (m) => isSessionError(m) && (m.seq ?? 0) > cursorSeq,
    'a session-error past the cursor',
  );

  await closeSocket(first.ws);

  const reconnected = await openRecordingSocket<ControlFrame>(client, `/control?since=${cursorSeq}`);
  const replayedError = await waitForMessage(reconnected.received, isSessionError, 'the replayed session-error');
  const reconnectSnapshot = reconnected.received[0];
  assert.equal(reconnectSnapshot.type, 'snapshot', 'the snapshot is still the first frame of a reconnect');
  assert.equal(typeof reconnectSnapshot.seq, 'number', 'the reconnect snapshot carries a seq');
  assert.equal(typeof replayedError.seq, 'number', 'the replayed session-error carries a seq');
  assert.ok((replayedError.seq ?? 0) > (reconnectSnapshot.seq ?? 0), 'the replayed frame seq advances past the reconnect snapshot so the client never drops it');
  assert.ok((replayedError.seq ?? 0) > (afterCursor.seq ?? 0), 'the replayed frame carries a fresh seq past the original broadcast');
  assert.equal(reconnected.received.filter(isSessionError).length, 1, 'the entry at the cursor is not replayed again');

  const secondCursorSeq = replayedError.seq ?? 0;
  await closeSocket(reconnected.ws);

  const reconnectedAgain = await openRecordingSocket<ControlFrame>(client, `/control?since=${secondCursorSeq}`);
  await waitForMessage(reconnectedAgain.received, (frame) => frame.type === 'client-trust', 'the second reconnect connect frames');
  assert.equal(reconnectedAgain.received.filter(isSessionError).length, 0, 'reconnecting past the replayed seq does not double the replayed frame');

  await closeSocket(reconnectedAgain.ws);
  await closeSocket(dataConnection);
  assert.notEqual(await dataCloseCode, 1008, 'the data socket was never refused as an unknown session');
}));

function assertStrictlyIncreasingSeqs(frames: readonly ControlFrame[], label: string): number[] {
  const seqs: number[] = [];
  for (const frame of frames) {
    const messageClass = SERVER_MESSAGE_CLASS[frame.type as keyof typeof SERVER_MESSAGE_CLASS];
    if (messageClass === 'collection') {
      const parsed = ServerMessage.safeParse(frame);
      assert.equal(parsed.success, true, `${label}: ${frame.type} failed ServerMessage schema (${parsed.error?.issues[0]?.message ?? 'invalid'})`);
    }
    if (typeof frame.seq !== 'number') continue;
    const previous = seqs.at(-1) ?? 0;
    assert.ok(frame.seq > previous, `${label}: ${frame.type} seq ${frame.seq} must exceed prior seq ${previous}`);
    seqs.push(frame.seq);
  }
  return seqs;
}

test('two control sockets each see strictly increasing seq across snapshots, broadcasts, and unicast collection pushes', withBackend(async (client) => {
  const first = await openRecordingSocket<ControlFrame>(client, '/control');
  await waitForMessage(first.received, (frame) => frame.type === 'client-trust', 'first socket connect frames');
  const second = await openRecordingSocket<ControlFrame>(client, '/control');
  await waitForMessage(second.received, (frame) => frame.type === 'client-trust', 'second socket connect frames');

  first.ws.send(JSON.stringify({ type: 'request-health-snapshot' }));
  await waitForMessage(first.received, (frame) => frame.type === 'health-snapshot', 'unicast health-snapshot on first socket');

  first.ws.send(JSON.stringify({ type: 'rename-session', requestId: 'rename-1', id: SESSION_ID, newName: 'renamed probe' }));
  const renamedOnFirst = await waitForMessage(first.received, (frame) => frame.type === 'session-renamed', 'broadcast session-renamed on first socket');
  const renameReply = await waitForMessage(first.received, (frame) => frame.type === 'session-action-result' && frame.requestId === 'rename-1', 'rename-session reply on first socket');
  await waitForMessage(second.received, (frame) => frame.type === 'session-renamed', 'broadcast session-renamed on second socket');

  const renamedIndex = first.received.indexOf(renamedOnFirst);
  const replyIndex = first.received.indexOf(renameReply);
  assert.ok(renamedIndex >= 0 && replyIndex > renamedIndex, 'collection push frame precedes the mutating reply frame on the wire');
  assert.equal(renameReply.ok, true);
  assert.equal(renameReply.appliedSeq, renamedOnFirst.seq, 'mutating reply appliedSeq equals the preceding collection push seq');

  const firstSeqs = assertStrictlyIncreasingSeqs(first.received, 'first socket');
  const secondSeqs = assertStrictlyIncreasingSeqs(second.received, 'second socket');
  assert.ok(firstSeqs.length >= 3, 'first socket received multiple stamped collection frames');
  assert.ok(secondSeqs.length >= 3, 'second socket received multiple stamped collection frames');

  await closeSocket(first.ws);
  await closeSocket(second.ws);
}));

test('a data socket whose id does not exist is still refused', withBackend(async (client) => {
  const ws = await openSocket(client, '/terminals/no-such-session?probe=1');
  const code = await new Promise<number>((resolve) => { ws.once('close', (closeCode: number) => resolve(closeCode)); });
  assert.equal(code, 1008);
}));

interface ChatSendResultFrame extends ControlFrame {
  requestId?: string | null;
  acceptedAt?: number;
}

test('a request resent under the same requestId on a new control socket gets the first answer instead of running again', withBackend(async (client) => {
  const repeatedRequestId = 'chat-send-page-1';
  const isRepeatedAnswer = (frame: ChatSendResultFrame) => frame.type === 'chat-send-result' && frame.requestId === repeatedRequestId;
  const first = await openRecordingSocket<ChatSendResultFrame>(client, '/control');
  first.ws.send(JSON.stringify({ type: 'chat-send', requestId: repeatedRequestId, id: SESSION_ID, text: 'hello', attachments: [] }));
  const firstAnswer = await waitForMessage(first.received, isRepeatedAnswer, 'the first chat-send answer');
  await closeSocket(first.ws);

  const second = await openRecordingSocket<ChatSendResultFrame>(client, '/control');
  second.ws.send(JSON.stringify({ type: 'chat-send', requestId: repeatedRequestId, resent: true, id: 'another-session', text: 'hello', attachments: [] }));
  const resentAnswer = await waitForMessage(second.received, isRepeatedAnswer, 'the resent chat-send answer');
  await closeSocket(second.ws);

  assert.equal(resentAnswer.id, SESSION_ID, 'the handler did not run again for the resent request');
  assert.equal(resentAnswer.acceptedAt, firstAnswer.acceptedAt);
  assert.equal(typeof firstAnswer.appliedSeq, 'number', 'first mutating reply carries appliedSeq');
  assert.ok((firstAnswer.appliedSeq ?? 0) > 0, 'first mutating reply appliedSeq reflects the sent stream');
  assert.equal(resentAnswer.appliedSeq, firstAnswer.appliedSeq, 'replayed reply preserves the original appliedSeq');
}));

type HandshakeDropPoint = 'after-snapshot' | 'after-client-trust' | 'during-replay';

const HANDSHAKE_DROP_POINTS: readonly HandshakeDropPoint[] = ['after-snapshot', 'after-client-trust', 'during-replay'];

for (const dropPoint of HANDSHAKE_DROP_POINTS) {
  test(`dropping a reconnecting control client ${dropPoint} loses and doubles zero replayable frames`, async (testContext) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `glimmervoid-drop-${dropPoint}-`));
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      projects: [{ id: SESSION_ID, name: 'drop probe', path: tmpDir }],
      teams: [], repoRoots: [],
    }, null, 2), 'utf8');
    const previousConfigPath = process.env.GLIMMERVOID_CONFIG;
    process.env.GLIMMERVOID_CONFIG = configPath;

    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null });
    server.on('request', backend.app);
    await listenOnLoopback(server);

    const port = boundPort(server);
    const origin = `http://127.0.0.1:${port}`;
    const realFetch = globalThis.fetch;
    const previousGlobals = { location: Reflect.get(globalThis, 'location'), fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    Object.assign(globalThis, {
      location: new URL(`${origin}/`),
      fetch: (input: string, init?: RequestInit) => realFetch(new URL(input, origin), { ...init, headers: { origin } }),
      WebSocket: class extends NodeWebSocket {
        constructor(url: string) {
          super(url, { origin });
        }
      },
    });

    const control = await import(`../public/control-ws.ts?drop=${dropPoint}`);
    const wsToken = await import('../public/ws-token.ts');
    wsToken.clearPageToken();
    const observerClient = await dashboardClient(port);
    const dataConnection = await openSocket(observerClient, `/terminals/${SESSION_ID}?probe=1`);
    const observer = await openRecordingSocket<ControlFrame>(observerClient, '/control');

    testContext.after(async () => {
      control.abandonControlSocket();
      Object.assign(globalThis, previousGlobals);
      await closeSocket(observer.ws);
      await closeSocket(dataConnection);
      await settleBackendShutdown(backend);
      server.closeAllConnections();
      await closeServer(server);
      if (previousConfigPath == null) delete process.env.GLIMMERVOID_CONFIG;
      if (previousConfigPath != null) process.env.GLIMMERVOID_CONFIG = previousConfigPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const deliveredTimestamps: number[] = [];
    let shouldDropOnNextMatch = false;
    let hasDroppedOnce = false;

    control.onControlMessage((message: { type: string; timestamp?: number }) => {
      if (message.type === 'session-error' && typeof message.timestamp === 'number') {
        deliveredTimestamps.push(message.timestamp);
      }
      if (!shouldDropOnNextMatch || hasDroppedOnce) return;
      const matchesDropPoint = (dropPoint === 'after-snapshot' && message.type === 'snapshot')
        || (dropPoint === 'after-client-trust' && message.type === 'client-trust')
        || (dropPoint === 'during-replay' && message.type === 'session-error');
      if (!matchesDropPoint) return;
      hasDroppedOnce = true;
      shouldDropOnNextMatch = false;
      control.replaceControlSocket();
    });

    control.connectControl();
    assert.equal(await control.probeControl(5000, false), true, 'initial control socket connects');

    dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
    const baselineError = await waitForMessage(observer.received, isSessionError, 'baseline session-error');
    const baselineTimestamp = (baselineError as { timestamp?: number }).timestamp ?? 0;
    await waitForMessage(deliveredTimestamps, (ts) => ts === baselineTimestamp, 'client received baseline session-error');

    control.abandonControlSocket();

    await new Promise((resolve) => setTimeout(resolve, 5));
    dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
    const missedFirst = await waitForMessage(
      observer.received,
      (frame) => isSessionError(frame) && (frame.seq ?? 0) > (baselineError.seq ?? 0),
      'first missed session-error',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    dataConnection.send(JSON.stringify({ type: 'input', data: OVERSIZED_INPUT }));
    const missedSecond = await waitForMessage(
      observer.received,
      (frame) => isSessionError(frame) && (frame.seq ?? 0) > (missedFirst.seq ?? 0),
      'second missed session-error',
    );
    const expectedMissedTimestamps = [
      (missedFirst as { timestamp?: number }).timestamp ?? 0,
      (missedSecond as { timestamp?: number }).timestamp ?? 0,
    ];

    shouldDropOnNextMatch = true;
    control.connectControl();

    const deadline = Date.now() + 5000;
    while (!hasDroppedOnce && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(hasDroppedOnce, true, `handshake dropped at ${dropPoint}`);
    assert.equal(await control.probeControl(5000, false), true, 'control socket recovers after mid-handshake drop');

    const missedDelivered = deliveredTimestamps.filter((ts) => ts !== baselineTimestamp);
    assert.deepEqual(
      missedDelivered,
      expectedMissedTimestamps,
      `${dropPoint}: expected every missed session-error once without loss or duplication`,
    );

    control.replaceControlSocket();
    assert.equal(await control.probeControl(5000, false), true, 'same-process reconnect after replay completes');
    assert.deepEqual(
      deliveredTimestamps.filter((ts) => ts !== baselineTimestamp),
      expectedMissedTimestamps,
      `${dropPoint}: subsequent reconnect past replay must not double already-delivered frames`,
    );
  });
}
