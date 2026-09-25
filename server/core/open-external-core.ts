import { normalizedHttpUrl } from '../../shared/http-url.ts';
import { decideOriginAllowed } from './origin-policy.ts';
import type { RequestTrust } from './request-trust.ts';

const MAX_EXTERNAL_URL_LENGTH = 2048;
const OPEN_EXTERNAL_BODY_CAP_BYTES = 4096;
const HOST_OPENER_BY_PLATFORM: Readonly<Record<string, string>> = { darwin: 'open', linux: 'xdg-open' };

type OpenExternalVerdict =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string };

function hostOpenerCommandFor(platform: string): string | null {
  return HOST_OPENER_BY_PLATFORM[platform] ?? null;
}

function parseOpenableUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > MAX_EXTERNAL_URL_LENGTH) return null;
  const href = normalizedHttpUrl(candidate);
  if (!href || href.length > MAX_EXTERNAL_URL_LENGTH) return null;
  return href;
}

function decideOpenExternalRequest({
  isLoopback, trust, origin, listenerPorts, tokenOk, requestedUrl,
}: {
  isLoopback: boolean;
  trust: RequestTrust;
  origin: string | undefined;
  listenerPorts: number[];
  tokenOk: boolean;
  requestedUrl: unknown;
}): OpenExternalVerdict {
  if (!isLoopback || trust !== 'local') return { ok: false, status: 403, error: 'loopback only' };
  if (!decideOriginAllowed(origin, [], { listenerPorts, requireOrigin: true })) {
    return { ok: false, status: 403, error: 'origin not allowed' };
  }
  if (!tokenOk) return { ok: false, status: 403, error: 'page token required' };
  const url = parseOpenableUrl(requestedUrl);
  if (!url) return { ok: false, status: 400, error: 'only an absolute http or https url can be opened' };
  return { ok: true, url };
}

export {
  MAX_EXTERNAL_URL_LENGTH,
  OPEN_EXTERNAL_BODY_CAP_BYTES,
  decideOpenExternalRequest,
  hostOpenerCommandFor,
  parseOpenableUrl,
};
export type { OpenExternalVerdict };
