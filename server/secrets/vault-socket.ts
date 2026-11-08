import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { isAuthorizedCompanion, localCompanionSocketUrl } from '../core/vault-listener-core.ts';
import { VAULT_REPLACED_CLOSE_CODE, VAULT_SOCKET_PATH, VaultCompanionMessage, VaultJob } from '../../shared/contracts/secrets.ts';
import type { CreateJob, CreatedResult, ResolveJob, ResolvedResult } from '../../shared/contracts/secrets.ts';

const JOB_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const COMPANION_FILE_MODE = 0o600;

type JobResult = ResolvedResult | CreatedResult;
type CreateMiss = 'offline' | 'outdated' | 'invalid' | 'no-answer';

interface PendingJob {
  socket: WebSocket;
  settle: (result: JobResult | null) => void;
  timer: NodeJS.Timeout;
}

function refuseUpgrade(socket: Duplex, statusLine: string): void {
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
}

function parsedMessageOrNull(rawMessage: unknown): VaultCompanionMessage | null {
  if (!Buffer.isBuffer(rawMessage)) return null;
  try {
    const parsed = VaultCompanionMessage.safeParse(JSON.parse(rawMessage.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function createVaultSocket({ envToken, companionFile, onCompanionChanged = () => {}, log = console }: {
  envToken: string | null;
  companionFile: string;
  onCompanionChanged?: () => void;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  const isPerBootToken = envToken === null || envToken === '';
  const token = isPerBootToken ? crypto.randomBytes(32).toString('hex') : envToken;
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const pendingJobs = new Map<string, PendingJob>();
  let companion: WebSocket | null = null;
  let companionNewItemsVault: string | null = null;
  const greetedSockets = new WeakSet<WebSocket>();
  let heartbeat: NodeJS.Timeout | null = null;

  function settleJobsOf(socket: WebSocket | null): void {
    for (const [jobId, pending] of pendingJobs) {
      if (socket !== null && pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pendingJobs.delete(jobId);
      pending.settle(null);
    }
  }

  function settleJob(socket: WebSocket, result: JobResult): void {
    const pending = pendingJobs.get(result.jobId);
    if (!pending || pending.socket !== socket) return;
    clearTimeout(pending.timer);
    pendingJobs.delete(result.jobId);
    pending.settle(result);
  }

  function handleMessage(socket: WebSocket, message: VaultCompanionMessage): void {
    if (message.type !== 'hello') {
      settleJob(socket, message);
      return;
    }
    greetedSockets.add(socket);
    if (companion !== socket) return;
    companionNewItemsVault = message.newItemsVault;
    onCompanionChanged();
  }

  function adopt(socket: WebSocket): void {
    if (companion !== null) companion.close(VAULT_REPLACED_CLOSE_CODE, 'another vault companion connected');
    companion = socket;
    let isAlive = true;
    socket.on('pong', () => { isAlive = true; });
    socket.on('message', (rawMessage) => {
      const message = parsedMessageOrNull(rawMessage);
      if (message !== null) handleMessage(socket, message);
    });
    socket.on('close', () => {
      settleJobsOf(socket);
      if (companion !== socket) return;
      companion = null;
      companionNewItemsVault = null;
      onCompanionChanged();
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
    const pathname = new URL(request.url ?? '/', 'http://vault').pathname;
    if (pathname !== VAULT_SOCKET_PATH) {
      refuseUpgrade(socket, '404 Not Found');
      return;
    }
    if (!isAuthorizedCompanion(request.headers.authorization, token)) {
      refuseUpgrade(socket, '401 Unauthorized');
      return;
    }
    server.handleUpgrade(request, socket, head, adopt);
  }

  function isOnline(): boolean {
    return companion !== null && companion.readyState === WebSocket.OPEN;
  }

  function newItemsVault(): string | null {
    return isOnline() ? companionNewItemsVault : null;
  }

  function sendJob(job: VaultJob): Promise<JobResult | 'offline' | 'invalid' | 'no-answer'> {
    const socket = companion;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return Promise.resolve('offline');
    if (!VaultJob.safeParse(job).success) return Promise.resolve('invalid');
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        pendingJobs.delete(job.jobId);
        settle('no-answer');
      }, JOB_TIMEOUT_MS);
      pendingJobs.set(job.jobId, { socket, settle: (result) => settle(result ?? 'no-answer'), timer });
      socket.send(JSON.stringify(job));
    });
  }

  async function resolve(items: ResolveJob['items']): Promise<ResolvedResult['items'] | null> {
    const result = await sendJob({ type: 'resolve', jobId: crypto.randomUUID(), items });
    return typeof result !== 'string' && result.type === 'resolved' ? result.items : null;
  }

  async function create(items: CreateJob['items']): Promise<CreatedResult['items'] | CreateMiss> {
    if (companion !== null && !greetedSockets.has(companion)) return 'outdated';
    const result = await sendJob({ type: 'create', jobId: crypto.randomUUID(), items });
    if (typeof result === 'string') return result;
    return result.type === 'created' ? result.items : 'no-answer';
  }

  let publishedText: string | null = null;

  async function publishLocalAddress(boundHost: string, boundPort: number): Promise<void> {
    const url = localCompanionSocketUrl(boundHost, boundPort);
    if (url === null) return;
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

  function attach(listener: Server): void {
    listener.on('upgrade', handleUpgrade);
    listener.once('close', () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      companion?.terminate();
      settleJobsOf(null);
      forgetLocalAddress();
    });
    listener.once('listening', () => {
      const address = listener.address();
      if (address === null || typeof address === 'string') return;
      publishLocalAddress(address.address, address.port).catch((error: unknown) => {
        log.warn(`[vault] could not write ${companionFile}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  return { attach, isOnline, newItemsVault, resolve, create };
}

export { createVaultSocket };
export type { CreateMiss };
