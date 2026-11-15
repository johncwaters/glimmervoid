type OriginProbeTarget = { host: string; port: number };
type OriginReachability = 'reachable' | 'unreachable' | 'unknown';

const ORIGIN_PROBE_TIMEOUT_MS = 2_000;
const ORIGIN_PROBE_TIMEOUT_CODE = 'ETIMEDOUT';
const PROXY_ENV_KEYS = Object.freeze(['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy']);
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([ORIGIN_PROBE_TIMEOUT_CODE, 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EAI_AGAIN']);
const DEFAULT_PORT_BY_PROTOCOL: Readonly<Record<string, number>> = Object.freeze({ 'http:': 80, 'https:': 443 });

function isProxyConfigured(env: Readonly<Record<string, string | undefined>>, proxyConfigListing: string): boolean {
  if (proxyConfigListing.trim() !== '') return true;
  return PROXY_ENV_KEYS.some((key) => (env[key] ?? '').trim() !== '');
}

function originProbeEndpoint(originUrl: string): OriginProbeTarget | null {
  const url = URL.parse(originUrl);
  const defaultPort = url === null ? undefined : DEFAULT_PORT_BY_PROTOCOL[url.protocol];
  if (url === null || defaultPort === undefined || url.hostname === '') return null;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? defaultPort : Number(url.port) };
}

function proxyConfigQueries(originUrl: string): readonly (readonly string[])[] {
  return [['config', '--get-urlmatch', 'http.proxy', originUrl], ['config', '--get', 'remote.origin.proxy']];
}

function reachabilityOf(failureCode: string | null): OriginReachability {
  if (failureCode === null) return 'reachable';
  return UNREACHABLE_CODES.has(failureCode) ? 'unreachable' : 'unknown';
}

export { ORIGIN_PROBE_TIMEOUT_CODE, ORIGIN_PROBE_TIMEOUT_MS, isProxyConfigured, originProbeEndpoint, proxyConfigQueries, reachabilityOf };
export type { OriginProbeTarget, OriginReachability };
