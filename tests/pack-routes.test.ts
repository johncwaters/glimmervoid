import './helpers/isolate-home.ts';
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import { createPackData } from '../server/packs/pack-data.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { PACK_BRIDGE_HELPER_SOURCE } from '../server/packs/core/pack-page-core.ts';
import { ClientMessage } from '../shared/contracts/control-messages.ts';
import { PACK_DATA_MAX_BYTES, PanelToHost } from '../shared/contracts/pack-bridge.ts';
import { PANEL_ACTION_MAX_BYTES, panelActionDecision } from '../shared/pack-action-core.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';

test('a pack panel file is served only from an approved pack at its current content through its keyed frame URL, even where remote pairing guards every other route, inside a sandbox that allows no connections, and the dashboard frames nothing from another origin', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-routes-'));
  const packDir = path.join(homeDir, 'packs', 'ci');
  fs.mkdirSync(path.join(packDir, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'ci', version: 1, ui: { panels: [{ id: 'board', label: 'CI', entry: 'panel/index.html' }] } }));
  fs.writeFileSync(path.join(packDir, 'panel', 'index.html'), '<!doctype html><head><link rel="stylesheet" href="panel.css"></head><p>ci</p><script src="panel.js"></script>');
  fs.writeFileSync(path.join(packDir, 'panel', 'panel.css'), 'p { color: red }');
  fs.writeFileSync(path.join(packDir, 'panel', 'panel.js'), 'document.title = "</script>";');
  const frameSecret = crypto.randomBytes(32);
  const packStore = createPackStore({ homeDir, frameSecret, statePath: path.join(homeDir, 'packs-state.json'), env: process.env, log: { warn: () => {} } });
  const server = http.createServer(createBackendHttpApp({
    staticDir: null, configStore: { configPath: path.join(homeDir, 'config.json') }, remote: { allowedOrigins: [] }, remoteAuth: { httpMiddleware: (_req, res) => { res.status(401).end(); }, mountPairRoutes: () => {} }, allowedHosts: [], listenerPortsFor: () => [], pageToken: 'page',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) }, getSession: () => null, getUsage: () => ({ ingestStatusline: () => {} }),
    getPackFile: (packName, fingerprint, filePath) => packStore.servableFile(packName, fingerprint, filePath),
    frameSecret,
  }));
  try {
    await packStore.start();
    const port = await listenOnLoopback(server);
    const fetchPath = (urlPath: string) => fetch(`http://127.0.0.1:${port}${urlPath}`);
    const pendingRow = packStore.statusFrame().packs[0];
    assert.deepEqual(packStore.statusFrame().panels, []);
    const guardedRoute = await fetchPath('/control-token');
    assert.equal(guardedRoute.status, 401);
    assert.equal(guardedRoute.headers.get('content-security-policy'), "frame-src 'self' blob: data:");

    assert.deepEqual(await packStore.approve(pendingRow?.fingerprint ?? ''), { ok: true });
    const [panel] = packStore.statusFrame().panels;
    assert.equal(panel?.viewId, 'pack:ci/board');
    const pendingUrl = panel?.entryUrl ?? '';
    assert.equal(pendingUrl, `/frames/${pendingUrl.split('/')[2]}/packs/ci/${pendingRow?.fingerprint}/panel/index.html`);
    assert.equal((await fetchPath(`/packs/ci/${pendingUrl.split('/')[2]}/files/panel/index.html`)).status, 401, 'the old access key route is gone');
    const served = await fetchPath(pendingUrl);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), `<!doctype html><head><script>${PACK_BRIDGE_HELPER_SOURCE}</script><style>p { color: red }</style></head><p>ci</p><script>document.title = "<\\/script>";</script>`, 'the page arrives with the bridge helper first and its stylesheet and script inline, so a sign-in proxy that refuses the frame\'s own requests cannot blank it');
    assert.match(served.headers.get('content-type') ?? '', /^text\/html/);
    const policy = served.headers.get('content-security-policy') ?? '';
    assert.match(policy, /^sandbox allow-scripts allow-forms;/);
    assert.match(policy, /connect-src 'none'/);
    assert.doesNotMatch(policy, /allow-same-origin/);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('access-control-allow-origin'), null);
    const fromSandboxedFrame = await fetch(`http://127.0.0.1:${port}${pendingUrl}`, { headers: { Origin: 'null' } });
    assert.equal(fromSandboxedFrame.headers.get('access-control-allow-origin'), 'null');
    const fromWebsite = await fetch(`http://127.0.0.1:${port}${pendingUrl}`, { headers: { Origin: 'https://example.com' } });
    assert.equal(fromWebsite.headers.get('access-control-allow-origin'), null);

    assert.equal((await fetchPath(pendingUrl.replace('panel/index.html', 'panel%2F..%2F..%2Fpack.json'))).status, 404);
    assert.equal((await fetchPath(pendingUrl.replace('index.html', 'missing.html'))).status, 404);
    assert.equal((await fetchPath(pendingUrl.replace(/^\/frames\/[0-9a-f]{64}\//, `/frames/${'0'.repeat(64)}/`))).status, 404);

    fs.writeFileSync(path.join(packDir, 'panel', 'index.html'), '<!doctype html><p>changed</p>');
    await packStore.approvedPacks();
    assert.equal((await fetchPath(pendingUrl)).status, 404);
    assert.deepEqual(packStore.statusFrame().panels, []);
  } finally {
    packStore.stop();
    await closeServer(server);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

function writePanelPack(packDir: string, packName: string): void {
  fs.mkdirSync(path.join(packDir, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: packName, version: 1, ui: { panels: [{ id: 'board', label: 'CI', entry: 'panel/index.html' }] } }));
  fs.writeFileSync(path.join(packDir, 'panel', 'index.html'), '<!doctype html><p>ci</p>');
}

async function startPackStorage(homeDir: string) {
  const packStore = createPackStore({ homeDir, frameSecret: crypto.randomBytes(32), statePath: path.join(homeDir, 'packs-state.json'), env: process.env, log: { warn: () => {} }, reloadDebounceMs: 10 });
  await packStore.start();
  const approvePending = async () => {
    for (const row of packStore.statusFrame().packs.filter((candidate) => candidate.state === 'pending')) assert.deepEqual(await packStore.approve(row.fingerprint ?? ''), { ok: true });
  };
  return { packStore, approvePending, packData: createPackData({ homeDir, panelPackDir: (packName) => packStore.panelPackDir(packName) }) };
}

test('a pack store keeps values per approved pack with panels, refuses a write over the size limit or nested too deep without touching the saved file or throwing, and is deleted when its pack folder is removed, even while Glimmervoid was stopped, so a same-named pack never reads it', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-data-'));
  const packDir = path.join(homeDir, 'packs', 'ci');
  const savedPath = path.join(homeDir, 'pack-data', 'ci.json');
  writePanelPack(packDir, 'ci');
  const first = await startPackStorage(homeDir);
  try {
    assert.deepEqual(await first.packData.set('ci', 'sort', 'newest'), { ok: false, error: 'ci is not an approved pack with panels' });
    assert.equal(fs.existsSync(savedPath), false);

    await first.approvePending();
    assert.deepEqual(await first.packData.set('ci', 'sort', 'newest'), { ok: true, data: { sort: 'newest' } });
    assert.deepEqual(await first.packData.set('ci', 'filters', { repo: 'acme/api' }), { ok: true, data: { sort: 'newest', filters: { repo: 'acme/api' } } });
    assert.deepEqual(await first.packData.set('ci', 'sort', null), { ok: true, data: { filters: { repo: 'acme/api' } } });
    const savedText = fs.readFileSync(savedPath, 'utf8');
    const reopened = createPackData({ homeDir, panelPackDir: (packName) => first.packStore.panelPackDir(packName) });
    assert.deepEqual(await reopened.get('ci'), { ok: true, data: { filters: { repo: 'acme/api' } } });

    const oversized = await first.packData.set('ci', 'big', 'x'.repeat(PACK_DATA_MAX_BYTES));
    assert.match(oversized.ok ? '' : oversized.error, /over the 65536 byte limit; nothing was saved/);
    assert.equal(fs.readFileSync(savedPath, 'utf8'), savedText);
    const deepValue = JSON.parse(`${'['.repeat(5000)}${']'.repeat(5000)}`);
    assert.equal(ClientMessage.safeParse({ type: 'pack-data-set', requestId: 'deep', pack: 'ci', key: 'deep', value: deepValue }).success, false);
    assert.equal(PanelToHost.safeParse({ v: 1, kind: 'store-set', key: 'deep', value: deepValue }).success, false);

    const removed = once(first.packStore, 'removed');
    fs.rmSync(packDir, { recursive: true, force: true });
    await removed;
    await first.packData.forgetRemovedPacks();
    assert.equal(fs.existsSync(savedPath), false);

    writePanelPack(packDir, 'ci');
    await first.packStore.approvedPacks();
    await first.approvePending();
    assert.deepEqual(await first.packData.set('ci', 'notes', 'private'), { ok: true, data: { notes: 'private' } });
  } finally {
    first.packStore.stop();
  }
  fs.rmSync(packDir, { recursive: true, force: true });
  writePanelPack(path.join(homeDir, 'packs', 'other-ci'), 'ci');
  const second = await startPackStorage(homeDir);
  try {
    await second.approvePending();
    assert.deepEqual(await second.packData.get('ci'), { ok: true, data: {} });
    assert.equal(fs.existsSync(savedPath), true);
    await second.packData.forgetRemovedPacks();
    assert.equal(fs.existsSync(savedPath), false);
  } finally {
    second.packStore.stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a panel sends a Reviews action only when its pack lists reviews under acts and the request passes the server schema within the byte limit, and the dashboard sends only the declared fields, never a requestId or padding the panel added', () => {
  const openSession = { type: 'open-team-review-session', key: 'acme/api#12', requestId: 'panel-picked', padding: 'x'.repeat(4096) };
  const refusedWithoutActs = panelActionDecision({ pack: 'demo', panelId: 'board', acts: [] }, openSession);
  assert.equal(refusedWithoutActs.ok, false);
  assert.match(refusedWithoutActs.ok ? '' : refusedWithoutActs.error, /does not list reviews under acts/);
  const notAReviewsAction = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['reviews'] }, { type: 'create-session', projectId: 'p1' });
  assert.equal(notAReviewsAction.ok, false);
  const invalidMerge = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['reviews'] }, { type: 'my-pr-merge', repo: 'acme/api', number: -1 });
  assert.equal(invalidMerge.ok, false);
  assert.match(invalidMerge.ok ? '' : invalidMerge.error, /^my-pr-merge not sent: /);
  const sent = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['reviews'] }, openSession);
  assert.deepEqual(sent, { ok: true, type: 'open-team-review-session', payload: { key: 'acme/api#12' } });
  const oversizeComment = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['reviews'] }, { type: 'team-review-action', key: 'acme/api#12', head: 'a'.repeat(40), action: 'comment', body: 'x'.repeat(PANEL_ACTION_MAX_BYTES), comments: [] });
  assert.match(oversizeComment.ok ? '' : oversizeComment.error, /^team-review-action not sent: the request is \d+ bytes, over the \d+ byte limit$/);
  const sendText = { type: 'pack-session-send', id: 's1', text: 'continue', pack: 'other', panelId: 'spoofed' };
  const refusedWithoutSessions = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['reviews'] }, sendText);
  assert.match(refusedWithoutSessions.ok ? '' : refusedWithoutSessions.error, /does not list sessions under acts/);
  const sentAsItsOwnPanel = panelActionDecision({ pack: 'demo', panelId: 'board', acts: ['sessions'] }, sendText);
  assert.deepEqual(sentAsItsOwnPanel, { ok: true, type: 'pack-session-send', payload: { pack: 'demo', panelId: 'board', id: 's1', text: 'continue' } });
});
