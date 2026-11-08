import { isLoopbackHostname } from '../../shared/loopback-hosts.ts';
import { VAULT_SOCKET_PATH } from '../../shared/contracts/secrets.ts';
import { tokensMatch } from './agent-api-core.ts';
import { decideBindHost } from './remote-config.ts';

const BEARER_PREFIX = 'Bearer ';
const ANY_FREE_PORT = 0;
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

type VaultBindDecision =
  | { listen: false; reason: string }
  | { listen: true; host: string; port: number };

function decideVaultBind({ host, port, envToken }: { host: string | null; port: number | null; envToken: string | null }): VaultBindDecision {
  const hasEnvToken = envToken !== null && envToken !== '';
  const bind = decideBindHost({ envHost: host ?? '', insecureBind: hasEnvToken });
  if (!bind.allowed) return { listen: false, reason: `refusing vault bind ${bind.host}: set GLIMMERVOID_VAULT_TOKEN` };
  const isReachableFromAnotherMachine = bind.reason === 'insecure-bind';
  if (isReachableFromAnotherMachine && port === null) return { listen: false, reason: `vault.host ${bind.host} needs a fixed vault.port` };
  return { listen: true, host: bind.host, port: port ?? ANY_FREE_PORT };
}

function isAuthorizedCompanion(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith(BEARER_PREFIX)) return false;
  if (expectedToken === '') return false;
  return tokensMatch(authorizationHeader.slice(BEARER_PREFIX.length), expectedToken);
}

function localCompanionSocketUrl(boundHost: string, boundPort: number): string | null {
  if (WILDCARD_HOSTS.has(boundHost)) return `ws://127.0.0.1:${boundPort}${VAULT_SOCKET_PATH}`;
  if (!isLoopbackHostname(boundHost)) return null;
  const hostInUrl = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  return `ws://${hostInUrl}:${boundPort}${VAULT_SOCKET_PATH}`;
}

export { decideVaultBind, isAuthorizedCompanion, localCompanionSocketUrl };
