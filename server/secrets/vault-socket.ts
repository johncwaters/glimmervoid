import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { authorizeInboxRequest } from '../../cloud/inbox/core/job-inbox-core.ts';
import { watcherChildInboxUrl } from '../../cloud/watcher/core/watcher-core.ts';
import { VAULT_REPLACED_CLOSE_CODE, VAULT_SOCKET_PATH, VaultResult } from '../../shared/contracts/secrets.ts';
import type { VaultJob } from '../../shared/contracts/secrets.ts';

const RESOLVE_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const COMPANION_FILE_MODE = 0o600;

type ResolvedItems = VaultResult['items'];

interface PendingJob {
  socket: WebSocket;
  settle: (items: ResolvedItems | null) => void;
  timer: NodeJS.Timeout;
}

function refuseUpgrade(socket: Duplex, statusLine: string): void {
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
}

function parsedResultOrNull(rawMessage: unknown): VaultResult | null {
  if (!Buffer.isBuffer(rawMessage)) return null;
  try {
    const parsed = VaultResult.safeParse(JSON.parse(rawMessage.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function createVaultSocket({ envToken, companionFile, log = console }: {
  envToken: string | null;
  companionFile: string;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  const isPerBootToken = envToken === null || envToken === '';
  const token = isPerBootToken ? crypto.randomBytes(32).toString('hex') : envToken;
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const pendingJobs = new Map<string, PendingJob>();
  let companion: WebSocket | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  function settleJobsOf(socket: WebSocket | null): void {
    for (const [jobId, pending] of pendingJobs) {
      if (socket !== null && pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pendingJobs.delete(jobId);
      pending.settle(null);
    }
  }

  function settleJob(result: VaultResult): void {
    const pending = pendingJobs.get(result.jobId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingJobs.delete(result.jobId);
    pending.settle(result.items);
  }

  function adopt(socket: WebSocket): void {
    if (companion !== null) companion.close(VAULT_REPLACED_CLOSE_CODE, 'another vault companion connected');
    companion = socket;
    let isAlive = true;
    socket.on('pong', () => { isAlive = true; });
    socket.on('message', (rawMessage) => {
      const result = parsedResultOrNull(rawMessage);
      if (result !== null) settleJob(result);
    });
    socket.on('close', () => {
      settleJobsOf(socket);
      if (companion !== socket) return;
      companion = null;
      log.log('[vault] companion disconnected');
    });
    socket.on('error', () => {});
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (companion !== socket) return;
      if (!isAlive) {
        socket.terminate();
        return;
      }
      isAlive = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    log.log('[vault] companion connected');
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(request.url ?? '/', 'http://inbox').pathname;
    if (pathname !== VAULT_SOCKET_PATH) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    if (!authorizeInboxRequest(request.headers.authorization, token)) {
      refuseUpgrade(socket, '401 Unauthorized');
      return;
    }
    server.handleUpgrade(request, socket, head, adopt);
  }

  function isOnline(): boolean {
    return companion !== null && companion.readyState === WebSocket.OPEN;
  }

  function resolve(items: VaultJob['items']): Promise<ResolvedItems | null> {
    const socket = companion;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const job: VaultJob = { type: 'resolve', jobId: crypto.randomUUID(), items };
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        pendingJobs.delete(job.jobId);
        settle(null);
      }, RESOLVE_TIMEOUT_MS);
      pendingJobs.set(job.jobId, { socket, settle, timer });
      socket.send(JSON.stringify(job));
    });
  }

  let publishedText: string | null = null;

  async function publishLocalAddress(inboxHost: string, inboxPort: number): Promise<void> {
    const inboxUrl = watcherChildInboxUrl(inboxHost, inboxPort);
    if (inboxUrl === null) return;
    const url = `${inboxUrl.replace(/^http/, 'ws')}${VAULT_SOCKET_PATH}`;
    const text = `${JSON.stringify(isPerBootToken ? { url, token } : { url })}\n`;
    await fsp.writeFile(companionFile, text, { mode: COMPANION_FILE_MODE });
    await fsp.chmod(companionFile, COMPANION_FILE_MODE);
    publishedText = text;
    process.once('exit', forgetLocalAddress);
  }

  function forgetLocalAddress(): void {
    if (publishedText === null) return;
    const currentText = fs.existsSync(companionFile) ? fs.readFileSync(companionFile, 'utf8') : null;
    if (currentText === publishedText) fs.rmSync(companionFile, { force: true });
    publishedText = null;
  }

  function attach(inboxServer: Server): void {
    inboxServer.on('upgrade', handleUpgrade);
    inboxServer.once('close', () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      companion?.terminate();
      settleJobsOf(null);
      forgetLocalAddress();
    });
    inboxServer.once('listening', () => {
      const address = inboxServer.address();
      if (address === null || typeof address === 'string') return;
      publishLocalAddress(address.address, address.port).catch((error: unknown) => {
        log.warn(`[vault] could not write ${companionFile}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  return { attach, isOnline, resolve };
}

export { createVaultSocket };
