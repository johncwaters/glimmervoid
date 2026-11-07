import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { vaultAdapterFor } from './adapters/index.ts';
import type { VaultAdapter, VaultSession } from './adapters/index.ts';
import { nextBackoffMs } from '../../shared/backoff.ts';
import { isRecord } from '../../shared/coerce.ts';
import { isLoopbackHostname } from '../../shared/loopback-hosts.ts';
import { VAULT_REPLACED_CLOSE_CODE, VAULT_SOCKET_PATH, VaultCompanionFile, VaultJob } from '../../shared/contracts/secrets.ts';
import type { VaultResult } from '../../shared/contracts/secrets.ts';
import { glimmervoidHomeDir } from '../../server/core/config-path-core.ts';

const VAULT_TOKEN_ENV = 'GLIMMERVOID_VAULT_TOKEN';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

type Connection = { ok: true; url: string; token: string } | { ok: false; reason: string };

function serverConnection(rawServerUrl: string, token: string): Connection {
  if (token === '') return { ok: false, reason: `--server needs ${VAULT_TOKEN_ENV} set to the server's vault token` };
  if (!URL.canParse(rawServerUrl)) return { ok: false, reason: `--server ${rawServerUrl} is not a URL` };
  const serverUrl = new URL(rawServerUrl);
  const isEncrypted = serverUrl.protocol === 'https:' || serverUrl.protocol === 'wss:';
  if (!isEncrypted && serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'ws:') return { ok: false, reason: `--server must be an http, https, ws or wss URL, not ${serverUrl.protocol}` };
  if (!isEncrypted && !isLoopbackHostname(serverUrl.hostname)) return { ok: false, reason: `--server ${rawServerUrl} would send the vault token unencrypted; use https for a host other than this machine` };
  serverUrl.protocol = isEncrypted ? 'wss:' : 'ws:';
  serverUrl.pathname = VAULT_SOCKET_PATH;
  return { ok: true, url: serverUrl.href, token };
}

async function localConnection(companionFile: string, envToken: string): Promise<Connection> {
  const text = await fsp.readFile(companionFile, 'utf8').catch(() => null);
  if (text === null) return { ok: false, reason: `${companionFile} is missing: no Glimmervoid is running on this machine, or its job inbox is off (watcher.autoStart is false with no GLIMMERVOID_WATCHER_TOKEN); start it, or pass --server` };
  const parsed = parsedCompanionFileOrNull(text);
  if (parsed === null) return { ok: false, reason: `${companionFile} is malformed; restart Glimmervoid` };
  const token = parsed.token ?? envToken;
  if (token === '') return { ok: false, reason: `the running Glimmervoid takes its vault token from ${VAULT_TOKEN_ENV}; set it here too` };
  return { ok: true, url: parsed.url, token };
}

function parsedCompanionFileOrNull(text: string): VaultCompanionFile | null {
  try {
    const parsed = VaultCompanionFile.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function resolvedItems(vaultSession: VaultSession, job: VaultJob): Promise<VaultResult['items']> {
  const items: VaultResult['items'] = [];
  for (const { name, reference } of job.items) {
    const outcome = await vaultSession.resolve(reference).catch((error: unknown) => ({ kind: 'unavailable' as const, message: error instanceof Error ? error.message : String(error) }));
    items.push(typeof outcome === 'string' ? { name, value: outcome } : { name, failure: outcome });
  }
  return items;
}

function parsedJobOrNull(rawMessage: unknown): VaultJob | null {
  if (!Buffer.isBuffer(rawMessage)) return null;
  try {
    const parsed = VaultJob.safeParse(JSON.parse(rawMessage.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type ServeOutcome = 'served' | 'unreached' | 'replaced';

function serveOnce(connection: { url: string; token: string }, vaultSession: VaultSession, stopSignal: AbortSignal): Promise<ServeOutcome> {
  return new Promise((settle) => {
    const socket = new WebSocket(connection.url, { headers: { Authorization: `Bearer ${connection.token}` } });
    let hasOpened = false;
    const stop = () => socket.close();
    stopSignal.addEventListener('abort', stop, { once: true });
    socket.on('open', () => {
      hasOpened = true;
      console.log(`vault: connected to ${connection.url}`);
    });
    socket.on('message', (rawMessage) => {
      const job = parsedJobOrNull(rawMessage);
      if (job === null) return;
      void resolvedItems(vaultSession, job).then((items) => {
        const result: VaultResult = { type: 'resolved', jobId: job.jobId, items };
        socket.send(JSON.stringify(result));
        console.log(`vault: answered ${items.length} ${items.length === 1 ? 'secret' : 'secrets'} (${items.map((item) => item.name).join(', ')})`);
      });
    });
    socket.on('unexpected-response', (_request, response) => {
      const statusCode = isRecord(response) ? response.statusCode : 'no status';
      console.error(`vault: ${connection.url} refused the companion (${String(statusCode)})`);
      socket.terminate();
    });
    socket.on('error', () => {});
    socket.on('close', (closeCode: number) => {
      stopSignal.removeEventListener('abort', stop);
      if (closeCode === VAULT_REPLACED_CLOSE_CODE) {
        settle('replaced');
        return;
      }
      settle(hasOpened ? 'served' : 'unreached');
    });
  });
}

function untilStopSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return controller.signal;
}

function waitMs(delayMs: number, stopSignal: AbortSignal): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(settle, delayMs);
    stopSignal.addEventListener('abort', () => {
      clearTimeout(timer);
      settle();
    }, { once: true });
  });
}

async function runVaultCli({ serverUrl, accountName, adapter = vaultAdapterFor('1password') }: {
  serverUrl: string | null;
  accountName: string | null;
  adapter?: VaultAdapter | null;
}): Promise<number> {
  if (adapter === null) {
    console.error('vault: this Glimmervoid has no 1Password support yet');
    return 1;
  }
  const companionFile = path.join(glimmervoidHomeDir(os.homedir(), process.env), 'vault-companion.json');
  const envToken = process.env[VAULT_TOKEN_ENV] ?? '';
  const connect = () => (serverUrl === null ? localConnection(companionFile, envToken) : Promise.resolve(serverConnection(serverUrl, envToken)));
  const firstConnection = await connect();
  if (!firstConnection.ok) {
    console.error(`vault: ${firstConnection.reason}`);
    return 1;
  }
  const vaultSession = await adapter.open({ accountName: accountName ?? '' });
  if ('kind' in vaultSession) {
    console.error(`vault: ${adapter.label} is ${vaultSession.kind}: ${vaultSession.message}`);
    return 1;
  }
  const stopSignal = untilStopSignal();
  let failedAttempts = 0;
  while (!stopSignal.aborted) {
    const connection = await connect();
    const outcome = connection.ok ? await serveOnce(connection, vaultSession, stopSignal) : 'unreached';
    if (!connection.ok) console.error(`vault: ${connection.reason}`);
    if (outcome === 'replaced') {
      console.error('vault: another vault companion connected to this Glimmervoid, so this one stops');
      return 1;
    }
    failedAttempts = outcome === 'served' ? 0 : failedAttempts + 1;
    if (stopSignal.aborted) break;
    await waitMs(nextBackoffMs({ attempt: Math.max(failedAttempts, 1), baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS, jitter: 'none' }), stopSignal);
  }
  return 0;
}

export { runVaultCli };
