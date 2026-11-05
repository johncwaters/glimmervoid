import { decideOpenExternalRequest } from './open-external-core.ts';

const LINK_PREVIEW_LIMITS = { maxBodyBytes: 65536, maxIconBytes: 16384, timeoutMs: 3000, maxRedirects: 3, cacheEntries: 500, maxTitleCharacters: 200 } as const;

const ICON_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/jpeg', 'image/webp', 'image/svg+xml']);

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

type LinkPreviewVerdict = { ok: true; url: string } | { ok: false; status: number; error: string };

type LinkPreviewGateInput = Parameters<typeof decideOpenExternalRequest>[0] & { isEnabled: boolean };

function decideLinkPreviewRequest(input: LinkPreviewGateInput): LinkPreviewVerdict {
  const verdict = decideOpenExternalRequest(input);
  if (!verdict.ok) return verdict;
  if (!input.isEnabled) return { ok: false, status: 404, error: 'link previews are off' };
  return verdict;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    const lowerBody = body.toLowerCase();
    if (lowerBody.startsWith('#x')) return codePointOrEntity(Number.parseInt(lowerBody.slice(2), 16), entity);
    if (lowerBody.startsWith('#')) return codePointOrEntity(Number.parseInt(lowerBody.slice(1), 10), entity);
    return NAMED_ENTITIES[lowerBody] ?? entity;
  });
}

function codePointOrEntity(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return entity;
  return String.fromCodePoint(codePoint);
}

function attributeValue(tag: string, attributeName: string): string | null {
  const match = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function resolveHttpHref(href: string, pageUrl: string): string | null {
  try {
    const resolved = new URL(decodeHtmlEntities(href.trim()), pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function extractTitle(htmlHead: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(htmlHead);
  if (!match) return null;
  const title = decodeHtmlEntities(match[1] ?? '').replace(/\s+/g, ' ').trim();
  if (title.length === 0) return null;
  return title.slice(0, LINK_PREVIEW_LIMITS.maxTitleCharacters);
}

function extractIconHref(htmlHead: string, pageUrl: string): string | null {
  for (const tag of htmlHead.match(/<link\b[^>]*>/gi) ?? []) {
    const relation = attributeValue(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    if (!relation.includes('icon')) continue;
    const href = attributeValue(tag, 'href');
    if (!href) continue;
    const resolved = resolveHttpHref(href, pageUrl);
    if (resolved) return resolved;
  }
  return resolveHttpHref('/favicon.ico', pageUrl);
}

function extractTitleAndIconHref(htmlHead: string, pageUrl: string): { title: string | null; iconHref: string | null } {
  return { title: extractTitle(htmlHead), iconHref: extractIconHref(htmlHead, pageUrl) };
}

function iconContentTypeOf(contentTypeHeader: string | undefined): string | null {
  const contentType = (contentTypeHeader ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return ICON_CONTENT_TYPES.has(contentType) ? contentType : null;
}

function isHtmlContentType(contentTypeHeader: string | undefined): boolean {
  const contentType = (contentTypeHeader ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

export {
  LINK_PREVIEW_LIMITS,
  decideLinkPreviewRequest,
  extractTitleAndIconHref,
  iconContentTypeOf,
  isHtmlContentType,
};
