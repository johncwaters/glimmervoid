type ExtendableEventLike = Event & { waitUntil(pending: Promise<unknown>): void };
type FetchEventLike = Event & { request: Request; respondWith(response: Promise<Response>): void };
type ServiceWorkerScopeLike = { skipWaiting(): Promise<void>; clients: { claim(): Promise<void> } };

const SERVER_PROBE_PATH = '/manifest.webmanifest';
const SERVER_PROBE_INTERVAL_MS = 2000;
const START_LINK = 'glimmervoid://start';

const OFFLINE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Glimmervoid</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0d15; color: #cfcbd9; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; padding: 0 16px; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; color: #efedf6; }
  p { margin: 0 0 20px; color: #b0aabf; }
  .start { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #b688fe; color: #0f0d15; font-weight: 600; text-decoration: none; }
  .start:focus-visible { outline: 2px solid #efedf6; outline-offset: 2px; }
  #status { min-height: 1.5em; margin-top: 16px; }
  .hint { margin-top: 24px; font-size: 13px; }
  code { font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Glimmervoid is not running</h1>
  <p>Start it here, and this window opens the dashboard as soon as it is ready.</p>
  <a class="start" id="start" href="${START_LINK}">Start Glimmervoid</a>
  <div id="status" role="status"></div>
  <p class="hint">Nothing happening? Double-click the Glimmervoid icon on your desktop, or run <code>glimmervoid open</code> in a terminal.</p>
  <p class="hint">Start Glimmervoid runs it on this machine. If this window reaches Glimmervoid on another machine through an SSH tunnel, reconnect the tunnel instead.</p>
</main>
<script>
  document.getElementById('start').addEventListener('click', () => {
    document.getElementById('status').textContent = 'Starting Glimmervoid. The dashboard opens when it is ready.';
  });
  setInterval(() => {
    fetch('${SERVER_PROBE_PATH}', { cache: 'no-store' }).then((response) => { if (response.ok) location.reload(); }, () => {});
  }, ${SERVER_PROBE_INTERVAL_MS});
</script>
</body>
</html>
`;

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
  return new Response(OFFLINE_PAGE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
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
