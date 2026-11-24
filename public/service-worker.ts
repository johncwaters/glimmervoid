import type { OfflinePageKind } from './offline-page-kind-core.ts';

type ExtendableEventLike = Event & { waitUntil(pending: Promise<unknown>): void };
type FetchEventLike = Event & { request: Request; respondWith(response: Promise<Response>): void };
type ServiceWorkerScopeLike = { skipWaiting(): Promise<void>; clients: { claim(): Promise<void> } };

const SERVER_PROBE_PATH = '/manifest.webmanifest';
const SERVER_PROBE_INTERVAL_MS = 2000;
const START_LINK = 'glimmervoid://start';

const TAILSCALE_APP_LINK = 'intent://navigate#Intent;scheme=tailscale;package=com.tailscale.ipn;end';

const OFFLINE_PAGE_STYLE = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0d15; color: #b0aabf; font-family: 'CommitMono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Menlo', monospace; }
  main { max-width: 22rem; padding: 0 16px; text-align: center; }
  h1 { font-size: 16px; line-height: 1.3; font-weight: 700; margin: 0 0 8px; color: #efedf6; }
  p { font-size: 14px; line-height: 1.5; margin: 0 0 24px; text-wrap: balance; }
  .action { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #b688fe; color: #0f0d15; font-weight: 700; text-decoration: none; }
  .action:focus-visible { outline: 2px solid #efedf6; outline-offset: 2px; }
  .action[hidden] { display: none; }
`;

const RELOAD_WHEN_SERVER_ANSWERS_SCRIPT = `
  setInterval(() => {
    fetch('${SERVER_PROBE_PATH}', { cache: 'no-store' }).then((response) => { if (response.ok) location.reload(); }, () => {});
  }, ${SERVER_PROBE_INTERVAL_MS});
`;

const LOCAL_PAGE_BODY = `
  <h1>Glimmervoid is not running</h1>
  <p id="status" role="status">Start it, and the dashboard opens when it is ready.</p>
  <a class="action" id="start" href="${START_LINK}">Start Glimmervoid</a>
`;

const LOCAL_PAGE_SCRIPT = `
  document.getElementById('start').addEventListener('click', () => {
    document.getElementById('status').textContent = 'Starting. The dashboard opens when it is ready.';
  });
`;

const TAILNET_PAGE_BODY = `
  <h1>Can't reach Glimmervoid</h1>
  <p>Turn on Tailscale. The dashboard opens when it connects.</p>
  <a class="action" id="open-tailscale" href="${TAILSCALE_APP_LINK}" hidden>Open Tailscale</a>
`;

const SHOW_TAILSCALE_LINK_ON_ANDROID_SCRIPT = `
  if (/Android/.test(navigator.userAgent)) document.getElementById('open-tailscale').hidden = false;
`;

const REMOTE_PAGE_BODY = `
  <h1>Can't reach Glimmervoid</h1>
  <p>Check your connection. The dashboard opens when it is back.</p>
`;

function offlinePageContent(kind: OfflinePageKind): { body: string; script: string } {
  switch (kind) {
    case 'local':
      return { body: LOCAL_PAGE_BODY, script: LOCAL_PAGE_SCRIPT };
    case 'tailnet':
      return { body: TAILNET_PAGE_BODY, script: SHOW_TAILSCALE_LINK_ON_ANDROID_SCRIPT };
    case 'remote':
      return { body: REMOTE_PAGE_BODY, script: '' };
  }
}

function offlinePageHtml(kind: OfflinePageKind): string {
  const { body, script } = offlinePageContent(kind);
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

function offlinePageResponse(): Response {
  return new Response(offlinePageHtml(offlinePageKindForThisHost), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function navigateOrOfflinePage(request: Request): Promise<Response> {
  return fetch(request).catch(() => offlinePageResponse());
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
