import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

import { createBackendWebSockets } from '../server/backend-websockets.ts';
import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { createCustomAdapter } from '../session/adapters/custom.ts';
import { Session } from '../session/sessions.ts';
import { ASK_USER_QUESTION_TOOL_NAME } from '../shared/contracts/session.ts';
import type { PendingPromptDetail } from '../shared/contracts/session.ts';
import { STATES } from '../shared/states.ts';
import { capturingPty } from './helpers/fake-pty.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'a0000000-0000-4000-8000-0000000000f1';
const ARROW_DOWN = '\x1b[B';
const SGR_WHEEL_DOWN = '\x1b[<65;40;12M';
const FOCUS_IN = '\x1b[I';
const ESCAPE = '\x1b';
const WORKING_TITLE = `\x1b]0;${String.fromCodePoint(0x2802)} Claude Code\x07`;
const IDLE_TITLE = `\x1b]0;${String.fromCodePoint(0x2733)} Claude Code\x07`;

interface WaitingInputHarness {
  session: Session;
  ptyWrites: string[];
  acknowledgedIds: string[];
  sendInput: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

function waitUntil(isDone: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (isDone()) { resolve(); return; }
      if (Date.now() - startedAt > timeoutMs) { reject(new Error('timed out waiting for the session')); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function bootHarness(session: Session): Promise<WaitingInputHarness> {
  const ptyWrites: string[] = [];
  session.ptyProcess = capturingPty(ptyWrites);
  session._ptyAlive = true;
  const acknowledgedIds: string[] = [];
  const wireSessionEvents = createSessionEventWiring({
    configStore: { save: () => null },
    config: { projects: [] },
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: (id) => { acknowledgedIds.push(id); }, trigger: () => {} },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  wireSessionEvents(session);

  const webSockets = createBackendWebSockets({
    remote: { enabled: false, allowedOrigins: [] },
    remoteAuth: null,
    remoteListenerPort: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    tokenMatches: () => true,
    getSession: (id) => (id === SESSION_ID ? session : null),
    getVisionsLane: () => null,
    logger: { warn: () => {} },
  });
  webSockets.attachDataConnection();
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) => {
    webSockets.dataWss.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.dataWss.emit('connection', webSocket, request);
    });
  });
  await listenOnLoopback(server);
  const client = new WebSocket(`ws://127.0.0.1:${boundPort(server)}/terminals/${SESSION_ID}`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });

  const sendInput = async (data: string): Promise<void> => {
    const writesBefore = ptyWrites.length;
    client.send(JSON.stringify({ type: 'input', data }));
    await waitUntil(() => ptyWrites.length > writesBefore);
  };
  const close = async (): Promise<void> => {
    client.close();
    session.ptyProcess = null;
    session._ptyAlive = false;
    session.destroy();
    webSockets.dataWss.close();
    server.closeAllConnections();
    await closeServer(server);
  };
  return { session, ptyWrites, acknowledgedIds, sendInput, close };
}

function claudeCodeAtPermissionPrompt(promptDetail: PendingPromptDetail | undefined = undefined, titleBeforePrompt: string | null = null): Session {
  const session = new Session({ id: SESSION_ID, name: 'question lane', path: process.cwd() });
  session.state = STATES.RUNNING;
  if (titleBeforePrompt !== null) session._titleSource.feed(titleBeforePrompt);
  session.ingestHookSignal({ signal: 'awaiting-input', source: 'hook', event: 'PermissionRequest', promptKind: 'permission', promptDetail, ts: Date.now() });
  assert.equal(session.state, STATES.WAITING);
  return session;
}

function claudeCodeAtAskUserQuestion(): Session {
  return claudeCodeAtPermissionPrompt({ toolName: ASK_USER_QUESTION_TOOL_NAME, summary: '', isComplete: false, question: null });
}

test('a Claude Code card stays WAITING while the operator moves through the question, and the notification is acknowledged', async () => {
  const harness = await bootHarness(claudeCodeAtPermissionPrompt());
  try {
    await harness.sendInput(ARROW_DOWN);
    assert.equal(harness.session.state, STATES.WAITING);
    assert.equal(harness.session._pendingPromptKind, 'permission');
    assert.deepEqual(harness.acknowledgedIds, [SESSION_ID]);
  } finally {
    await harness.close();
  }
});

test('a touch scroll or focus report on a Claude Code question neither ends WAITING nor acknowledges', async () => {
  const harness = await bootHarness(claudeCodeAtPermissionPrompt());
  try {
    await harness.sendInput(SGR_WHEEL_DOWN);
    await harness.sendInput(FOCUS_IN);
    assert.equal(harness.session.state, STATES.WAITING);
    assert.deepEqual(harness.acknowledgedIds, []);
    assert.deepEqual(harness.ptyWrites, [SGR_WHEEL_DOWN, FOCUS_IN]);
  } finally {
    await harness.close();
  }
});

test('the title spinner after the question is answered moves the Claude Code card back to RUNNING', async () => {
  const harness = await bootHarness(claudeCodeAtAskUserQuestion());
  try {
    await harness.sendInput(ARROW_DOWN);
    await harness.sendInput('\r');
    assert.equal(harness.session.state, STATES.WAITING);
    harness.session._titleSource.feed(`\x1b]0;${String.fromCodePoint(0x2802)} Claude Code\x07`);
    assert.equal(harness.session.state, STATES.RUNNING);
  } finally {
    await harness.close();
  }
});

test('Escape at a Claude Code permission prompt leaves WAITING, and the idle title then completes the card', async () => {
  const harness = await bootHarness(claudeCodeAtPermissionPrompt(undefined, WORKING_TITLE));
  try {
    await harness.sendInput(ESCAPE);
    assert.equal(harness.session.state, STATES.RUNNING);
    harness.session._titleSource.feed(IDLE_TITLE);
    await waitUntil(() => harness.session.state === STATES.COMPLETE, 5000);
    assert.equal(harness.session.state, STATES.COMPLETE);
  } finally {
    await harness.close();
  }
});

test('a keystroke on a title-only agent card still ends WAITING', async () => {
  const adapter = createCustomAdapter({ id: 'opencode', label: 'OpenCode', command: 'opencode', args: [] });
  const session = new Session({ id: SESSION_ID, name: 'title lane', path: process.cwd(), adapter });
  session.state = STATES.WAITING;
  const harness = await bootHarness(session);
  try {
    await harness.sendInput(ARROW_DOWN);
    assert.equal(harness.session.state, STATES.RUNNING);
  } finally {
    await harness.close();
  }
});
