import { isExternalHttpUrl, isNewTabActivation, shouldOpenLinksOnHost } from './external-link-core.ts';
import { loadPageToken } from './ws-token.ts';

function opensLinksOnHost(): boolean {
  return shouldOpenLinksOnHost({ userAgent: navigator.userAgent, pageHostname: location.hostname });
}

function openInThisBrowser(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function askHostToOpen(url: string): Promise<boolean> {
  try {
    const token = await loadPageToken();
    const response = await fetch('/open-external', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-glimmervoid-page-token': token },
      body: JSON.stringify({ url }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function openExternalUrl(url: string): void {
  if (!opensLinksOnHost() || !isExternalHttpUrl(url)) {
    openInThisBrowser(url);
    return;
  }
  void askHostToOpen(url).then((openedOnHost) => {
    if (!openedOnHost) openInThisBrowser(url);
  });
}

function redirectNewTabAnchor(event: MouseEvent): void {
  if (event.defaultPrevented) return;
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (!isNewTabActivation({ button: event.button, opensInNewTab: anchor.target === '_blank' })) return;
  if (!isExternalHttpUrl(anchor.href)) return;
  event.preventDefault();
  openExternalUrl(anchor.href);
}

export function routeExternalAnchorsThroughHost(root: Document): void {
  if (!opensLinksOnHost()) return;
  root.addEventListener('click', redirectNewTabAnchor, true);
  root.addEventListener('auxclick', redirectNewTabAnchor, true);
}
