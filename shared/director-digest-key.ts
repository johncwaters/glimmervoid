const DIRECTOR_DIGEST_KEY_PREFIX = 'dir-';
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function sessionKeyOf(sessionId: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function directorDigestKeyOf(sessionId: string, openedAt: number): string {
  return `${DIRECTOR_DIGEST_KEY_PREFIX}${sessionKeyOf(sessionId)}-${Math.max(0, Math.trunc(openedAt)).toString(36)}`;
}
