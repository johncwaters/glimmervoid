import { isLoopbackHostname } from '../../shared/loopback-hosts.ts';

const HOOK_VIA_SANDBOX_PROXY_ENV = 'GLIMMERVOID_HOOK_VIA_SANDBOX_PROXY';

interface SandboxProxy {
  hostname: string;
  port: number;
  authorization: string | null;
}

function decodeProxyCredential(percentEncoded: string): string | null {
  try {
    return decodeURIComponent(percentEncoded);
  } catch {
    return null;
  }
}

function decideSandboxProxy(env: Readonly<Record<string, string | undefined>>): SandboxProxy | null {
  if (env.SANDBOX_RUNTIME !== '1') return null;
  const rawProxyUrl = env.HTTP_PROXY || env.http_proxy || '';
  if (!URL.canParse(rawProxyUrl)) return null;
  const proxyUrl = new URL(rawProxyUrl);
  if (proxyUrl.protocol !== 'http:' || !proxyUrl.port || !isLoopbackHostname(proxyUrl.hostname)) return null;
  const username = decodeProxyCredential(proxyUrl.username);
  const password = decodeProxyCredential(proxyUrl.password);
  if (username === null || password === null) return null;
  return {
    hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
    port: Number(proxyUrl.port),
    authorization: username ? `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` : null,
  };
}

export { decideSandboxProxy, HOOK_VIA_SANDBOX_PROXY_ENV };
export type { SandboxProxy };
