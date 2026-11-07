import crypto from 'node:crypto';

type LinkDirection = 'watcher-to-server' | 'server-to-watcher';

interface SignedRequest {
  method: string;
  path: string;
  requestId: string;
  timestampMs: number;
  body: string;
}

type Verdict = { ok: true } | { ok: false; reason: 'bad-signature' | 'stale' | 'replayed' };

const REQUEST_ID_HEADER = 'x-glimmervoid-request-id';
const TIMESTAMP_HEADER = 'x-glimmervoid-timestamp';
const SIGNATURE_HEADER = 'x-glimmervoid-signature';
const MAX_CLOCK_SKEW_MS = 300_000;
const REPLAY_WINDOW_MS = 600_000;
const KEY_BYTES = 32;
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

function directionKey(linkSecret: Buffer, direction: LinkDirection): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', linkSecret, Buffer.alloc(0), `glimmervoid-link:${direction}`, KEY_BYTES));
}

function credentialStoreKey(linkSecret: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', linkSecret, Buffer.alloc(0), 'glimmervoid-link:credential-store', KEY_BYTES));
}

function signRequest(key: Buffer, request: SignedRequest): string {
  const signedText = [request.method.toUpperCase(), request.path, request.requestId, String(request.timestampMs), request.body].join('\n');
  return crypto.createHmac('sha256', key).update(signedText).digest('hex');
}

function signedHeaders(key: Buffer, request: Omit<SignedRequest, 'requestId' | 'timestampMs'>, nowMs: number): Record<string, string> {
  const requestId = crypto.randomUUID();
  const signature = signRequest(key, { ...request, requestId, timestampMs: nowMs });
  return { [REQUEST_ID_HEADER]: requestId, [TIMESTAMP_HEADER]: String(nowMs), [SIGNATURE_HEADER]: signature };
}

function createRecentRequestIds(): Map<string, number> {
  return new Map();
}

function forgetExpiredRequestIds(seenRequestIds: Map<string, number>, nowMs: number): void {
  for (const [requestId, seenAtMs] of seenRequestIds) {
    if (nowMs - seenAtMs < REPLAY_WINDOW_MS) return;
    seenRequestIds.delete(requestId);
  }
}

function verifyRequest(key: Buffer, request: SignedRequest & { signature: string }, nowMs: number, seenRequestIds: Map<string, number>): Verdict {
  if (!REQUEST_ID_PATTERN.test(request.requestId) || !SIGNATURE_PATTERN.test(request.signature)) return { ok: false, reason: 'bad-signature' };
  const expectedSignature = Buffer.from(signRequest(key, request), 'hex');
  if (!crypto.timingSafeEqual(expectedSignature, Buffer.from(request.signature, 'hex'))) return { ok: false, reason: 'bad-signature' };
  if (!Number.isSafeInteger(request.timestampMs) || Math.abs(nowMs - request.timestampMs) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale' };
  forgetExpiredRequestIds(seenRequestIds, nowMs);
  if (seenRequestIds.has(request.requestId)) return { ok: false, reason: 'replayed' };
  seenRequestIds.set(request.requestId, nowMs);
  return { ok: true };
}

function signedRequestFromHeaders(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string): SignedRequest & { signature: string } {
  const headerText = (name: string) => {
    const value = headers[name];
    return typeof value === 'string' ? value : '';
  };
  return { method, path, body, requestId: headerText(REQUEST_ID_HEADER), timestampMs: Number(headerText(TIMESTAMP_HEADER)), signature: headerText(SIGNATURE_HEADER) };
}

export { createRecentRequestIds, credentialStoreKey, directionKey, signRequest, signedHeaders, signedRequestFromHeaders, verifyRequest };
export type { LinkDirection, SignedRequest };
