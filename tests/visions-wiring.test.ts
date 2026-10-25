import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { TestContext } from 'node:test';

import { createBackend } from '../server/backend/backend.ts';
import { createConfigStore } from '../server/config-store.ts';
import { CONFIG_SCALAR_KEYS, ConfigUpdate } from '../shared/contracts/index.ts';
import { createVisionsWiring, VISIONS_DEBOUNCE_MS } from '../server/visions/visions-wiring.ts';
import type { VisionsWiringOptions } from '../server/visions/visions-wiring.ts';
import { listenOnLoopback, reserveFreePort } from './helpers/http-server.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

interface Diagnostic {
  code?: string;
  message?: string;
  severity?: number;
  source?: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LaneFrame {
  type: string;
  id?: unknown;
  method?: string;
  result?: unknown;
  params?: Record<string, unknown>;
  [field: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function paramAt(frame: LaneFrame | undefined, dottedPath: string): unknown {
  let cursor: unknown = frame?.params;
  for (const key of dottedPath.split('.')) {
    if (!isRecord(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function asFrame(message: unknown): LaneFrame {
  if (!isRecord(message) || typeof message.type !== 'string') throw new Error('the lane sent a frame with no type');
  return { ...message, type: message.type };
}

function frameDiagnostic(frame: LaneFrame | null, index: number): Diagnostic {
  if (!frame) throw new Error('no frame to read a diagnostic from');
  const diagnostic = diagnosticsOf(frame)[index];
  if (!diagnostic) throw new Error(`no diagnostic at ${index}`);
  return diagnostic;
}

function diagnosticsOf(frame: LaneFrame | undefined): Diagnostic[] {
  const diagnostics = paramAt(frame, 'diagnostics');
  if (!Array.isArray(diagnostics)) throw new Error('the frame carries no diagnostics array');
  return diagnostics;
}

const MARKDOWN_URI = 'file:///tmp/plan-visions.md';
const HARNESS_SCOPE = [{ id: 'harness', path: '/tmp' }];
const PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = 'e1f4c0de-0000-4000-8000-000000000002';
const SCRIPT_URI = 'file:///tmp/app.js';
const CLEAN_MARKDOWN = '# Title\n\nA line with nothing wrong.\n';
const REPEATED_WORD_MARKDOWN = '# Title\n\nA line with with a repeat.\n';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

function fakeTimers() {
  const pendingByHandle = new Map<NodeJS.Timeout, () => void>();
  return {
    setTimeoutFn: (fn: () => void): NodeJS.Timeout => {
      const handle = setTimeout(() => {}, 2 ** 30);
      handle.unref();
      pendingByHandle.set(handle, fn);
      return handle;
    },
    clearTimeoutFn: (handle: NodeJS.Timeout) => {
      clearTimeout(handle);
      pendingByHandle.delete(handle);
    },
    runPending: () => {
      const jobs = [...pendingByHandle.values()];
      for (const handle of pendingByHandle.keys()) clearTimeout(handle);
      pendingByHandle.clear();
      for (const job of jobs) job();
    },
    get pendingCount() { return pendingByHandle.size; },
    get pendingIds(): NodeJS.Timeout[] { return [...pendingByHandle.keys()]; },
  };
}

const FIXED_TS = 1700000000000;

function requireServer(server: http.Server | null): http.Server {
  if (!server) throw new Error('the remote listener never came up');
  return server;
}

function drivenConnection(options: VisionsWiringOptions = {}) {
  const timers = fakeTimers();
  const warnings: string[] = [];
  const notes: string[] = [];
  const sent: LaneFrame[] = [];
  const broadcasts: LaneFrame[] = [];
  const clock = { now: FIXED_TS };
  const wiring = createVisionsWiring({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => clock.now,
    logger: {
      warn: (message: string) => { warnings.push(message); },
      log: (message: string) => { notes.push(message); },
    },
    broadcast: (message) => { broadcasts.push(asFrame(message)); },
    scopeProjects: HARNESS_SCOPE,
    ...options,
  });
  const connection = wiring.openConnection({ send: (message) => { sent.push(asFrame(message)); } });
  const lsp = (method: string, params: unknown) => connection.handleFrame(JSON.stringify({ type: 'lsp', method, params }));
  return { wiring, connection, timers, warnings, notes, sent, broadcasts, lsp, clock };
}

function tempIntentStatePath(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-visions-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'visions-intent.json');
}

function countingFsPromises() {
  const writes: unknown[][] = [];
  return {
    writes,
    fsPromises: {
      ...fs.promises,
      writeFile: (...args: Parameters<typeof fs.promises.writeFile>) => {
        writes.push(args);
        return fs.promises.writeFile(...args);
      },
    },
  };
}

function didOpenParams(uri: string, languageId: string | undefined, text: string) {
  return { textDocument: { uri, languageId, version: 1, text } };
}

function didChangeParams(uri: string, version: number, text: string) {
  return { textDocument: { uri, version }, contentChanges: [{ text }] };
}


function intentBroadcasts(broadcasts: LaneFrame[]): LaneFrame[] {
  return broadcasts.filter((message) => message.type === 'visions-intent');
}

function threadShape(thread: { id: string }, { text, uris = [], ts = FIXED_TS, hits = 1 }: {
  text: string;
  uris?: string[];
  ts?: number;
  hits?: number;
}) {
  return {
    id: thread.id, text, uris, ts, hits,
  };
}

test('model intent persists on change only and revives on the next wiring', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  const counted = countingFsPromises();
  const { wiring } = drivenConnection({ intentStatePath, fsPromises: counted.fsPromises });
  t.after(() => wiring.stop());

  assert.equal(wiring.applyModelIntent('  durable belief  '), true);
  assert.equal(wiring.applyModelIntent('a belief about one repo', PROJECT_ID, MARKDOWN_URI), true);
  await wiring.whenIntentPersistenceIdle();
  assert.equal(counted.writes.length, 2);
  const unowned = threadShape(wiring.getIntentFor().active, { text: 'durable belief' });
  const owned = threadShape(wiring.getIntentFor(PROJECT_ID).active, { text: 'a belief about one repo', uris: [MARKDOWN_URI] });
  assert.deepEqual(JSON.parse(fs.readFileSync(intentStatePath, 'utf8')), {
    byProject: { [PROJECT_ID]: [owned] },
    unowned: [unowned],
  });

  assert.equal(wiring.applyModelIntent('durable belief'), false);
  await wiring.whenIntentPersistenceIdle();
  assert.equal(counted.writes.length, 2);

  const revived = drivenConnection({ intentStatePath });
  t.after(() => revived.wiring.stop());
  assert.deepEqual(revived.wiring.getIntentFor(), { active: unowned, threads: [unowned] });
  assert.deepEqual(revived.wiring.getIntentFor(PROJECT_ID), { active: owned, threads: [owned] });
});

test('a project the config no longer knows loses its threads on the next load', async (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, JSON.stringify({
    byProject: {
      [PROJECT_ID]: [{ id: 't-11111111', text: 'still configured', uris: [], ts: FIXED_TS, hits: 1 }],
      [OTHER_PROJECT_ID]: [{ id: 't-22222222', text: 'deleted project', uris: [], ts: FIXED_TS, hits: 1 }],
    },
    unowned: [],
  }), 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath, knownProjectIds: [PROJECT_ID] });
  t.after(() => wiring.stop());

  assert.deepEqual(Object.keys(wiring.getIntent().byProject), [PROJECT_ID]);
  assert.deepEqual(warnings, [], 'a deleted project is routine, not a corrupt file');
});

test('both legacy slot files revive as one thread each, and the next persist writes threads', async (t) => {
  const flatPath = tempIntentStatePath(t);
  fs.writeFileSync(flatPath, JSON.stringify({
    text: 'durable correction', source: 'operator', locked: true, ts: FIXED_TS,
  }), 'utf8');
  const flat = drivenConnection({ intentStatePath: flatPath });
  t.after(() => flat.wiring.stop());
  assert.equal(flat.wiring.getIntentFor().active.text, 'durable correction');
  assert.equal(flat.wiring.applyModelIntent('durable model belief'), true);
  await flat.wiring.whenIntentPersistenceIdle();
  const persisted = JSON.parse(fs.readFileSync(flatPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['byProject', 'unowned']);
  assert.equal(persisted.unowned[0].text, 'durable model belief');
  assert.equal(persisted.unowned[0].hits, 2, 'the lifted thread was advanced, not replaced');

  const scopedPath = tempIntentStatePath(t);
  fs.writeFileSync(scopedPath, JSON.stringify({
    global: { text: 'the global belief', source: 'model', ts: FIXED_TS },
    byProject: { [PROJECT_ID]: { text: 'this project only', source: 'model', ts: FIXED_TS } },
  }), 'utf8');
  const scoped = drivenConnection({ intentStatePath: scopedPath });
  t.after(() => scoped.wiring.stop());
  assert.equal(scoped.wiring.getIntentFor(PROJECT_ID).active.text, 'this project only');
  assert.equal(scoped.wiring.getIntentFor().active.text, 'the global belief');
  assert.deepEqual(scoped.wiring.getIntentFor(OTHER_PROJECT_ID), { active: null, threads: [] }, 'the lifted global text is unowned, never a fallback');
});

test('a legacy flat empty intent file is not a corrupt one', (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, JSON.stringify({ text: '', source: null, ts: 0 }), 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntent(), { byProject: {}, unowned: [] });
  assert.deepEqual(warnings, [], 'a file that only ever said nothing says nothing on every boot');
});

test('a corrupt intent file starts empty and warns once', (t) => {
  const intentStatePath = tempIntentStatePath(t);
  fs.writeFileSync(intentStatePath, '{', 'utf8');

  const { wiring, warnings } = drivenConnection({ intentStatePath });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.getIntent(), { byProject: {}, unowned: [] });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /intent state unreadable, starting empty/);
});

test('without an intent path the lane keeps the same in-memory behavior and touches no storage', async (t) => {
  const fsFns = { readFileSync: () => { throw new Error('must not read'); } };
  const fsPromises = {
    mkdir: () => Promise.reject(new Error('must not write')),
    writeFile: () => Promise.reject(new Error('must not write')),
    rename: () => Promise.reject(new Error('must not write')),
    rm: () => Promise.reject(new Error('must not write')),
    appendFile: () => Promise.reject(new Error('must not write')),
  };
  const { wiring, broadcasts, warnings } = drivenConnection({ fsFns, fsPromises });
  t.after(() => wiring.stop());

  assert.deepEqual(wiring.snapshotMessage().intent, { byProject: {}, unowned: [] });
  assert.equal(wiring.applyModelIntent('memory only'), true);
  await wiring.whenIntentPersistenceIdle();
  const thread = threadShape(wiring.getIntentFor().active, { text: 'memory only' });
  assert.deepEqual(intentBroadcasts(broadcasts), [{
    type: 'visions-intent', projectId: null, intent: { active: thread, threads: [thread] }, ts: FIXED_TS,
  }]);
  assert.deepEqual(warnings, []);
});

interface BootedBackend {
  dir: string;
  backend: ReturnType<typeof createBackend> | null;
  server: http.Server;
  remoteServer: http.Server | null;
  port: number | null;
  remotePort: number | null;
}

const booted: BootedBackend[] = [];

async function bootBackend(configPatch: Record<string, unknown>, { remotePort = null }: { remotePort?: number | null } = {}): Promise<BootedBackend & { port: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-visions-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: 'harness', name: 'harness', path: '/tmp' }], teams: [], repoRoots: [], ...configPatch }, null, 2), 'utf8');
  const previousEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;

  const entry: BootedBackend = { dir, backend: null, server: http.createServer(), remoteServer: null, port: null, remotePort };
  try {
    entry.backend = createBackend(entry.server, { staticDir: null });
  } finally {
    if (previousEnv == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousEnv != null) process.env.GLIMMERVOID_CONFIG = previousEnv;
  }
  booted.push(entry);
  const backend = entry.backend;
  if (!backend) throw new Error('the backend never booted');
  entry.server.on('request', backend.app);
  const port = await listenOnLoopback(entry.server);
  entry.port = port;

  if (remotePort) {
    const remoteServer = http.createServer();
    entry.remoteServer = remoteServer;
    backend.remote.attach(remoteServer);
    await listenOnLoopback(remoteServer, remotePort);
  }
  return { ...entry, port };
}

test.after(async () => {
  for (const entry of booted) {
    if (entry.backend) await settleBackendShutdown(entry.backend);
    for (const server of [entry.server, entry.remoteServer]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function visionsClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/visions`);
  const frames: LaneFrame[] = [];
  ws.on('message', (data: Buffer) => { frames.push(asFrame(JSON.parse(data.toString()))); });
  const opened = new Promise<string>((resolve, reject) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', reject);
  });
  return {
    ws,
    frames,
    opened,
    sendRaw: (raw: string) => ws.send(raw),
    sendLsp: (method: string, params: unknown) => ws.send(JSON.stringify({ type: 'lsp', method, params })),
    close: () => ws.close(),
  };
}

async function waitForDiagnostics(client: ReturnType<typeof visionsClient>, uri: string, timeoutMs = 4000): Promise<LaneFrame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = client.frames.find((msg) => msg.type === 'publishDiagnostics'
      && paramAt(msg, 'uri') === uri
      && diagnosticsOf(msg).length > 0);
    if (frame) return frame;
    await delay(25);
  }
  return null;
}

function backendDestroyedUpgrade(server: http.Server, port: number, requestPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no upgrade event for ${requestPath}`)), 5000);
    let client: net.Socket | null = null;
    server.once('upgrade', (_req, socket) => {
      clearTimeout(timer);
      const destroyedByBackend = socket.destroyed;
      socket.destroy();
      if (client) client.destroy();
      resolve(destroyedByBackend);
    });
    const socketToServer = net.connect(port, '127.0.0.1', () => {
      socketToServer.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });
    client = socketToServer;
    socketToServer.on('error', () => {  });
  });
}

test('an enabled lane serves /visions on the local listener and publishes markdown diagnostics', async (t) => {
  const { port } = await bootBackend({ visions: { enabled: true } });
  const client = visionsClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', CLEAN_MARKDOWN));
  client.sendLsp('textDocument/didChange', didChangeParams(MARKDOWN_URI, 2, REPEATED_WORD_MARKDOWN));

  const frame = await waitForDiagnostics(client, MARKDOWN_URI);
  assert.ok(frame, 'a publishDiagnostics frame arrives on the same socket');
  assert.deepEqual(diagnosticsOf(frame).map((diagnostic) => diagnostic.code), ['repeated-word']);
  assert.equal(frameDiagnostic(frame, 0).source, 'glimmervoid-visions');
  assert.equal(frameDiagnostic(frame, 0).range?.start.line, 2);
});

test('a non-markdown document over the same socket yields no diagnostics, and a garbage frame kills nothing', async (t) => {
  const { port } = await bootBackend({ visions: { enabled: true } });
  const client = visionsClient(port);
  t.after(() => client.close());
  assert.equal(await client.opened, 'open');

  client.sendRaw('this is not a frame');
  client.sendLsp('textDocument/didOpen', didOpenParams(SCRIPT_URI, 'javascript', 'const the the = 1;\n'));
  client.sendLsp('textDocument/didChange', didChangeParams(SCRIPT_URI, 2, 'const the the = 2;\n'));
  await delay(VISIONS_DEBOUNCE_MS * 4);
  assert.deepEqual(client.frames, [], 'v1 says nothing about code buffers');

  client.sendLsp('textDocument/didOpen', didOpenParams(MARKDOWN_URI, 'markdown', REPEATED_WORD_MARKDOWN));
  assert.ok(await waitForDiagnostics(client, MARKDOWN_URI), 'the connection survived the malformed frame');
});

test('a default config leaves /visions exactly where an unowned path is left', async () => {
  const { server, port } = await bootBackend({});
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/visions'), false,
    'untouched on the local listener, so Vite HMR can still claim it',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/some-other-app'), false,
    'byte-for-byte the unknown-path behavior',
  );
});

test('a config with visions present but not enabled stays inert', async () => {
  const { server, port } = await bootBackend({ visions: { enabled: false } });
  assert.equal(await backendDestroyedUpgrade(server, port, '/visions'), false);
});

test('/visions is refused on the remote listener even with the lane enabled', async () => {
  const remotePort = await reserveFreePort();
  const { server, port, remoteServer } = await bootBackend({
    visions: { enabled: true },
    remote: { enabled: true, port: remotePort, publicHost: 'glimmervoid.test', allowedOrigins: ['https://glimmervoid.test'] },
  }, { remotePort });

  assert.equal(
    await backendDestroyedUpgrade(requireServer(remoteServer), remotePort, '/visions'), true,
    'buffer text never crosses the remote boundary in v1',
  );
  assert.equal(
    await backendDestroyedUpgrade(server, port, '/visions'), false,
    'the same lane is served on the local listener',
  );
});

test('visions is echoed by getSettings and applied as a restart-required settings block', () => {
  assert.equal(CONFIG_SCALAR_KEYS.includes('visions'), false);
  assert.equal('visions' in ConfigUpdate.shape, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-visions-settings-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [], teams: [], visions: { enabled: true } }, null, 2), 'utf8');
  const previousEnv = process.env.GLIMMERVOID_CONFIG;
  process.env.GLIMMERVOID_CONFIG = configPath;
  try {
    const store = createConfigStore();
    assert.deepEqual(store.getSettings().visions, { enabled: true });
    store.applySettings({ projects: [], visions: { enabled: false } });
    assert.deepEqual(store.config.visions, { enabled: false });
  } finally {
    if (previousEnv == null) delete process.env.GLIMMERVOID_CONFIG;
    if (previousEnv != null) process.env.GLIMMERVOID_CONFIG = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

