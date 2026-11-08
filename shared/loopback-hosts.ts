const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function loopbackOverrideOrigin(override: string | undefined, fallbackOrigin: string): string {
  if (override === undefined || override === '') return fallbackOrigin;
  const overrideUrl = URL.parse(override);
  if (overrideUrl === null || !isLoopbackHostname(overrideUrl.hostname)) return fallbackOrigin;
  return overrideUrl.origin;
}

export { isLoopbackHostname, loopbackOverrideOrigin };
