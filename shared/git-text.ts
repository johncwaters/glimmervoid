const SHORT_SHA_CHARS = 7;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function shortSha(sha: unknown, { chars = SHORT_SHA_CHARS, validate = false }: { chars?: number; validate?: boolean } = {}): string {
  if (typeof sha !== 'string' || !sha) return '';
  if (!validate) return sha.slice(0, chars);
  const text = sha.trim();
  if (!HEX_SHA_RE.test(text)) return '';
  return text.slice(0, chars).toLowerCase();
}

export { FULL_SHA_RE, HEX_SHA_RE, SHORT_SHA_CHARS, shortSha };
