import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { spawn } from '../server/child-process-safe.ts';
import type { TraceRecord } from '../shared/contracts/trace.ts';
import {
  isFollowableThread,
  isNoRolloutError,
  parseListenUrl,
  pendingApprovalFromServerRequest,
  traceRecordsForItemEvent,
} from './core/codex-app-server-core.ts';
import type { CodexPendingApproval } from './core/codex-app-server-core.ts';

interface CodexAppServerBridgeOptions {
  command: { file: string; argsBeforeAppServer: string[] };
  configArgs: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  tokenParentDirectory: string;
  startupTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface CodexAppServerBridge extends EventEmitter {
  url: string;
  token: string;
  answerApproval(requestId: number | string, decision: 'accept' | 'acceptForSession' | 'decline'): boolean;
  pendingApproval(): CodexPendingApproval | null;
  stop(): Promise<void>;
}

const requestIdSchema = z.union([z.number().int(), z.string()]);
const rpcMessage = z.object({
  jsonrpc: z.literal('2.0').optional(), id: requestIdSchema.optional(),
  method: z.string().optional(), params: z.unknown().optional(),
  result: z.unknown().optional(), error: z.unknown().optional(),
}).passthrough();
const threadIdentity = z.object({ id: z.string().min(1) }).passthrough();
const notificationParams = z.object({ threadId: z.string().min(1) }).passthrough();
const itemNotification = notificationParams.extend({ item: z.unknown(), turnId: z.string().min(1) });
const historyTurn = z.object({ id: z.string().min(1), items: z.array(z.unknown()) }).passthrough();
const resumeResponse = z.object({ thread: threadIdentity.extend({ turns: z.array(historyTurn) }) }).passthrough();
const itemIdentity = z.object({ id: z.string().min(1), status: z.string().optional() }).passthrough();
const requestedPermissions = z.object({
  permissions: z.object({
    network: z.object({ enabled: z.boolean().nullable() }).passthrough().nullable(),
    fileSystem: z.record(z.string(), z.unknown()).nullable(),
  }).passthrough(),
}).passthrough();

const JOIN_RETRY_WINDOW_MS = 15000;

function toError(failure: unknown): Error {
  if (failure instanceof Error) return failure;
  const parsedFailure = z.object({ message: z.string() }).passthrough().safeParse(failure);
  return new Error(parsedFailure.success ? parsedFailure.data.message : String(failure));
}

export async function startCodexAppServerBridge(options: CodexAppServerBridgeOptions): Promise<CodexAppServerBridge> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const token = randomBytes(32).toString('hex');
  const privateDirectory = await mkdtemp(join(resolve(options.tokenParentDirectory), 'glimmervoid-codex-app-server-'));
  let child: ReturnType<typeof spawn>;
  try {
    await chmod(privateDirectory, 0o700);
    const tokenFile = join(privateDirectory, 'token');
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
    child = (options.spawnProcess ?? spawn)(options.command.file, [
      ...options.command.argsBeforeAppServer, 'app-server', ...options.configArgs,
      '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
    ], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (failure) {
    await rm(privateDirectory, { recursive: true, force: true });
    throw toError(failure);
  }

  return new Promise<CodexAppServerBridge>((resolveStartup, rejectStartup) => {
    let socket: WebSocket | null = null;
    let isStarting = true;
    let isStopped = false;
    let hasExited = false;
    let stopPromise: Promise<void> | null = null;
    let activeApproval: CodexPendingApproval | null = null;
    let approvalPermissions: z.infer<typeof requestedPermissions>['permissions'] | null = null;
    let nextRequestId = 1;
    let followedThreadId: string | null = null;
    let hasJoined = false;
    let isJoining = false;
    let joinDeadlineMs = 0;
    let joinGeneration = 0;
    let lastJoinAttemptMs = Number.NEGATIVE_INFINITY;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const startedItemIds = new Map<string, Set<string>>();
    const completedItemIds = new Map<string, Set<string>>();
    const pendingRequests = new Map<number | string, {
      resolve: (response: unknown) => void;
      reject: (failure: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((resolveChildExit) => { resolveExit = resolveChildExit; });
    const bridge: CodexAppServerBridge = Object.assign(new EventEmitter(), {
      url: '', token, answerApproval, pendingApproval: () => activeApproval, stop,
    });
    bridge.on('error', (failure: Error) => logger.warn('Codex app-server bridge:', failure.message));
    const startupTimer = setTimeout(() => failStartup(new Error('Codex app-server startup timed out')), options.startupTimeoutMs ?? 15000);

    function reportError(failure: unknown): void {
      const error = toError(failure);
      if (isStarting) {
        failStartup(error);
        return;
      }
      bridge.emit('error', error);
    }

    function guard(action: () => void): void {
      try {
        action();
      } catch (failure) {
        reportError(failure);
      }
    }

    function clearApproval(): void {
      if (!activeApproval) return;
      activeApproval = null;
      approvalPermissions = null;
      bridge.emit('approval', null);
    }

    function failStartup(error: Error): void {
      if (!isStarting) return;
      isStarting = false;
      clearTimeout(startupTimer);
      void stop().then(() => rejectStartup(error), (cleanupFailure: unknown) => {
        rejectStartup(new AggregateError([error, toError(cleanupFailure)], error.message));
      });
    }

    function cancelRequests(): void {
      for (const pendingRequest of pendingRequests.values()) {
        clearTimeout(pendingRequest.timer);
        pendingRequest.reject(new Error('Codex app-server connection closed'));
      }
      pendingRequests.clear();
    }

    function stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      isStopped = true;
      clearTimeout(startupTimer);
      clearTimeout(retryTimer);
      cancelRequests();
      stopPromise = Promise.resolve().then(async () => {
        try {
          guard(clearApproval);
          if (socket) guard(() => socket?.close());
          if (hasExited) return;
          child.kill('SIGTERM');
          const killTimer = setTimeout(() => guard(() => { child.kill('SIGKILL'); }), 2000);
          try {
            await exited;
          } finally {
            clearTimeout(killTimer);
          }
        } finally {
          if (socket && socket.readyState !== WebSocket.CLOSED) guard(() => socket?.terminate());
          await rm(privateDirectory, { recursive: true, force: true });
        }
      });
      return stopPromise;
    }

    function send(message: unknown): void {
      if (isStopped || socket?.readyState !== WebSocket.OPEN) throw new Error('Codex app-server socket is not open');
      socket.send(JSON.stringify(message));
    }

    function request(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
      const id = nextRequestId++;
      return new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          rejectResponse(new Error(`Codex app-server request timed out: ${method}`));
        }, timeoutMs);
        pendingRequests.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
        try {
          send({ jsonrpc: '2.0', id, method, params });
        } catch (failure) {
          clearTimeout(timer);
          pendingRequests.delete(id);
          rejectResponse(toError(failure));
        }
      });
    }

    function answerApproval(requestId: number | string, decision: 'accept' | 'acceptForSession' | 'decline'): boolean {
      if (!activeApproval || activeApproval.requestId !== requestId || isStopped || socket?.readyState !== WebSocket.OPEN) return false;
      try {
        if (activeApproval.kind === 'permissions') {
          if (!approvalPermissions) return false;
          const permissions = decision === 'decline' ? {} : {
            ...(approvalPermissions.network ? { network: approvalPermissions.network } : {}),
            ...(approvalPermissions.fileSystem ? { fileSystem: approvalPermissions.fileSystem } : {}),
          };
          send({ jsonrpc: '2.0', id: requestId, result: { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' } });
          clearApproval();
          return true;
        }
        send({ jsonrpc: '2.0', id: requestId, result: { decision } });
        clearApproval();
        return true;
      } catch (failure) {
        reportError(failure);
        return false;
      }
    }

    function recordsForItem(phase: 'started' | 'completed', item: unknown, threadId: string, turnId: string): TraceRecord[] {
      const parsedIdentity = itemIdentity.safeParse(item);
      if (!parsedIdentity.success) return [];
      const started = startedItemIds.get(threadId) ?? new Set<string>();
      const completed = completedItemIds.get(threadId) ?? new Set<string>();
      if (completed.has(parsedIdentity.data.id)) return [];
      const normalized = traceRecordsForItemEvent({ phase, item, threadId, turnId, nowMs: now(), alreadyStartedItemIds: started });
      for (const itemId of normalized.startedItemIds) started.add(itemId);
      if (phase === 'completed' && normalized.records.length > 0) completed.add(parsedIdentity.data.id);
      startedItemIds.set(threadId, started);
      completedItemIds.set(threadId, completed);
      return normalized.records;
    }

    function hydrateHistory(response: unknown, threadId: string): void {
      const parsedResponse = resumeResponse.safeParse(response);
      if (!parsedResponse.success || parsedResponse.data.thread.id !== threadId) throw new Error('Invalid Codex thread/resume response');
      const records: TraceRecord[] = [];
      for (const turn of parsedResponse.data.thread.turns) {
        for (const item of turn.items) {
          const parsedItem = itemIdentity.safeParse(item);
          if (!parsedItem.success) continue;
          records.push(...recordsForItem(parsedItem.data.status === 'inProgress' ? 'started' : 'completed', item, threadId, turn.id));
        }
      }
      if (records.length > 0) bridge.emit('records', records);
    }

    function scheduleJoin(): void {
      if (isStopped || hasJoined || isJoining || !followedThreadId || retryTimer || now() >= joinDeadlineMs) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        guard(attemptJoin);
      }, Math.max(0, 500 - (now() - lastJoinAttemptMs)));
    }

    function attemptJoin(): void {
      if (isStopped || hasJoined || isJoining || !followedThreadId || now() >= joinDeadlineMs) return;
      const threadId = followedThreadId;
      const generation = joinGeneration;
      isJoining = true;
      lastJoinAttemptMs = now();
      void request('thread/resume', { threadId, excludeTurns: false }, Math.max(1, Math.min(15000, joinDeadlineMs - now()))).then((response) => {
        if (generation !== joinGeneration || isStopped || hasJoined) return;
        isJoining = false;
        hasJoined = true;
        clearTimeout(retryTimer);
        guard(() => hydrateHistory(response, threadId));
      }, (failure: unknown) => {
        if (generation !== joinGeneration || isStopped || hasJoined) return;
        isJoining = false;
        if (isNoRolloutError(failure)) {
          scheduleJoin();
          return;
        }
        hasJoined = true;
        reportError(failure);
      });
    }

    function followThread(thread: unknown): void {
      const parsedThread = threadIdentity.safeParse(thread);
      if (!parsedThread.success || !isFollowableThread(thread) || followedThreadId === parsedThread.data.id) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      clearApproval();
      followedThreadId = parsedThread.data.id;
      joinGeneration++;
      hasJoined = false;
      isJoining = false;
      joinDeadlineMs = now() + JOIN_RETRY_WINDOW_MS;
      lastJoinAttemptMs = Number.NEGATIVE_INFINITY;
      attemptJoin();
    }

    async function discoverLoadedThread(): Promise<void> {
      const response = await request('thread/loaded/list', {});
      const loadedThreads = z.object({ data: z.array(z.string().min(1)) }).passthrough().safeParse(response);
      if (!loadedThreads.success) throw new Error('Invalid Codex thread/loaded/list response');
      for (const threadId of loadedThreads.data.data) {
        if (followedThreadId || isStopped) return;
        try {
          const metadata = await request('thread/read', { threadId, includeTurns: false });
          const parsedMetadata = z.object({ thread: threadIdentity }).passthrough().safeParse(metadata);
          if (followedThreadId || isStopped) return;
          if (!parsedMetadata.success || parsedMetadata.data.thread.id !== threadId) throw new Error('Invalid Codex thread/read response');
          followThread(parsedMetadata.data.thread);
        } catch (failure) {
          if (isStopped) return;
          reportError(failure);
        }
      }
    }

    function handleNotification(method: string, params: unknown): void {
      if (method === 'thread/started') {
        const startedThread = z.object({ thread: z.unknown() }).passthrough().safeParse(params);
        if (startedThread.success) followThread(startedThread.data.thread);
        return;
      }
      const parsedParams = notificationParams.safeParse(params);
      if (!parsedParams.success || parsedParams.data.threadId !== followedThreadId) return;
      if (method === 'thread/status/changed' || method === 'turn/started') {
        joinDeadlineMs = Math.max(joinDeadlineMs, now() + JOIN_RETRY_WINDOW_MS);
        scheduleJoin();
      }
      if (method === 'turn/completed') clearApproval();
      if (method === 'serverRequest/resolved') {
        const resolvedRequest = notificationParams.extend({ requestId: requestIdSchema }).safeParse(params);
        if (resolvedRequest.success && resolvedRequest.data.requestId === activeApproval?.requestId) clearApproval();
      }
      if (method !== 'item/started' && method !== 'item/completed') return;
      const parsedItem = itemNotification.safeParse(params);
      if (!parsedItem.success) return;
      const { item, threadId, turnId } = parsedItem.data;
      const records = recordsForItem(method === 'item/started' ? 'started' : 'completed', item, threadId, turnId);
      if (records.length > 0) bridge.emit('records', records);
    }

    function handleMessage(frame: Buffer, isBinary: boolean): void {
      if (isStopped || isBinary) return;
      const parsedMessage = rpcMessage.safeParse(JSON.parse(frame.toString('utf8')));
      if (!parsedMessage.success) throw new Error('Invalid Codex JSON-RPC message');
      const message = parsedMessage.data;
      if (message.method && message.id !== undefined) {
        const approval = pendingApprovalFromServerRequest(message.method, message.params, message.id);
        if (!approval || approval.threadId !== followedThreadId) return;
        const permissions = requestedPermissions.safeParse(message.params);
        if (approval.kind === 'permissions' && !permissions.success) return;
        activeApproval = approval;
        approvalPermissions = permissions.success ? permissions.data.permissions : null;
        bridge.emit('approval', approval);
        return;
      }
      if (message.method) {
        handleNotification(message.method, message.params);
        return;
      }
      if (message.id === undefined) return;
      const pendingRequest = pendingRequests.get(message.id);
      if (!pendingRequest) return;
      pendingRequests.delete(message.id);
      clearTimeout(pendingRequest.timer);
      if (message.error !== undefined) {
        pendingRequest.reject(toError(message.error));
        return;
      }
      if (!Object.hasOwn(message, 'result')) {
        pendingRequest.reject(new Error('Codex JSON-RPC response is missing a result'));
        return;
      }
      pendingRequest.resolve(message.result);
    }

    function connect(url: string): void {
      if (socket || isStopped) return;
      bridge.url = url;
      socket = options.createSocket?.(url, { Authorization: `Bearer ${token}` }) ?? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      socket.on('error', (failure) => guard(() => reportError(failure)));
      socket.on('message', (frame, isBinary) => guard(() => handleMessage(frame, isBinary)));
      socket.on('close', () => guard(() => {
        clearApproval();
        cancelRequests();
        if (isStarting) failStartup(new Error('Codex app-server socket closed during startup'));
        void stop().catch(reportError);
      }));
      socket.on('open', () => guard(() => {
        void request('initialize', { clientInfo: { name: 'glimmervoid', title: null, version: '0.1.0' }, capabilities: null }).then((response) => {
          guard(() => {
            if (isStopped || !isStarting) return;
            if (!z.object({ userAgent: z.string() }).passthrough().safeParse(response).success) throw new Error('Invalid Codex initialize response');
            send({ jsonrpc: '2.0', method: 'initialized' });
            isStarting = false;
            clearTimeout(startupTimer);
            resolveStartup(bridge);
            void discoverLoadedThread().catch((failure: unknown) => { if (!isStopped) reportError(failure); });
          });
        }, reportError);
      }));
    }

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      let bufferedLine = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => guard(() => {
        const lines = (bufferedLine + chunk).split('\n');
        bufferedLine = (lines.pop() ?? '').slice(-8192);
        for (const line of lines) {
          const url = parseListenUrl(line);
          if (url) connect(url);
        }
      }));
      stream.on('end', () => guard(() => {
        const url = parseListenUrl(bufferedLine);
        if (url) connect(url);
      }));
      stream.on('error', (failure: Error) => guard(() => reportError(failure)));
    }
    child.stdin?.on('error', (failure: Error) => guard(() => reportError(failure)));
    child.on('error', (failure: Error) => guard(() => {
      if (!child.pid) {
        hasExited = true;
        resolveExit();
      }
      reportError(failure);
    }));
    child.on('exit', (code, signal) => guard(() => {
      hasExited = true;
      resolveExit();
      if (isStarting) failStartup(new Error(`Codex app-server exited before initialization: ${code ?? signal}`));
      bridge.emit('exit', code, signal);
      void stop().catch(reportError);
    }));
  });
}
