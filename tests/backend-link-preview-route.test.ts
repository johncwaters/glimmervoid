import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IncomingHttpHeaders, Server } from 'node:http';

import { createBackendHttpApp } from '../server/backend/backend-http.ts';
import type { BackendHttpDependencies } from '../server/backend/backend-http.ts';
import { createLinkPreviewFetcher } from '../server/link-preview-fetcher.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const PAGE_TOKEN = 'link-preview-page-token';
const ICON_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const OVERSIZED_PADDING = 'x'.repeat(70 * 1024);

type SiteVisit = { path: string; headers: IncomingHttpHeaders };

async function startSite(): Promise<{ server: Server; port: number; visits: SiteVisit[] }> {
  const visits: SiteVisit[] = [];
  let port = 0;
  let flakyHits = 0;
  const server = http.createServer((req, res) => {
    visits.push({ path: req.url ?? '', headers: req.headers });
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'session=abc' });
      res.end('<html><head><title> Sign in &amp; continue </title><link rel="shortcut icon" href="/icon.png"></head></html>');
      return;
    }
    if (req.url === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ICON_BYTES);
      return;
    }
    if (req.url === '/to-loopback-literal') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/page` });
      res.end();
      return;
    }
    if (req.url === '/flaky') {
      flakyHits += 1;
      res.writeHead(flakyHits === 1 ? 503 : 200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Up now</title></head></html>');
      return;
    }
    if (req.url === '/oversized') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head>${OVERSIZED_PADDING}<title>Past the cap</title></head></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  port = await listenOnLoopback(server);
  return { server, port, visits };
}

function appDependencies(overrides: Partial<BackendHttpDependencies>): BackendHttpDependencies {
  return {
    staticDir: null,
    configStore: { configPath: path.join(os.tmpdir(), 'glimmervoid-link-preview-config.json') },
    remote: { allowedOrigins: [] },
    remoteAuth: null,
    allowedHosts: [],
    listenerPortsFor: (socket) => (typeof socket?.localPort === 'number' ? [socket.localPort] : []),
    pageToken: PAGE_TOKEN,
    tokenMatches: (presented) => presented === PAGE_TOKEN,
    hookRouter: { handle: () => ({ status: 200, reason: 'ok' }) },
    getSession: () => null,
    getUsage: () => ({ ingestStatusline: () => {} }),
    logger: { warn: () => {} },
    ...overrides,
  };
}

async function startApp(overrides: Partial<BackendHttpDependencies>): Promise<{ server: Server; base: string }> {
  const server = http.createServer(createBackendHttpApp(appDependencies(overrides)));
  await listenOnLoopback(server);
  return { server, base: `http://127.0.0.1:${boundPort(server)}` };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await closeServer(server);
}

function postLinkPreview(base: string, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/link-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-glimmervoid-page-token': PAGE_TOKEN, ...headers },
    body: JSON.stringify({ url }),
  });
}

test('the link preview route fetches a title and icon without credentials, retries a failed page, and refuses loopback before and after a redirect', async () => {
  const site = await startSite();
  const onlyLocalhostNameCountsAsPublic = (_address: string, hostname: string) => hostname === 'localhost';
  const { server, base } = await startApp({
    isLinkPreviewEnabled: () => true,
    fetchLinkPreview: createLinkPreviewFetcher({ isAllowedAddress: onlyLocalhostNameCountsAsPublic }),
  });
  try {
    const page = await postLinkPreview(base, `http://user:secret@localhost:${site.port}/page`);
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), { title: 'Sign in & continue', iconDataUrl: `data:image/png;base64,${ICON_BYTES.toString('base64')}` });
    for (const visit of site.visits) {
      assert.equal(visit.headers.cookie, undefined);
      assert.equal(visit.headers.authorization, undefined);
    }

    const visitsBeforeRedirect = site.visits.length;
    const redirected = await postLinkPreview(base, `http://localhost:${site.port}/to-loopback-literal`);
    assert.deepEqual(await redirected.json(), {});
    assert.deepEqual(site.visits.slice(visitsBeforeRedirect).map((visit) => visit.path), ['/to-loopback-literal']);

    const whileDown = await postLinkPreview(base, `http://localhost:${site.port}/flaky`);
    assert.deepEqual(await whileDown.json(), {});
    const afterRecovery = await postLinkPreview(base, `http://localhost:${site.port}/flaky`);
    assert.equal((await afterRecovery.json()).title, 'Up now');

    const oversized = await postLinkPreview(base, `http://localhost:${site.port}/oversized`);
    assert.deepEqual(await oversized.json(), {});
  } finally {
    await stopServer(server);
    await stopServer(site.server);
  }
});

test('the default address policy refuses loopback names and literals, and a switched-off setting fetches nothing', async () => {
  const site = await startSite();
  const defaultFetcher = await startApp({ isLinkPreviewEnabled: () => true, fetchLinkPreview: createLinkPreviewFetcher() });
  const switchedOff = await startApp({ isLinkPreviewEnabled: () => false, fetchLinkPreview: createLinkPreviewFetcher({ isAllowedAddress: () => true }) });
  try {
    for (const url of [`http://127.0.0.1:${site.port}/page`, `http://localhost:${site.port}/page`, `http://[::ffff:127.0.0.1]:${site.port}/page`]) {
      const refused = await postLinkPreview(defaultFetcher.base, url);
      assert.deepEqual(await refused.json(), {}, url);
    }
    const off = await postLinkPreview(switchedOff.base, `http://127.0.0.1:${site.port}/page`);
    assert.equal(off.status, 404);
    const noToken = await postLinkPreview(defaultFetcher.base, `http://127.0.0.1:${site.port}/page`, { 'x-glimmervoid-page-token': 'guess' });
    assert.equal(noToken.status, 403);
    assert.deepEqual(site.visits, []);
  } finally {
    await stopServer(defaultFetcher.server);
    await stopServer(switchedOff.server);
    await stopServer(site.server);
  }
});
