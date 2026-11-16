import crypto from 'node:crypto';
import { z } from 'zod';
import type { DoormanTenantOwner } from '../../shared/contracts/doorman.ts';
import { clock } from '../../shared/clock.ts';

type EdgeSessionSubject = { slug: string; workosUserId: string };
type CachedKeySet = { publicKeysById: ReadonlyMap<string, crypto.KeyObject>; fetchedAtMs: number };
type AccessTokenVerdict = 'owner' | 'refused' | 'keys-unavailable';

const EDGE_COOKIE_NAME = 'glimmervoid_edge';
const EDGE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const EDGE_COOKIE_VERSION = 'v1';
const EDGE_EXPIRY_PATTERN = /^\d{1,16}$/;
const KEY_BYTES = 32;
const ACCESS_TOKEN_SKEW_MS = 60_000;
const KEY_SET_MAX_AGE_MS = 60 * 60 * 1000;
const KEY_SET_REFETCH_GAP_MS = 5 * 60 * 1000;
const KEY_SET_FETCH_TIMEOUT_MS = 5000;
const KEY_SET_FAILED_FETCH_GAP_MS = 10_000;
const WORKOS_API_ORIGIN = 'https://api.workos.com';

const AccessTokenHeader = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(256) });
const AccessTokenClaims = z.object({ iss: z.string(), sub: z.string(), exp: z.number() });
const RsaSigningKey = z.object({ kid: z.string().min(1), kty: z.literal('RSA'), n: z.string().min(1), e: z.string().min(1) });
const KeySet = z.object({ keys: z.array(z.unknown()) });

function edgeSessionKey(linkSecret: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', linkSecret, Buffer.alloc(0), 'glimmervoid-link:edge-session', KEY_BYTES));
}

function edgeSignature(key: Buffer, subject: EdgeSessionSubject, expiresAtMs: number): string {
  return crypto.createHmac('sha256', key).update([EDGE_COOKIE_VERSION, subject.slug, subject.workosUserId, String(expiresAtMs)].join('\n')).digest('base64url');
}

function mintEdgeCookie(key: Buffer, subject: EdgeSessionSubject, nowMs: number): string {
  const expiresAtMs = nowMs + EDGE_SESSION_MS;
  return `${EDGE_COOKIE_VERSION}.${expiresAtMs}.${edgeSignature(key, subject, expiresAtMs)}`;
}

function isEdgeCookieValid(key: Buffer, cookieValue: string | undefined, subject: EdgeSessionSubject, nowMs: number): boolean {
  const [version, expiresAtText = '', presentedSignature = '', ...extraParts] = (cookieValue ?? '').split('.');
  if (version !== EDGE_COOKIE_VERSION || extraParts.length > 0 || !EDGE_EXPIRY_PATTERN.test(expiresAtText)) return false;
  const expiresAtMs = Number(expiresAtText);
  if (expiresAtMs <= nowMs || expiresAtMs > nowMs + EDGE_SESSION_MS) return false;
  const expectedSignature = Buffer.from(edgeSignature(key, subject, expiresAtMs));
  const presentedBytes = Buffer.from(presentedSignature);
  return expectedSignature.length === presentedBytes.length && crypto.timingSafeEqual(expectedSignature, presentedBytes);
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodedPart<Schema extends z.ZodType>(schema: Schema, encodedPart: string): z.infer<Schema> | null {
  const parsedPart = schema.safeParse(jsonOf(Buffer.from(encodedPart, 'base64url').toString('utf8')));
  return parsedPart.success ? parsedPart.data : null;
}

function acceptedIssuers(authkitClientId: string): ReadonlySet<string> {
  return new Set([`${WORKOS_API_ORIGIN}/`, `${WORKOS_API_ORIGIN}/user_management/${authkitClientId}`]);
}

function publicKeysOf(keySetJson: unknown): Map<string, crypto.KeyObject> | null {
  const keySet = KeySet.safeParse(keySetJson);
  if (!keySet.success) return null;
  const publicKeysById = new Map<string, crypto.KeyObject>();
  for (const candidateKey of keySet.data.keys) {
    const signingKey = RsaSigningKey.safeParse(candidateKey);
    if (!signingKey.success) continue;
    publicKeysById.set(signingKey.data.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: signingKey.data.n, e: signingKey.data.e }, format: 'jwk' }));
  }
  return publicKeysById;
}

function createAuthkitVerifier({ fetchFn = fetch, now = clock.nowMs, log = console }: { fetchFn?: typeof fetch; now?: () => number; log?: Pick<Console, 'warn'> } = {}) {
  const keySetsByClientId = new Map<string, CachedKeySet>();
  const keySetFetchesByClientId = new Map<string, Promise<CachedKeySet | null>>();
  const nextFetchAtMsByClientId = new Map<string, number>();

  async function fetchKeySet(authkitClientId: string): Promise<CachedKeySet | null> {
    nextFetchAtMsByClientId.set(authkitClientId, now() + KEY_SET_FAILED_FETCH_GAP_MS);
    try {
      const response = await fetchFn(`${WORKOS_API_ORIGIN}/sso/jwks/${encodeURIComponent(authkitClientId)}`, { signal: AbortSignal.timeout(KEY_SET_FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        await response.body?.cancel();
        log.warn(`[doorman] WorkOS answered ${response.status} for the signing keys of ${authkitClientId}`);
        return null;
      }
      const publicKeysById = publicKeysOf(await response.json());
      if (publicKeysById === null) {
        log.warn(`[doorman] WorkOS sent signing keys for ${authkitClientId} in a shape the doorman does not read`);
        return null;
      }
      const keySet = { publicKeysById, fetchedAtMs: now() };
      keySetsByClientId.set(authkitClientId, keySet);
      nextFetchAtMsByClientId.set(authkitClientId, keySet.fetchedAtMs + KEY_SET_REFETCH_GAP_MS);
      return keySet;
    } catch (fetchError) {
      log.warn(`[doorman] the WorkOS signing keys of ${authkitClientId} could not be read: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      return null;
    }
  }

  function sharedKeySetFetch(authkitClientId: string): Promise<CachedKeySet | null> {
    const inFlight = keySetFetchesByClientId.get(authkitClientId);
    if (inFlight !== undefined) return inFlight;
    const keySetFetch = fetchKeySet(authkitClientId).finally(() => keySetFetchesByClientId.delete(authkitClientId));
    keySetFetchesByClientId.set(authkitClientId, keySetFetch);
    return keySetFetch;
  }

  async function publicKeyFor(authkitClientId: string, keyId: string): Promise<crypto.KeyObject | 'unknown' | 'unavailable'> {
    const cachedKeySet = keySetsByClientId.get(authkitClientId);
    const cachedKey = cachedKeySet?.publicKeysById.get(keyId);
    const isCachedSetFresh = cachedKeySet !== undefined && now() - cachedKeySet.fetchedAtMs < KEY_SET_MAX_AGE_MS;
    if (cachedKey !== undefined && isCachedSetFresh) return cachedKey;
    const nextFetchAtMs = nextFetchAtMsByClientId.get(authkitClientId);
    if (nextFetchAtMs !== undefined && now() < nextFetchAtMs) return cachedKey ?? (cachedKeySet === undefined ? 'unavailable' : 'unknown');
    const refreshedKeySet = await sharedKeySetFetch(authkitClientId);
    if (refreshedKeySet === null) return cachedKey ?? 'unavailable';
    return refreshedKeySet.publicKeysById.get(keyId) ?? 'unknown';
  }

  async function accessTokenVerdict(accessToken: string, owner: DoormanTenantOwner): Promise<AccessTokenVerdict> {
    const [encodedHeader = '', encodedClaims = '', encodedSignature = '', ...extraParts] = accessToken.split('.');
    if (extraParts.length > 0 || encodedSignature === '') return 'refused';
    const header = decodedPart(AccessTokenHeader, encodedHeader);
    const claims = decodedPart(AccessTokenClaims, encodedClaims);
    if (header === null || claims === null) return 'refused';
    if (claims.sub !== owner.workosUserId || !acceptedIssuers(owner.authkitClientId).has(claims.iss)) return 'refused';
    if (claims.exp * 1000 + ACCESS_TOKEN_SKEW_MS <= now()) return 'refused';
    const publicKey = await publicKeyFor(owner.authkitClientId, header.kid);
    if (publicKey === 'unavailable') return 'keys-unavailable';
    if (publicKey === 'unknown') return 'refused';
    return crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, Buffer.from(encodedSignature, 'base64url')) ? 'owner' : 'refused';
  }

  return { accessTokenVerdict };
}

type AuthkitVerifier = ReturnType<typeof createAuthkitVerifier>;

export { EDGE_COOKIE_NAME, EDGE_SESSION_MS, createAuthkitVerifier, edgeSessionKey, isEdgeCookieValid, mintEdgeCookie };
export type { AuthkitVerifier };
