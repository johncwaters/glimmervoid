import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import { createPackStore } from '../server/packs/pack-store.ts';
import { closeServer, listenOnLoopback } from './helpers/http-server.ts';

test('a pack panel file is served only from an approved pack at its current content through its access key, even where remote pairing guards every other route, inside a sandbox that allows no connections, and the dashboard frames nothing from another origin', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-routes-'));
  const packDir = path.join(homeDir, 'packs', 'ci');
  fs.mkdirSync(path.join(packDir, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify({ name: 'ci', version: 1, ui: { panels: [{ id: 'board', label: 'CI', entry: 'panel/index.html' }] } }));
  fs.writeFileSync(path.join(packDir, 'panel', 'index.html'), '<!doctype html><p>ci</p>');
  const packStore = createPackStore({ homeDir, statePath: path.join(homeDir, 'packs-state.json'), env: process.env, log: { warn: () => {} } });
  const server = http.createServer(createBackendHttpApp({
    staticDir: null, configStore: { configPath: path.join(homeDir, 'config.json') }, remote: { allowedOrigins: [] }, remoteAuth: { httpMiddleware: (_req, res) => { res.status(401).end(); }, mountPairRoutes: () => {} }, allowedHosts: [], listenerPortsFor: () => [], pageToken: 'page',
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) }, getSession: () => null, getUsage: () => ({ ingestStatusline: () => {} }),
    getPackFile: (packName, fingerprint, filePath) => packStore.servableFile(packName, fingerprint, filePath),
  }));
  try {
    await packStore.start();
    const port = await listenOnLoopback(server);
    const fetchPath = (urlPath: string) => fetch(`http://127.0.0.1:${port}${urlPath}`);
    const pendingRow = packStore.statusFrame().packs[0];
    assert.equal((await fetchPath(`/packs/ci/${pendingRow?.fingerprint}/files/panel/index.html`)).status, 404);
    assert.deepEqual(packStore.statusFrame().panels, []);
    const guardedRoute = await fetchPath('/control-token');
    assert.equal(guardedRoute.status, 401);
    assert.equal(guardedRoute.headers.get('content-security-policy'), "frame-src 'self' blob: data:");

    assert.deepEqual(await packStore.approve(pendingRow?.fingerprint ?? ''), { ok: true });
    const [panel] = packStore.statusFrame().panels;
    assert.equal(panel?.viewId, 'pack:ci/board');
    const pendingUrl = panel?.entryUrl ?? '';
    assert.match(pendingUrl, /^\/packs\/ci\/[0-9a-f]{64}\/files\/panel\/index\.html$/);
    assert.equal((await fetchPath(`/packs/ci/${pendingRow?.fingerprint}/files/panel/index.html`)).status, 404);
    const served = await fetchPath(pendingUrl);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), '<!doctype html><p>ci</p>');
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
    assert.equal((await fetchPath(`/packs/ci/${'0'.repeat(64)}/files/panel/index.html`)).status, 404);

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
