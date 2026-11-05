import dns from 'node:dns';
import http from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { LinkPreview } from '../shared/contracts/link-preview.ts';
import { normalizedHttpUrl } from '../shared/http-url.ts';
import { LINK_PREVIEW_LIMITS, extractTitleAndIconHref, iconContentTypeOf, isHtmlContentType } from './core/link-preview-core.ts';

type AddressPolicy = (address: string, hostname: string) => boolean;

type FetchedBody = { finalUrl: string; contentType: string | undefined; bytes: Buffer; isTruncated: boolean };

const REQUEST_HEADERS = { accept: 'text/html,application/xhtml+xml,image/*;q=0.8', 'user-agent': 'Glimmervoid link preview' };
const PRIVATE_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const PRIVATE_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16],
];

const privateAddresses = new BlockList();
for (const [network, prefix] of PRIVATE_IPV4_SUBNETS) privateAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of PRIVATE_IPV6_SUBNETS) privateAddresses.addSubnet(network, prefix, 'ipv6');

const IPV4_MAPPED_PREFIX = /^::ffff:/i;

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !privateAddresses.check(address, 'ipv4');
  const unmapped = address.replace(IPV4_MAPPED_PREFIX, '');
  if (unmapped !== address && isIP(unmapped) === 4) return isPublicAddress(unmapped);
  if (IPV4_MAPPED_PREFIX.test(address)) return false;
  return !privateAddresses.check(address, 'ipv6');
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

function guardedLookup(hostname: string, isAllowedAddress: AddressPolicy): LookupFunction {
  return (lookupHostname, options, callback) => {
    dns.lookup(lookupHostname, { all: true, family: options.family ?? 0 }, (lookupError, addresses) => {
      if (lookupError) return callback(lookupError, '', 0);
      const refused = addresses.find((entry) => !isAllowedAddress(entry.address, hostname));
      if (refused || addresses.length === 0) return callback(new Error(`refused address for ${hostname}`), '', 0);
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first?.address ?? '', first?.family ?? 0);
    });
  };
}

function requestOnce(url: URL, isAllowedAddress: AddressPolicy, signal: AbortSignal): Promise<IncomingMessage> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0 && !isAllowedAddress(hostname, hostname)) return Promise.reject(new Error(`refused address ${hostname}`));
  const transport = url.protocol === 'https:' ? https : http;
  const anonymousUrl = new URL(url.href);
  anonymousUrl.username = '';
  anonymousUrl.password = '';
  const options: RequestOptions = { method: 'GET', headers: REQUEST_HEADERS, signal, lookup: guardedLookup(hostname, isAllowedAddress), agent: false };
  return new Promise((resolve, reject) => {
    const request = transport.request(anonymousUrl, options, resolve);
    request.on('error', reject);
    request.end();
  });
}

function readCapped(response: IncomingMessage, maxBytes: number): Promise<{ bytes: Buffer; isTruncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      receivedBytes += chunk.length;
      if (receivedBytes <= maxBytes) return;
      response.destroy();
      resolve({ bytes: Buffer.concat(chunks).subarray(0, maxBytes), isTruncated: true });
    });
    response.on('end', () => resolve({ bytes: Buffer.concat(chunks), isTruncated: false }));
    response.on('error', reject);
  });
}

async function fetchCapped(startUrl: string, maxBytes: number, isAllowedAddress: AddressPolicy, signal: AbortSignal): Promise<FetchedBody | null> {
  let currentUrl = startUrl;
  for (let redirectCount = 0; redirectCount <= LINK_PREVIEW_LIMITS.maxRedirects; redirectCount += 1) {
    const response = await requestOnce(new URL(currentUrl), isAllowedAddress, signal);
    const location = response.headers.location;
    if (REDIRECT_STATUSES.has(response.statusCode ?? 0) && location) {
      response.resume();
      const nextUrl = normalizedHttpUrl(new URL(location, currentUrl).href);
      if (!nextUrl) return null;
      currentUrl = nextUrl;
      continue;
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.resume();
      return null;
    }
    const body = await readCapped(response, maxBytes);
    return { finalUrl: currentUrl, contentType: response.headers['content-type'], ...body };
  }
  return null;
}

async function fetchIconDataUrl(iconUrl: string, isAllowedAddress: AddressPolicy, signal: AbortSignal): Promise<string | undefined> {
  const icon = await fetchCapped(iconUrl, LINK_PREVIEW_LIMITS.maxIconBytes, isAllowedAddress, signal);
  if (!icon || icon.isTruncated || icon.bytes.length === 0) return undefined;
  const contentType = iconContentTypeOf(icon.contentType);
  if (!contentType) return undefined;
  return `data:${contentType};base64,${icon.bytes.toString('base64')}`;
}

type PreviewOutcome = { preview: LinkPreview; isCacheable: boolean };

async function fetchPreviewUncached(url: string, isAllowedAddress: AddressPolicy): Promise<PreviewOutcome> {
  const signal = AbortSignal.timeout(LINK_PREVIEW_LIMITS.timeoutMs);
  const page = await fetchCapped(url, LINK_PREVIEW_LIMITS.maxBodyBytes, isAllowedAddress, signal);
  if (!page) return { preview: {}, isCacheable: false };
  if (!isHtmlContentType(page.contentType)) return { preview: {}, isCacheable: true };
  const { title, iconHref } = extractTitleAndIconHref(page.bytes.toString('utf8'), page.finalUrl);
  const iconDataUrl = iconHref ? await fetchIconDataUrl(iconHref, isAllowedAddress, signal).catch(() => undefined) : undefined;
  return { preview: { ...(title ? { title } : {}), ...(iconDataUrl ? { iconDataUrl } : {}) }, isCacheable: true };
}

function createLinkPreviewFetcher({ isAllowedAddress = (address: string) => isPublicAddress(address) }: { isAllowedAddress?: AddressPolicy } = {}) {
  const previewsByUrl = new Map<string, Promise<LinkPreview>>();
  return function fetchLinkPreview(url: string): Promise<LinkPreview> {
    const cached = previewsByUrl.get(url);
    if (cached) return cached;
    const preview = fetchPreviewUncached(url, isAllowedAddress)
      .catch((): PreviewOutcome => ({ preview: {}, isCacheable: false }))
      .then((outcome) => {
        if (!outcome.isCacheable && previewsByUrl.get(url) === preview) previewsByUrl.delete(url);
        return outcome.preview;
      });
    previewsByUrl.set(url, preview);
    if (previewsByUrl.size > LINK_PREVIEW_LIMITS.cacheEntries) {
      const oldestUrl = previewsByUrl.keys().next().value;
      if (oldestUrl !== undefined) previewsByUrl.delete(oldestUrl);
    }
    return preview;
  };
}

type LinkPreviewFetcher = ReturnType<typeof createLinkPreviewFetcher>;

export { createLinkPreviewFetcher };
export type { LinkPreviewFetcher };
