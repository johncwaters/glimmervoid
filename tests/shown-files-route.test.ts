import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { createBackend } from '../server/backend/backend.ts';
import { runAgentApiCli } from '../server/agent-api-cli.ts';
import { AGENT_URL_ENV, SHOWN_FILE_CAP_BYTES, SHOWN_FILES_KEPT_PER_SESSION } from '../shared/contracts/session.ts';
import type { ShownFile } from '../shared/contracts/session.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';
import type { Backend } from './helpers/lanes.ts';
import { settleBackendShutdown } from './helpers/lanes.ts';

const execFileAsync = promisify(execFile);
const ffmpegPath: unknown = createRequire(import.meta.url)('ffmpeg-static');
const SESSION_ID = 'a0000000-0000-4000-8000-0000000000a7';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000970485973000003e8000003e801b57b526b0000000d494441540899636060606000000005000187a14ed40000000049454e44ae426082', 'hex');

interface ShowContext {
  tmpDir: string;
  workDir: string;
  server: Server;
  backend: Backend;
  base: string;
  previousConfig: string | undefined;
  previousAgentUrl: string | undefined;
}

const booted: { context: ShowContext | null } = { context: null };

function ctx(): ShowContext {
  if (!booted.context) throw new Error('the backend was never booted');
  return booted.context;
}

function shownDir(): string {
  return path.join(ctx().tmpDir, 'shown', SESSION_ID);
}

function readShownIndex(): ShownFile[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(shownDir(), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}

function writeWorkFile(name: string, contents: string | Buffer): string {
  const filePath = path.join(ctx().workDir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test.before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-shown-'));
  const projectDir = path.join(tmpDir, 'project');
  const workDir = path.join(tmpDir, 'scratchpad');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(workDir);
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: SESSION_ID, name: 'show', path: projectDir }], repoRoots: [], autoResume: false }), 'utf8');
  const previousConfig = process.env.GLIMMERVOID_CONFIG;
  const previousAgentUrl = process.env[AGENT_URL_ENV];
  process.env.GLIMMERVOID_CONFIG = configPath;

  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await listenOnLoopback(server);
  const session = backend.getSession(SESSION_ID);
  assert.ok(session?.agentToken, 'the session was minted an agent token');
  const base = `http://127.0.0.1:${boundPort(server)}`;
  process.env[AGENT_URL_ENV] = `${base}/agent/${SESSION_ID}?t=${session.agentToken}`;
  booted.context = { tmpDir, workDir, server, backend, base, previousConfig, previousAgentUrl };
});

test.after(async () => {
  if (!booted.context) return;
  const { backend, server, tmpDir, previousConfig, previousAgentUrl } = booted.context;
  await settleBackendShutdown(backend);
  server.closeAllConnections();
  await closeServer(server);
  if (previousConfig == null) delete process.env.GLIMMERVOID_CONFIG;
  if (previousConfig != null) process.env.GLIMMERVOID_CONFIG = previousConfig;
  if (previousAgentUrl == null) delete process.env[AGENT_URL_ENV];
  if (previousAgentUrl != null) process.env[AGENT_URL_ENV] = previousAgentUrl;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a shown page is served sandboxed and whole with the zoom bridge after it, so its scripts cannot read the control token', async () => {
  const pageMarkup = '<!doctype html><html><head><title>Card prototypes</title></head><body><script>1</script></body></html>';
  const pagePath = writeWorkFile('index.html', pageMarkup);
  assert.equal(await quietly(() => runAgentApiCli(['show', pagePath, '--caption', 'the layouts'])), 0);

  const page = readShownIndex().at(-1);
  assert.ok(page);
  assert.equal(page.kind, 'page');
  assert.equal(page.pageTitle, 'Card prototypes');
  assert.equal(page.caption, 'the layouts');

  const response = await fetch(`${ctx().base}/shown/${SESSION_ID}/${page.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
  const policy = response.headers.get('content-security-policy') ?? '';
  assert.match(policy, /^sandbox allow-scripts\b/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const servedBody = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), servedBody.byteLength);
  assert.ok(servedBody.subarray(0, Buffer.byteLength(pageMarkup)).equals(Buffer.from(pageMarkup)), 'the page bytes come first, unchanged');
  assert.match(servedBody.subarray(Buffer.byteLength(pageMarkup)).toString('utf8'), /^\n<script>[\s\S]*glimmervoidShownZoom[\s\S]*<\/script>\n$/);

  const rangedResponse = await fetch(`${ctx().base}/shown/${SESSION_ID}/${page.id}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(rangedResponse.status, 200);
  assert.equal((await rangedResponse.arrayBuffer()).byteLength, servedBody.byteLength);

  const tokenFromSandboxedPage = await fetch(`${ctx().base}/control-token`, { headers: { origin: 'null' } });
  assert.equal(tokenFromSandboxedPage.status, 403);
});

test('a shown page that ends inside an open textarea is served without the zoom bridge, so its source never shows as page text', async () => {
  const pageMarkup = '<!doctype html><html><body><p>notes</p><textarea>draft';
  const pagePath = writeWorkFile('open-textarea.html', pageMarkup);
  assert.equal(await quietly(() => runAgentApiCli(['show', pagePath])), 0);
  const page = readShownIndex().at(-1);
  assert.ok(page);

  const response = await fetch(`${ctx().base}/shown/${SESSION_ID}/${page.id}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), pageMarkup);
});

test('show refuses another kind of file and a file over the cap, storing nothing', async () => {
  const before = readShownIndex().length;
  const notesPath = writeWorkFile('notes.txt', 'plain text');
  assert.equal(await quietly(() => runAgentApiCli(['show', notesPath])), 1);

  const hugePath = writeWorkFile('render.mp4', '');
  fs.truncateSync(hugePath, SHOWN_FILE_CAP_BYTES + 1);
  assert.equal(await quietly(() => runAgentApiCli(['show', hugePath])), 1);

  const session = ctx().backend.getSession(SESSION_ID);
  const overCapStatus = await new Promise<number>((resolve, reject) => {
    const request = http.request(`${ctx().base}/agent/${SESSION_ID}/show`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session?.agentToken}`, 'content-length': String(SHOWN_FILE_CAP_BYTES + 1), 'x-glimmervoid-show-name': 'render.mp4' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.write('x');
  });
  assert.equal(overCapStatus, 413);

  const chunkedOverCapStatus = await new Promise<number>((resolve, reject) => {
    const request = http.request(`${ctx().base}/agent/${SESSION_ID}/show`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session?.agentToken}`, 'transfer-encoding': 'chunked', 'x-glimmervoid-show-name': 'render.mp4' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end(Buffer.alloc(SHOWN_FILE_CAP_BYTES + 1024 * 1024, 0x41));
  });
  assert.equal(chunkedOverCapStatus, 413);

  assert.equal(readShownIndex().length, before);
  assert.deepEqual(fs.readdirSync(shownDir()).filter((name) => name.startsWith('.incoming-')), []);
});

test('only the newest shown files per session are kept on disk and in the index', async () => {
  const imagePath = writeWorkFile('frame.png', PNG_BYTES);
  for (let showCount = 0; showCount <= SHOWN_FILES_KEPT_PER_SESSION; showCount += 1) {
    assert.equal(await quietly(() => runAgentApiCli(['show', imagePath])), 0);
  }
  const kept = readShownIndex();
  assert.equal(kept.length, SHOWN_FILES_KEPT_PER_SESSION);
  assert.ok(kept.every((file) => file.kind === 'image'), 'the oldest file, the page, was the one dropped');
  assert.ok(kept.every((file) => file.hasThumbnail), 'every kept image has a thumbnail');
  const storedFiles = fs.readdirSync(shownDir()).filter((name) => name !== 'index.json');
  assert.deepEqual(storedFiles.sort(), kept.flatMap((file) => [file.id, `${file.id}.thumb.webp`]).sort());
});

test('a shown video gets a small WebP poster served beside it', async () => {
  const videoPath = path.join(ctx().workDir, 'clip.mp4');
  await execFileAsync(String(ffmpegPath), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10', '-t', '1', '-pix_fmt', 'yuv420p', '-y', videoPath]);
  assert.equal(await quietly(() => runAgentApiCli(['show', videoPath])), 0);
  const video = readShownIndex().at(-1);
  assert.equal(video?.kind, 'video');
  assert.equal(video?.hasThumbnail, true);
  const response = await fetch(`${ctx().base}/shown/${SESSION_ID}/${video.id}.thumb.webp`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  const { default: sharp } = await import('sharp');
  const poster = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.ok(Math.max(poster.width ?? 0, poster.height ?? 0) <= 320, 'the poster fits in 320 px');
});
