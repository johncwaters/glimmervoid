import { isLoopbackHostname } from '#shared/loopback-hosts.ts';

type OfflinePageKind = 'local' | 'tailnet' | 'remote';

const TAILNET_DOMAIN_SUFFIX = '.ts.net';

function offlinePageKind(hostname: string): OfflinePageKind {
  if (isLoopbackHostname(hostname)) return 'local';
  if (hostname.endsWith(TAILNET_DOMAIN_SUFFIX)) return 'tailnet';
  return 'remote';
}

function serviceWorkerUrl(hostname: string): string {
  return `/service-worker.js?page=${offlinePageKind(hostname)}`;
}

export { offlinePageKind, serviceWorkerUrl };
export type { OfflinePageKind };
