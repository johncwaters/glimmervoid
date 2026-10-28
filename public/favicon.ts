import type { AttentionCounts } from './focus-view/attention-core.ts';
import { decideFaviconVariant, renderFaviconSvg } from './favicon-core.ts';

function getFaviconElement() {
  const existingFavicon = document.querySelector('link[rel="icon"]');
  if (existingFavicon instanceof HTMLLinkElement) return existingFavicon;

  const faviconElement = document.createElement('link');
  faviconElement.rel = 'icon';
  faviconElement.type = 'image/svg+xml';
  document.head.append(faviconElement);
  return faviconElement;
}

const faviconElement = getFaviconElement();
let currentFaviconVariant = 'idle';

export function refreshFavicon(counts: AttentionCounts) {
  const faviconVariant = decideFaviconVariant(counts);
  if (faviconVariant === currentFaviconVariant) return;

  currentFaviconVariant = faviconVariant;
  faviconElement.href = `data:image/svg+xml,${encodeURIComponent(renderFaviconSvg(faviconVariant))}`;
}
