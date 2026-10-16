import path from 'node:path';
import { normalizedHttpUrl } from '../../shared/http-url.ts';
import { decideOriginAllowed } from './origin-policy.ts';
import type { RequestTrust } from './request-trust.ts';

const MAX_EXTERNAL_URL_LENGTH = 2048;
const OPEN_EXTERNAL_BODY_CAP_BYTES = 4096;
type HostOpener = { command: string; leadingArgs: readonly string[] };

const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';

const POSIX_HOST_OPENER_BY_PLATFORM: Readonly<Record<string, HostOpener>> = {
  darwin: { command: 'open', leadingArgs: [] },
  linux: { command: 'xdg-open', leadingArgs: [] },
};

type OpenExternalVerdict =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string };

function windowsRundll32Path(windowsSystemRoot: string | undefined): string {
  const systemRoot = windowsSystemRoot && path.win32.isAbsolute(windowsSystemRoot)
    ? windowsSystemRoot
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(systemRoot, 'System32', 'rundll32.exe');
}

function hostOpenerFor(platform: string, windowsSystemRoot: string | undefined): HostOpener | null {
  if (platform === 'win32') {
    return { command: windowsRundll32Path(windowsSystemRoot), leadingArgs: ['url.dll,FileProtocolHandler'] };
  }
  return POSIX_HOST_OPENER_BY_PLATFORM[platform] ?? null;
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
  hostOpenerFor,
  parseOpenableUrl,
};
