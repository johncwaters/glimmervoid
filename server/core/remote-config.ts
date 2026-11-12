import path from 'node:path';
import { isRecord } from '../../shared/coerce.ts';
export interface RemoteConfig {
  port: number | null;
  publicHost: string;
  allowedOrigins: string[];
  ownerLogin: string;
}

function toPort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function resolveLocalPort({ envPort, configPort, defaultPort }: { envPort: string | undefined; configPort: unknown; defaultPort: number }): number {
  if (envPort) return Number.parseInt(envPort, 10);
  return typeof configPort === 'number' && configPort > 0 ? configPort : defaultPort;
}

function remoteListenerPortPath(glimmervoidHome: string, localPort: number): string {
  return path.join(glimmervoidHome, 'remote-listener', `${localPort}.port`);
}

function normalizeRemoteConfig(raw: unknown): RemoteConfig {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const port = toPort(src.port);
  const publicHost = typeof src.publicHost === 'string' ? src.publicHost.trim() : '';
  const ownerLogin = typeof src.ownerLogin === 'string' ? src.ownerLogin.trim().toLowerCase() : '';
  const listed = Array.isArray(src.allowedOrigins)
    ? src.allowedOrigins.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
    : [];
  if (listed.length === 0 && publicHost !== '') {
    return { port, publicHost, allowedOrigins: [`https://${publicHost}`], ownerLogin };
  }
  return { port, publicHost, allowedOrigins: listed, ownerLogin };
}

function validateRemoteConfig(remote: { port: number | null }, localPort: number): { ok: boolean; error: string | null } {
  if (remote.port === null) return { ok: true, error: null };
  if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535) {
    return { ok: false, error: `remote.port must be an integer 1-65535 (got ${JSON.stringify(remote.port)})` };
  }
  if (remote.port === localPort) {
    return { ok: false, error: `remote.port (${remote.port}) must differ from the local port (${localPort})` };
  }
  return { ok: true, error: null };
}

function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== 'string') return false;
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (bare === '' || bare === 'localhost') return bare === 'localhost';
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function decideBindHost({ envHost, insecureBind }: { envHost?: unknown; insecureBind?: unknown } = {}): {
  host: string;
  allowed: boolean;
  reason: string | null;
} {
  const host = typeof envHost === 'string' ? envHost.trim() : '';
  if (host === '') return { host: '127.0.0.1', allowed: true, reason: null };
  if (isLoopbackHost(host)) return { host, allowed: true, reason: null };
  if (insecureBind === true) return { host, allowed: true, reason: 'insecure-bind' };
  return { host, allowed: false, reason: 'non-loopback' };
}

export { remoteListenerPortPath, resolveLocalPort, normalizeRemoteConfig, validateRemoteConfig, decideBindHost };
