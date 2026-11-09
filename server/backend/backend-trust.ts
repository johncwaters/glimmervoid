import crypto from 'node:crypto';
import { hostOfOrigin } from '../core/origin-policy.ts';
import { decideBindHost, normalizeRemoteConfig, validateRemoteConfig } from '../core/remote-config.ts';
import type { RemoteConfig } from '../core/remote-config.ts';
import { createPairingsStore, createSeenStore, defaultPairingsPath, defaultSeenPath } from '../pairings-store.ts';
import { createRemoteAuth } from '../remote-auth.ts';

interface BackendTrustDependencies {
  localPort: number;
  remoteConfig: unknown;
  configPath: string;
  env: NodeJS.ProcessEnv;
}

interface BackendTrust {
  remote: RemoteConfig;
  bindDecision: { host: string; allowed: boolean; reason: string | null };
  remoteListenerPort: () => number | null;
  markRemoteListenerBound(boundPort: number): void;
  pageToken: string;
  allowedHosts: string[];
  remoteAuth: ReturnType<typeof createRemoteAuth>;
  tokenMatches(presented: unknown): boolean;
  listenerPortsFor(socket: { localPort?: number | null } | null | undefined): number[];
}

function bootError(message: string): Error {
  return Object.assign(new Error(message), { glimmervoidBoot: true });
}

function createBackendTrust(dependencies: BackendTrustDependencies): BackendTrust {
  const remote = normalizeRemoteConfig(dependencies.remoteConfig);
  const remoteCheck = validateRemoteConfig(remote, dependencies.localPort);
  if (!remoteCheck.ok) throw bootError(`[remote] invalid configuration: ${remoteCheck.error}`);
  const bindDecision = decideBindHost({
    envHost: dependencies.env.GLIMMERVOID_HOST,
    insecureBind: dependencies.env.GLIMMERVOID_INSECURE_BIND === '1',
  });
  let boundRemoteListenerPort = remote.port;
  const remoteListenerPort = () => boundRemoteListenerPort;
  const pageToken = crypto.randomBytes(32).toString('hex');
  const pageTokenBuffer = Buffer.from(pageToken, 'utf8');
  const allowedHosts = [remote.publicHost, ...remote.allowedOrigins.map(hostOfOrigin)]
    .filter((host) => typeof host === 'string' && host !== '');
  const remoteAuth = createRemoteAuth({
    remote,
    remoteListenerPort,
    pairingsStore: createPairingsStore({ filePath: defaultPairingsPath(dependencies.configPath) }),
    seenStore: createSeenStore({ filePath: defaultSeenPath(dependencies.configPath) }),
  });

  function tokenMatches(presented: unknown): boolean {
    if (typeof presented !== 'string' || presented.length !== pageToken.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), pageTokenBuffer);
    } catch {
      return false;
    }
  }

  function listenerPortsFor(socket: { localPort?: number | null } | null | undefined): number[] {
    const listenerPort = socket && typeof socket.localPort === 'number' ? socket.localPort : null;
    return listenerPort == null ? [] : [listenerPort];
  }

  return {
    remote,
    bindDecision,
    remoteListenerPort,
    markRemoteListenerBound(boundPort: number) {
      boundRemoteListenerPort = boundPort;
    },
    pageToken,
    allowedHosts,
    remoteAuth,
    tokenMatches,
    listenerPortsFor,
  };
}

export { createBackendTrust };
