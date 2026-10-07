import { normalizeClientTrust } from '../../shared/client-trust.ts';
import { decideOriginAllowed } from './origin-policy.ts';

const PAIR_PATH_PREFIX = '/pair/';

export type RequestTrust = 'local' | 'remote';

function classifyRequestOrigin({ localPort, remoteListenerPort }: {
  localPort?: number | null;
  remoteListenerPort?: number | null;
}): RequestTrust {
  if (remoteListenerPort == null) return 'local';
  return localPort === remoteListenerPort ? 'remote' : 'local';
}

function normalizePathname(url: unknown): { pathname: string; suspicious: boolean } {
  const raw = typeof url === 'string' ? url : '';
  const cut = raw.search(/[?#]/);
  const pathOnly = cut === -1 ? raw : raw.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return { pathname: pathOnly, suspicious: true };
  }
  const suspicious = decoded.split('/').some((segment) => (
    segment === '.' || segment === '..' || /%2e/i.test(segment)
  ));
  return { pathname: decoded, suspicious };
}

function isPairPath(pathname: unknown): boolean {
  if (typeof pathname !== 'string') return false;
  const normalized = normalizePathname(pathname);
  if (normalized.suspicious) return false;
  return normalized.pathname === '/pair' || normalized.pathname.startsWith(PAIR_PATH_PREFIX);
}

const ENCODED_WORD_SHAPE = /=\?[^?]*\?[^?]*\?[^?]*\?=/;
const ENCODED_WORD_PARTS = /^=\?([^?]*)\?([^?]*)\?([^?]*)\?=$/;
const LINEAR_WHITESPACE = /[ \t]+/;
const HEX_BYTE_PATTERN = /^[0-9a-f]{2}$/i;

function decodeQEncodedBytes(encodedText: string): number[] | null {
  const bytes: number[] = [];
  for (let index = 0; index < encodedText.length; index += 1) {
    const character = encodedText[index];
    if (character === '_') {
      bytes.push(0x20);
      continue;
    }
    if (character !== '=') {
      const characterCode = encodedText.charCodeAt(index);
      if (characterCode < 0x21 || characterCode > 0x7e) return null;
      bytes.push(characterCode);
      continue;
    }
    const hexPair = encodedText.slice(index + 1, index + 3);
    if (!HEX_BYTE_PATTERN.test(hexPair)) return null;
    bytes.push(Number.parseInt(hexPair, 16));
    index += 2;
  }
  return bytes;
}

function decodeEncodedWordBytes(encodedWord: string): number[] | null {
  const wordParts = ENCODED_WORD_PARTS.exec(encodedWord);
  if (!wordParts) return null;
  const [, charset, encoding, encodedText] = wordParts;
  if (charset.toLowerCase() !== 'utf-8' || encoding.toLowerCase() !== 'q') return null;
  return decodeQEncodedBytes(encodedText);
}

function decodeUtf8Strictly(bytes: number[]): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function decodePresentedLogin(presentedLogin: string): string | null {
  const trimmedLogin = presentedLogin.trim();
  if (!ENCODED_WORD_SHAPE.test(trimmedLogin)) return trimmedLogin;
  const loginBytes: number[] = [];
  for (const encodedWord of trimmedLogin.split(LINEAR_WHITESPACE)) {
    const wordBytes = decodeEncodedWordBytes(encodedWord);
    if (wordBytes === null) return null;
    loginBytes.push(...wordBytes);
  }
  return decodeUtf8Strictly(loginBytes);
}

function decideOwnerAccess({ ownerLogin, presentedLogin }: {
  ownerLogin: string;
  presentedLogin: unknown;
}): boolean {
  if (ownerLogin === '') return true;
  if (typeof presentedLogin !== 'string') return false;
  const decodedLogin = decodePresentedLogin(presentedLogin);
  if (decodedLogin === null) return false;
  return decodedLogin.trim().toLowerCase() === ownerLogin;
}

function decideRequestAccess({ remoteEnabled, trust, pathname, authenticated, ownerOk }: {
  remoteEnabled?: boolean;
  trust?: string;
  pathname?: unknown;
  authenticated?: unknown;
  ownerOk?: unknown;
}): { allow: boolean; action: string } {
  if (!remoteEnabled) return { allow: true, action: 'allow' };
  if (trust !== 'remote') return { allow: true, action: 'allow' };
  if (ownerOk !== true) return { allow: false, action: 'not-owner' };
  if (isPairPath(pathname)) return { allow: true, action: 'pair-page' };
  if (authenticated === true) return { allow: true, action: 'allow' };
  return { allow: false, action: 'unauthorized' };
}

function decideUpgradeAccess({
  remoteEnabled, trust, origin, authenticated, allowedOrigins = [],
  listenerPorts = [], dashboardRoute = false, tokenOk = false,
}: {
  remoteEnabled?: boolean;
  trust?: string;
  origin?: string | null;
  allowedOrigins?: unknown[];
  authenticated?: unknown;
  listenerPorts?: number[];
  dashboardRoute?: boolean;
  tokenOk?: unknown;
}): { allow: boolean; reason: string | null } {
  const originOk = decideOriginAllowed(origin, allowedOrigins, {
    listenerPorts,
    requireOrigin: dashboardRoute,
  });
  if (!originOk) return { allow: false, reason: 'origin' };
  if (remoteEnabled && trust === 'remote') {
    if (authenticated !== true) return { allow: false, reason: 'auth' };
    return { allow: true, reason: null };
  }
  if (dashboardRoute && tokenOk !== true) return { allow: false, reason: 'token' };
  return { allow: true, reason: null };
}

export {
  classifyRequestOrigin,
  decideOwnerAccess,
  decideRequestAccess,
  decideUpgradeAccess,
  isPairPath,
  normalizePathname,
  normalizeClientTrust,
};
