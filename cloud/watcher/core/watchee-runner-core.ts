import crypto from 'node:crypto';

const UUID_VERSION_8 = 0x80;
const UUID_VARIANT_RFC = 0x80;

function jobIdForEvent(kind: string, eventKey: string): string {
  const digest = crypto.createHash('sha256').update(`${kind}:${eventKey}`).digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | UUID_VERSION_8;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | UUID_VARIANT_RFC;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function intervalStartMs(nowMs: number, everyMs: number): number {
  return nowMs - (nowMs % everyMs);
}

function pruneSentEvents(sentAtByJobId: Readonly<Record<string, number>>, nowMs: number, maxAgeMs: number): Record<string, number> {
  return Object.fromEntries(Object.entries(sentAtByJobId).filter(([, sentAtMs]) => nowMs - sentAtMs <= maxAgeMs));
}

function createWatcheeJob<Payload>(jobId: string, kind: string, payload: Payload, sentAt: Date) {
  return { version: 1, jobId, sentAt: sentAt.toISOString(), kind, payload } as const;
}

export { createWatcheeJob, intervalStartMs, jobIdForEvent, pruneSentEvents };
