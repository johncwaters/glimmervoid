import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import claudeCode from '../session/adapters/claude-code.ts';
import { HookRouter } from '../detection/hook-source.ts';
import {
  buildHookSettings,
  writeSessionSettings,
  sweepOrphans,
  generateToken,
} from '../detection/settings-injector.ts';
import type { HookSignal } from '../detection/hook-source.ts';

test('HookRouter passes the low-confidence override for idle_prompt, none for Stop', () => {
  const r = new HookRouter();
  const got: HookSignal[] = [];
  r.register('s1', { token: 'tok', onSignal: (s) => got.push(s), hooks: claudeCode.hooks });
  r.handle({ glimmervoidId: 's1', event: 'Notification', token: 'tok', payload: { notification_type: 'idle_prompt' } });
  r.handle({ glimmervoidId: 's1', event: 'Stop', token: 'tok', payload: {} });
  assert.equal(got.length, 2);
  assert.equal(got[0].signal, 'ready');
  assert.equal(got[0].confidence, 'low');
  assert.equal(got[1].signal, 'ready');
  assert.equal('confidence' in got[1], false, 'Stop keeps the hook default');
});

test('a rejected token is counted only as its status class, never carried into the count', () => {
  const secretToken = 'glimmervoid-fake-bearer-DO-NOT-LOG-9f3c1a';
  const recorded: string[] = [];
  const r = new HookRouter({ recordOutcome: (name) => recorded.push(name) });
  r.register('s1', { token: 'good', onSignal: () => {}, hooks: claudeCode.hooks });

  const res = r.handle({
    glimmervoidId: 's1', event: 'Stop', token: secretToken, payload: { transcript_path: '/home/someone/secret.jsonl' },
  });

  assert.equal(res.status, 403);
  assert.deepEqual(recorded, ['hookRejected403']);
  const everythingRecorded = JSON.stringify(recorded);
  assert.equal(everythingRecorded.includes(secretToken), false, 'the presented token never reaches the counter');
  assert.equal(everythingRecorded.includes('s1'), false, 'the session id never reaches the counter');
  assert.equal(everythingRecorded.includes('secret.jsonl'), false, 'the payload never reaches the counter');
});

test('HookRouter rejects bad token (403)', () => {
  const r = new HookRouter();
  const got: HookSignal[] = [];
  r.register('s1', { token: 'good', onSignal: (s) => got.push(s), hooks: claudeCode.hooks });
  const res = r.handle({ glimmervoidId: 's1', event: 'Stop', token: 'bad', payload: {} });
  assert.equal(res.status, 403);
  assert.equal(got.length, 0);
});

test('HookRouter never observes an unknown session or a bad token', () => {
  const router = new HookRouter();
  const events: unknown[][] = [];
  router.register('s1', { token: 'good', onSignal: () => {}, onEvent: (...args) => events.push(args), hooks: claudeCode.hooks });
  router.handle({ glimmervoidId: 'missing', event: 'Stop', token: 'good', payload: {} });
  router.handle({ glimmervoidId: 's1', event: 'Stop', token: 'bad', payload: {} });
  assert.deepEqual(events, []);
});

test('buildHookSettings merges permissions.deny when provided, omits it otherwise', () => {
  const base = { port: 1234, glimmervoidId: 'g1', token: 't1' };
  const permissions = { deny: ['Bash(gh pr merge:*)', 'Write(.github/workflows/**)'] };
  const withDeny = buildHookSettings({ ...base, permissions });
  assert.ok(withDeny.permissions && Array.isArray(withDeny.permissions.deny));
  assert.ok(withDeny.permissions.deny.includes('Bash(gh pr merge:*)'));
  assert.ok(withDeny.hooks, 'hooks still present');

  const noDeny = buildHookSettings(base);
  assert.equal(noDeny.permissions, undefined, 'user sessions get no permissions block');
  assert.equal(buildHookSettings({ ...base, permissions: { deny: [] } }).permissions, undefined, 'an empty deny list adds nothing');
});

test('writeSessionSettings handles colon-namespaced ids without ENOENT (Windows-safe dir)', () => {
  const baseDir = path.join(os.tmpdir(), `glimmervoid-colon-${Date.now()}`);
  const glimmervoidId = 'setup:marketing:bb78afb5-e527-48da-9632-580c00153a1b';
  const { settingsPath, dir, cleanup } = writeSessionSettings({ port: 5173, glimmervoidId, baseDir });
  assert.ok(fs.existsSync(settingsPath));
  assert.equal(path.basename(dir).includes(':'), false);
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.match(parsed.hooks.Stop[0].hooks[0].url, /\/hook\/setup%3Amarketing%3Abb78afb5/);
  cleanup();
  assert.equal(fs.existsSync(dir), false);
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

test('sweepOrphans removes stale dirs only', () => {
  const baseDir = path.join(os.tmpdir(), `glimmervoid-sweep-${Date.now()}`);
  const fresh = writeSessionSettings({ port: 1, glimmervoidId: 'fresh', baseDir });
  const stale = writeSessionSettings({ port: 1, glimmervoidId: 'stale', baseDir });

  const old = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(stale.dir, new Date(old), new Date(old));
  const removed = sweepOrphans(baseDir, 24 * 60 * 60 * 1000);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale.dir), false);
  assert.equal(fs.existsSync(fresh.dir), true);
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try { return { result: fn(), warnings }; }
  finally { console.warn = realWarn; }
}

test('sweepOrphans on a missing base dir returns 0 and says nothing', () => {
  const baseDir = path.join(os.tmpdir(), `glimmervoid-sweep-absent-${Date.now()}`);
  const { result, warnings } = captureWarnings(() => sweepOrphans(baseDir, 24 * 60 * 60 * 1000));
  assert.equal(result, 0);
  assert.equal(fs.existsSync(baseDir), false, 'the sweep never creates the dir; the first write does');
  assert.deepEqual(warnings, [], 'a base dir that does not exist yet is the ordinary first-boot case');
});

test('sweepOrphans refuses a base dir that is a symlink, deleting nothing behind it', () => {
  const realDir = path.join(os.tmpdir(), `glimmervoid-sweep-target-${Date.now()}`);
  const linkDir = path.join(os.tmpdir(), `glimmervoid-sweep-link-${Date.now()}`);
  const stale = writeSessionSettings({ port: 1, glimmervoidId: 'stale', baseDir: realDir });
  const old = Date.now() - 48 * 60 * 60 * 1000;
  fs.utimesSync(stale.dir, new Date(old), new Date(old));

  fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const { result, warnings } = captureWarnings(() => sweepOrphans(linkDir, 24 * 60 * 60 * 1000));
    assert.equal(result, 0, 'a planted symlink is never followed');
    assert.equal(fs.existsSync(stale.dir), true, 'and the tree behind it is untouched');
    assert.equal(warnings.length, 1, 'the refusal is stated once');
    assert.match(warnings[0], /refusing to sweep/);
  } finally {
    try { fs.unlinkSync(linkDir); } catch { fs.rmSync(linkDir, { recursive: true, force: true }); }
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
const alienUidSkip = process.platform === 'win32'
  ? 'posix uids only'
  : (currentUid === 0 ? 'running as root: no directory is owned by another user' : false);

test('sweepOrphans refuses a base dir owned by another user', { skip: alienUidSkip }, () => {
  const alienDir = ['/usr', '/root', '/'].find((dir) => {
    try { return fs.lstatSync(dir).uid !== currentUid; } catch { return false; }
  });
  assert.ok(alienDir, 'expected at least one root-owned directory to exist');
  const { result, warnings } = captureWarnings(() => sweepOrphans(alienDir, 24 * 60 * 60 * 1000));
  assert.equal(result, 0);
  assert.equal(warnings.length, 1, 'refused before the readdir, not merely empty of stale entries');
  assert.match(warnings[0], /refusing to sweep/);
});

test('end-to-end: real HTTP POST through router validates token and dispatches', async () => {
  const r = new HookRouter();
  const got: HookSignal[] = [];
  const token = generateToken();
  r.register('e2e', { token, onSignal: (s) => got.push(s), hooks: claudeCode.hooks });

  const server = http.createServer((req, res) => {
    const m = String(req.url).match(/^\/hook\/([^/]+)\/([^/?]+)(?:\?t=([^&]+))?$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch {}
      const out = r.handle({
        glimmervoidId: decodeURIComponent(m[1]),
        event: m[2],
        token: m[3] ? decodeURIComponent(m[3]) : null,
        payload,
      });
      res.writeHead(out.status);
      res.end();
    });
  });
  await new Promise<void>((res) => { server.listen(0, '127.0.0.1', () => res()); });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'the server bound to a TCP port');
  const port = address.port;

  const post = (url: string, body: unknown) =>
    new Promise((resolve) => {
      const req = http.request(url, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end(JSON.stringify(body));
    });

  const okStatus = await post(`http://127.0.0.1:${port}/hook/e2e/stop?t=${token}`, { hook_event_name: 'Stop' });
  assert.equal(okStatus, 200);
  const badStatus = await post(`http://127.0.0.1:${port}/hook/e2e/stop?t=wrong`, { hook_event_name: 'Stop' });
  assert.equal(badStatus, 403);

  assert.equal(got.length, 1);
  assert.equal(got[0].signal, 'ready');
  await new Promise<void>((res) => { server.close(() => res()); });
});

for (const event of ['PreCompact', 'PostCompact']) {
  test(`${event} is installed as an authenticated HTTP hook and dispatched with its trigger`, () => {
    const settings = buildHookSettings({ port: 1234, glimmervoidId: 'compact-session', token: 'compact-token' });
    const handler = settings.hooks[event][0].hooks[0];
    assert.equal(handler.type, 'http');
    assert.equal(handler.url, `http://127.0.0.1:1234/hook/compact-session/${event.toLowerCase()}?t=compact-token`);
    assert.equal(handler.timeout, 5);
    const router = new HookRouter();
    const signals: HookSignal[] = [];
    router.register('compact-session', { token: 'compact-token', onSignal: (signal) => signals.push(signal), hooks: claudeCode.hooks });
    assert.equal(router.handle({ glimmervoidId: 'compact-session', event, token: 'bad', payload: { trigger: 'auto' } }).status, 403);
    assert.equal(signals.length, 0);
    assert.equal(router.handle({ glimmervoidId: 'compact-session', event, token: 'compact-token', payload: { trigger: 'auto' } }).status, 200);
    assert.equal(signals[0].signal, event === 'PreCompact' ? 'compaction-start' : 'compaction-end');
    assert.equal(signals[0].payload?.trigger, 'auto');
  });
}
