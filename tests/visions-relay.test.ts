import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { build } from 'vite';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import {
  createParserState,
  feedFrameBytes,
  serializeFrame,
} from '../server/visions/core/visions-lsp-core.ts';
import {sendWsFrame, sendWsJson,
} from '../session/visions-relay.ts';
const RELAY_PATH = path.join(import.meta.dirname, '..', 'session', 'visions-relay.ts');
const TEST_TIMEOUT_MS = 6000;

type LspRecord = Record<string, unknown>;

interface RelayScenario {
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  initialSocket: WebSocket;
  relay: ReturnType<typeof startRelay>;
  restartDaemon: () => Promise<Awaited<ReturnType<typeof startDaemon>>>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDeferredQueue<T>() {
  const values: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) return waiter(value);
      values.push(value);
      return undefined;
    },
    next(label = 'timed out waiting for value'): Promise<T> {
      const value = values.shift();
      if (value) return Promise.resolve(value);
      return withTimeout(new Promise<T>((resolve) => { waiters.push(resolve); }), TEST_TIMEOUT_MS, label);
    },
    get size() { return values.length; },
  };
}

async function startDaemon(port = 0) {
  const messages = createDeferredQueue<LspRecord>();
  const connections = createDeferredQueue<WebSocket>();
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  await once(server, 'listening');

  server.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      messages.push(JSON.parse(data.toString('utf8')) as LspRecord);
    });
  });

  return {
    server,
    messages,
    connections,
    port: (server.address() as AddressInfo).port,
    close() {
      for (const client of server.clients) {
        client.close();
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startRelay(port: number, relayPath = RELAY_PATH) {
  const child = spawn(process.execPath, [relayPath, '--port', String(port)], {
    cwd: path.join(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutMessages = createDeferredQueue<LspRecord>();
  let parserState = createParserState();

  child.stdout?.on('data', (chunk: Buffer) => {
    const parsed = feedFrameBytes(parserState, chunk);
    parserState = parsed.state;
    for (const message of parsed.messages) {
      stdoutMessages.push(message as LspRecord);
    }
  });

  return { child, stdoutMessages };
}

function writeLsp(child: ChildProcess, message: unknown) {
  child.stdin?.write(serializeFrame(message));
}

function writeLspAsync(child: ChildProcess, message: unknown) {
  return new Promise<void>((resolve, reject) => {
    child.stdin?.write(serializeFrame(message), (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

function waitForStreamPattern(stream: Readable, pattern: RegExp) {
  let output = '';
  return withTimeout(new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!pattern.test(output)) return;
      stream.off('data', onData);
      resolve(output);
    };
    stream.on('data', onData);
  }), TEST_TIMEOUT_MS, `stream output did not match ${pattern}`);
}

test('sendWsJson routes through the shared websocket frame guard', () => {
  const sent: string[] = [];
  const openSocket = { readyState: WebSocket.OPEN, send: (frame: string) => { sent.push(frame); } };

  assert.equal(sendWsJson(openSocket, { type: 'lsp', method: 'textDocument/didSave' }), true);
  assert.deepEqual(sent, ['{"type":"lsp","method":"textDocument/didSave"}']);
  assert.equal(sendWsFrame({ readyState: WebSocket.CLOSED, send: () => { throw new Error('must not send'); } }, { send: true, serialized: 'ignored' }), false);
});

async function closeRelay(child: ChildProcess) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill();
  const [code] = await once(child, 'exit');
  return code;
}

async function runRelayScenario(fn: (scenario: RelayScenario) => Promise<void>) {
  let daemon = await startDaemon();
  const relay = startRelay(daemon.port);

  try {
    const initialSocket = await daemon.connections.next('relay did not connect to daemon');
    const relayReady = once(initialSocket, 'pong');
    initialSocket.ping();
    await withTimeout(relayReady, TEST_TIMEOUT_MS, 'relay did not complete the websocket handshake');
    await fn({ daemon, initialSocket, relay, restartDaemon: async () => {
      await daemon.close();
      daemon = await startDaemon(daemon.port);
      return daemon;
    } });
  } finally {
    await closeRelay(relay.child);
    await daemon.close().catch(() => {});
  }
}

test('a refused didChange closes its mirror and a later shrink reopens the full document', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    const uri = 'file:///resync.md';
    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'markdown', version: 1, text: 'small' },
      },
    });
    await daemon.messages.next('initial didOpen missing');

    await writeLspAsync(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: 'x'.repeat(2 * 1024 * 1024) }],
      },
    });
    const close = await daemon.messages.next('didClose after refused didChange missing');
    assert.deepEqual(close, {
      type: 'lsp', method: 'textDocument/didClose', params: { textDocument: { uri } },
    });

    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 3 },
        contentChanges: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          text: 'y',
        }],
      },
    });
    writeLsp(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 4 },
        contentChanges: [{ text: 'small again' }],
      },
    });

    const reopen = await daemon.messages.next('full didOpen after shrink missing');
    assert.deepEqual(reopen, {
      type: 'lsp',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'markdown', version: 4, text: 'small again' },
      },
    });
    assert.equal(daemon.messages.size, 0);
  });
});

test('an over-cap mirrored document is not transmitted and does not reconnect-loop', async () => {
  await runRelayScenario(async ({ daemon, relay }) => {
    const oversizedText = 'x'.repeat(2 * 1024 * 1024);
    await writeLspAsync(relay.child, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///oversized.md', languageId: 'markdown', version: 1, text: oversizedText,
        },
      },
    });
    const close = await daemon.messages.next('didClose after refused didOpen missing');
    assert.deepEqual(close, {
      type: 'lsp',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///oversized.md' } },
    });
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    assert.equal(daemon.messages.size, 0);
    assert.equal(daemon.connections.size, 0);
    assert.equal(daemon.server.clients.size, 1);
    assert.equal(relay.child.exitCode, null);
  });
});

test('short-lived connections back off instead of resetting the retry delay on open', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => socket.close());
  const relay = startRelay((server.address() as AddressInfo).port);

  try {
    const output = await waitForStreamPattern(relay.child.stderr as Readable, /reconnecting in 500ms[\s\S]*reconnecting in 1000ms/);
    assert.match(output, /reconnecting in 500ms/);
    assert.match(output, /reconnecting in 1000ms/);
  } finally {
    await closeRelay(relay.child);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an over-cap applyEdit response still reaches the daemon', async () => {
  await runRelayScenario(async ({ daemon, initialSocket, relay }) => {
    initialSocket.send(JSON.stringify({
      type: 'lsp-request', id: 'visions-fix-large', method: 'workspace/applyEdit', params: { edit: {} },
    }));
    const request = await relay.stdoutMessages.next('applyEdit not forwarded to the editor');
    const oversizedDetail = 'x'.repeat(2 * 1024 * 1024);

    await writeLspAsync(relay.child, {
      jsonrpc: '2.0', id: request.id, result: { applied: true, oversizedDetail },
    });

    const answer = await daemon.messages.next('large applyEdit answer not routed back');
    assert.deepEqual(answer, {
      type: 'lsp-response', id: 'visions-fix-large', result: { applied: true, oversizedDetail },
    });
  });
});

test('the vite-built relay entry still starts when an editor spawns it directly', async (t) => {
  const repoRoot = path.join(import.meta.dirname, '..');
  const outDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-relay-entry-')));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  await build({ configFile: path.join(repoRoot, 'vite.server.config.ts'), configLoader: 'native', logLevel: 'silent', build: { outDir } });
  fs.writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}\n', 'utf8');
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');

  const daemon = await startDaemon();
  const relay = startRelay(daemon.port, path.join(outDir, 'session', 'visions-relay.js'));
  t.after(async () => {
    relay.child.kill();
    await daemon.close();
  });

  const socket = await daemon.connections.next('the built relay never connected to the daemon');
  assert.equal(socket.readyState, WebSocket.OPEN);
});
