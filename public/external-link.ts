import { LinkPreview } from '#shared/contracts/link-preview.ts';
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

const MAX_CACHED_LINK_PREVIEWS = 500;
const linkPreviewsByUrl = new Map<string, Promise<LinkPreview>>();

async function requestLinkPreview(url: string): Promise<LinkPreview> {
  try {
    const token = await loadPageToken();
    const response = await fetch('/link-preview', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-glimmervoid-page-token': token },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return {};
    const parsed = LinkPreview.safeParse(await response.json());
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function hasPreviewContent(preview: LinkPreview) {
  return preview.title !== undefined || preview.iconDataUrl !== undefined;
}

export function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const cached = linkPreviewsByUrl.get(url);
  if (cached) return cached;
  const preview = requestLinkPreview(url).then((answer) => {
    if (!hasPreviewContent(answer) && linkPreviewsByUrl.get(url) === preview) linkPreviewsByUrl.delete(url);
    return answer;
  });
  linkPreviewsByUrl.set(url, preview);
  if (linkPreviewsByUrl.size > MAX_CACHED_LINK_PREVIEWS) {
    const oldestUrl = linkPreviewsByUrl.keys().next().value;
    if (oldestUrl !== undefined) linkPreviewsByUrl.delete(oldestUrl);
  }
  return preview;
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
