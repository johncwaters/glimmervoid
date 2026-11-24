import type { OfflinePageKind } from './offline-page-kind-core.ts';

type ExtendableEventLike = Event & { waitUntil(pending: Promise<unknown>): void };
type FetchEventLike = Event & { request: Request; respondWith(response: Promise<Response>): void };
type ServiceWorkerScopeLike = { skipWaiting(): Promise<void>; clients: { claim(): Promise<void> } };

const SERVER_PROBE_PATH = '/manifest.webmanifest';
const SERVER_PROBE_INTERVAL_MS = 2000;
const START_LINK = 'glimmervoid://start';

const TAILSCALE_APP_LINK = 'intent://navigate#Intent;scheme=tailscale;package=com.tailscale.ipn;end';

const OFFLINE_PAGE_STYLE = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0d15; color: #cfcbd9; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; padding: 0 16px; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; color: #efedf6; }
  p { margin: 0 0 20px; color: #b0aabf; }
  strong { color: #efedf6; font-weight: 600; overflow-wrap: anywhere; }
  .action { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #b688fe; color: #0f0d15; font-weight: 600; text-decoration: none; }
  .action:focus-visible { outline: 2px solid #efedf6; outline-offset: 2px; }
  .action[hidden] { display: none; }
  #status { min-height: 1.5em; margin-top: 16px; }
  .hint { margin-top: 24px; font-size: 13px; }
  code { font-size: 12px; }
`;

const RELOAD_WHEN_SERVER_ANSWERS_SCRIPT = `
  setInterval(() => {
    fetch('${SERVER_PROBE_PATH}', { cache: 'no-store' }).then((response) => { if (response.ok) location.reload(); }, () => {});
  }, ${SERVER_PROBE_INTERVAL_MS});
`;

const LOCAL_PAGE_BODY = `
  <h1>Glimmervoid is not running</h1>
  <p>Start it here, and this window opens the dashboard as soon as it is ready.</p>
  <a class="action" id="start" href="${START_LINK}">Start Glimmervoid</a>
  <div id="status" role="status"></div>
  <p class="hint">Nothing happening? Double-click the Glimmervoid icon on your desktop, or run <code>glimmervoid open</code> in a terminal.</p>
  <p class="hint">Start Glimmervoid runs it on this machine. If this window reaches Glimmervoid on another machine through an SSH tunnel, reconnect the tunnel instead.</p>
`;

const LOCAL_PAGE_SCRIPT = `
  document.getElementById('start').addEventListener('click', () => {
    document.getElementById('status').textContent = 'Starting Glimmervoid. The dashboard opens when it is ready.';
  });
`;

const SHOW_TAILSCALE_LINK_ON_ANDROID_SCRIPT = `
  if (/Android/.test(navigator.userAgent)) document.getElementById('open-tailscale').hidden = false;
`;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function tailnetPageBody(host: string): string {
  return `
  <h1>Can't reach Glimmervoid</h1>
  <p><strong>${escapeHtml(host)}</strong> is on your tailnet. Turn on Tailscale on this device, and this page opens the dashboard as soon as it answers.</p>
  <a class="action" id="open-tailscale" href="${TAILSCALE_APP_LINK}" hidden>Open Tailscale</a>
  <div id="status" role="status">Checking every few seconds.</div>
  <p class="hint">Tailscale already on? The machine running Glimmervoid may be asleep or stopped.</p>
`;
}

function remotePageBody(host: string): string {
  return `
  <h1>Can't reach Glimmervoid</h1>
  <p><strong>${escapeHtml(host)}</strong> is not answering. Check this device's network, VPN or tunnel, and this page opens the dashboard as soon as it answers.</p>
  <div id="status" role="status">Checking every few seconds.</div>
`;
}

function offlinePageContent(kind: OfflinePageKind, host: string): { body: string; script: string } {
  switch (kind) {
    case 'local':
      return { body: LOCAL_PAGE_BODY, script: LOCAL_PAGE_SCRIPT };
    case 'tailnet':
      return { body: tailnetPageBody(host), script: SHOW_TAILSCALE_LINK_ON_ANDROID_SCRIPT };
    case 'remote':
      return { body: remotePageBody(host), script: '' };
  }
}

function offlinePageHtml(kind: OfflinePageKind, host: string): string {
  const { body, script } = offlinePageContent(kind, host);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Glimmervoid</title>
<style>${OFFLINE_PAGE_STYLE}</style>
</head>
<body>
<main>${body}</main>
<script>${script}${RELOAD_WHEN_SERVER_ANSWERS_SCRIPT}</script>
</body>
</html>
`;
}

function parseOfflinePageKind(value: string | null): OfflinePageKind {
  if (value === 'tailnet' || value === 'remote') return value;
  return 'local';
}

const offlinePageKindForThisHost = parseOfflinePageKind(new URL(self.location.href).searchParams.get('page'));

function isExtendableEvent(event: Event): event is ExtendableEventLike {
  return 'waitUntil' in event;
}

function isFetchEvent(event: Event): event is FetchEventLike {
  return 'request' in event && 'respondWith' in event;
}

function isServiceWorkerScope(scope: object): scope is ServiceWorkerScopeLike {
  return 'skipWaiting' in scope && 'clients' in scope;
}

function offlinePageResponse(request: Request): Response {
  const html = offlinePageHtml(offlinePageKindForThisHost, new URL(request.url).host);
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function navigateOrOfflinePage(request: Request): Promise<Response> {
  return fetch(request).catch(() => offlinePageResponse(request));
}

const workerScope: object = self;

self.addEventListener('install', (event) => {
  if (!isExtendableEvent(event) || !isServiceWorkerScope(workerScope)) return;
  event.waitUntil(workerScope.skipWaiting());
});

self.addEventListener('activate', (event) => {
  if (!isExtendableEvent(event) || !isServiceWorkerScope(workerScope)) return;
  event.waitUntil(workerScope.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (!isFetchEvent(event) || event.request.mode !== 'navigate') return;
  event.respondWith(navigateOrOfflinePage(event.request));
});
