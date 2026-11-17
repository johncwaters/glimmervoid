import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { mountPreviewProxy } from '../server/preview-proxy.ts';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

test('a preview forwards the full path to the session port, strips operator credentials even behind Expect: 100-continue, drops upstream framing headers, and sandboxes the page with CORS for its opaque origin', async (t) => {
  const upstream = http.createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'");
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Set-Cookie', 'glimmervoid_session=stolen; Path=/');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ url: request.url, cookie: request.headers.cookie ?? null, token: request.headers['x-glimmervoid-page-token'] ?? null }));
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  let dashboardPort = 0;
  mountPreviewProxy(app, {
    previewPortOf: (sessionId) => (sessionId === SESSION_ID ? upstreamPort : sessionId === 'self' ? dashboardPort : null),
    glimmervoidPortsFor: () => [dashboardPort],
    logger: { warn: () => {} },
  });
  const dashboard = http.createServer(app);
  dashboardPort = await listen(dashboard);
  t.after(() => { upstream.close(); dashboard.close(); });

  const forwarded = await fetch(`http://127.0.0.1:${dashboardPort}/app-preview/${SESSION_ID}/assets/app.js?v=2`, { headers: { cookie: 'glimmervoid_auth=secret', 'x-glimmervoid-page-token': 'page-secret' } });
  assert.equal(forwarded.status, 200);
  assert.deepEqual(await forwarded.json(), { url: `/app-preview/${SESSION_ID}/assets/app.js?v=2`, cookie: null, token: null });
  assert.equal(forwarded.headers.get('content-security-policy'), 'sandbox allow-scripts allow-forms');
  assert.equal(forwarded.headers.get('x-frame-options'), null);
  assert.equal(forwarded.headers.get('set-cookie'), null);

  const fromSandboxedPage = await fetch(`http://127.0.0.1:${dashboardPort}/app-preview/${SESSION_ID}/main.js`, { headers: { origin: 'null' } });
  assert.equal(fromSandboxedPage.headers.get('access-control-allow-origin'), 'null');

  const expectingContinue = await new Promise<string>((resolve) => {
    const request = http.request(`http://127.0.0.1:${dashboardPort}/app-preview/${SESSION_ID}/form`, { method: 'POST', headers: { cookie: 'glimmervoid_auth=secret', expect: '100-continue', 'content-length': '2' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('continue', () => request.end('{}'));
  });
  assert.equal(JSON.parse(expectingContinue).cookie, null);

  assert.equal((await fetch(`http://127.0.0.1:${dashboardPort}/app-preview/unknown-session/`)).status, 404);
  const selfPointing = await fetch(`http://127.0.0.1:${dashboardPort}/app-preview/self/`);
  assert.equal(selfPointing.status, 404);
  assert.match(await selfPointing.text(), /own port/);
});
