const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

export function normalizedHttpUrl(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.href;
}
