import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { spawn } from '../child-process-safe.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { errorMessage } from '../../shared/text.ts';
import { bearerOf, createFrameReader, credentialSourceFor, encodeFrame, helloReply, verdictFor } from './core/credential-decider-core.ts';
import type { ProxyRequest } from './core/credential-decider-core.ts';
import { CREDENTIAL_PROXIES_FOLDER_PREFIX } from './core/sandbox-policy-core.ts';

const PROXY_SOCKET_NAME = 'proxy.sock';
const BINDING_SOCKET_NAME = 'binding.sock';
const STDERR_TAIL_BYTES = 2048;
const SERVING_TIMEOUT_MS = 15_000;
const FIRST_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const DECIDER_FD = 3;
const LISTEN_FD = 4;
const LIFELINE_FD = 5;
const CA_FD = 6;

interface ModelLogin {
  agent: string;
  loginFile: string | null;
}

interface CredentialProxyTools {
  nodePath: string;
  srtCliPath: string;
}

interface CredentialProxyDependencies {
  resolveTools: () => Promise<CredentialProxyTools | { refusal: string }>;
  certificateAuthorityPem: () => Promise<string>;
  readGithubToken: () => Promise<string | null>;
  readModelToken: (login: ModelLogin) => Promise<string | null>;
  watchLogin: (login: ModelLogin) => { ready: Promise<void>; unwatch: () => void };
  logger: Pick<Console, 'warn'>;
}

type ProxyAcquisition = { ok: true; socketPath: string; proxiesFolder: string; release: () => void } | { ok: false; reason: string };

type ProxyOutcome = { ok: true } | { ok: false; reason: string };

type PlaceholderOutcome = 'seen' | 'login-unreadable' | 'cancelled';

interface PlaceholderExpectation {
  outcome: Promise<PlaceholderOutcome>;
  cancel: () => void;
}

interface RunningProxy {
  state: 'starting' | 'serving' | 'failed' | 'stopped';
  socketFolder: string | null;
  holders: number;
  serving: Promise<ProxyOutcome>;
  child: ChildProcess | null;
  lifeline: Writable | null;
  restartDelayMs: number;
  restartTimer: NodeJS.Timeout | null;
  unwatchLogin: (() => void) | null;
}

function loginKeyOf(login: ModelLogin): string {
  return `${login.agent}\n${login.loginFile ?? ''}`;
}

function listeningFdOf(server: net.Server): number | null {
  const handle: unknown = Reflect.get(server, '_handle');
  if (typeof handle !== 'object' || handle === null) return null;
  const fd: unknown = Reflect.get(handle, 'fd');
  return typeof fd === 'number' && fd >= 0 ? fd : null;
}

function listenOn(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

function streamAt(child: ChildProcess, fd: number): Readable & Writable {
  const stream = child.stdio[fd];
  if (stream === null || stream === undefined || !('write' in stream) || !('on' in stream)) throw new Error(`the proxy has no stream on fd ${fd}`);
  return stream as Readable & Writable;
}

function createCredentialProxies(dependencies: CredentialProxyDependencies) {
  const proxiesByLogin = new Map<string, RunningProxy>();
  let proxiesFolder: Promise<string> | null = null;
  const proxiesFolderPath = () => {
    proxiesFolder ??= fsp.mkdtemp(CREDENTIAL_PROXIES_FOLDER_PREFIX);
    return proxiesFolder;
  };

  const settleByBearer = new Map<string, (outcome: PlaceholderOutcome) => void>();

  const expectPlaceholder = (placeholder: string): PlaceholderExpectation => {
    let settle: (outcome: PlaceholderOutcome) => void = () => {};
    const outcome = new Promise<PlaceholderOutcome>((resolve) => { settle = resolve; });
    settleByBearer.set(placeholder, settle);
    const cancel = () => {
      settleByBearer.delete(placeholder);
      settle('cancelled');
    };
    return { outcome, cancel };
  };

  const noteBearer = (request: ProxyRequest, hasModelToken: boolean) => {
    const bearer = bearerOf(request);
    const settle = bearer === null ? undefined : settleByBearer.get(bearer);
    if (bearer === null || settle === undefined) return;
    settleByBearer.delete(bearer);
    settle(hasModelToken ? 'seen' : 'login-unreadable');
  };

  const answer = async (request: ProxyRequest, login: ModelLogin): Promise<object> => {
    const source = credentialSourceFor(request.host, request.path, login.agent);
    const githubToken = source === 'github' ? await dependencies.readGithubToken().catch(() => null) : null;
    const modelToken = source === 'model' ? await dependencies.readModelToken(login).catch(() => null) : null;
    if (source === 'model') noteBearer(request, modelToken !== null);
    return verdictFor(request, { agent: login.agent, githubToken, modelToken });
  };

  const startProxy = async (running: RunningProxy, login: ModelLogin): Promise<ProxyOutcome> => {
    const tools = await dependencies.resolveTools();
    if ('refusal' in tools) return { ok: false, reason: tools.refusal };
    running.socketFolder ??= await fsp.mkdtemp(path.join(await proxiesFolderPath(), 'login-'));
    const bindingPath = path.join(running.socketFolder, BINDING_SOCKET_NAME);
    await fsp.rm(bindingPath, { force: true });
    await fsp.rm(path.join(running.socketFolder, PROXY_SOCKET_NAME), { force: true });
    const server = await listenOn(bindingPath);
    const listenFd = listeningFdOf(server);
    if (listenFd === null) {
      await closeServer(server);
      return { ok: false, reason: 'the credential proxy socket has no descriptor to hand over' };
    }
    const proxyArgs = [tools.srtCliPath, 'proxy', '--decider-fd', String(DECIDER_FD), '--listen-fd', String(LISTEN_FD), '--lifeline-fd', String(LIFELINE_FD), '--ca-fd', String(CA_FD), '--strip-response-header', 'set-cookie', 'set-cookie2'];
    const child = spawn(tools.nodePath, proxyArgs, {
      env: withoutGlimmervoidSecrets(process.env),
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', listenFd, 'pipe', 'pipe'],
    });
    running.child = child;
    const isCurrentChild = () => running.child === child;
    let stderrTail = '';
    let isSettled = false;
    let resolveOutcome: (outcome: ProxyOutcome) => void = () => {};
    const outcome = new Promise<ProxyOutcome>((resolve) => { resolveOutcome = resolve; });
    const settle = (settled: ProxyOutcome) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(servingTimer);
      if (!settled.ok) child.kill();
      resolveOutcome(settled);
    };
    const servingTimer = setTimeout(() => settle({ ok: false, reason: 'the credential proxy did not start in time' }), SERVING_TIMEOUT_MS);
    const ended = (reason: string) => {
      const wasServing = isSettled;
      settle({ ok: false, reason });
      if (!isCurrentChild()) return;
      running.child = null;
      running.lifeline = null;
      if (running.state === 'stopped') return;
      running.state = 'failed';
      running.serving = Promise.resolve({ ok: false, reason });
      if (!wasServing || running.holders === 0) return;
      dependencies.logger.warn(`[credential-proxy] ${reason}; restarting in ${running.restartDelayMs} ms`);
      scheduleRestart(running, login);
    };
    child.once('error', (error) => ended(`the credential proxy could not run: ${errorMessage(error)}`));
    child.once('exit', (code, signal) => ended(`the credential proxy stopped (${signal ?? `exit ${code}`})${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`));
    try {
      await fsp.rename(bindingPath, path.join(running.socketFolder, PROXY_SOCKET_NAME));
      await closeServer(server);
      child.stderr?.on('data', (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_BYTES); });
      const decider = streamAt(child, DECIDER_FD);
      const lifeline = streamAt(child, LIFELINE_FD);
      const certificateAuthority = streamAt(child, CA_FD);
      for (const stream of [decider, lifeline, certificateAuthority]) stream.on('error', () => {});
      if (isCurrentChild()) running.lifeline = lifeline;
      decider.on('data', createFrameReader((frame) => {
        if (frame.t === 'hello') {
          decider.write(encodeFrame(helloReply()));
          settle({ ok: true });
          return;
        }
        void answer(frame, login).then((verdict) => { decider.write(encodeFrame(verdict)); });
      }, (reason) => {
        dependencies.logger.warn(`[credential-proxy] ${reason}; stopping the proxy`);
        child.kill();
      }));
      certificateAuthority.end(await dependencies.certificateAuthorityPem());
    } catch (error) {
      settle({ ok: false, reason: `the credential proxy could not start: ${errorMessage(error)}` });
    }
    return outcome;
  };

  const scheduleRestart = (running: RunningProxy, login: ModelLogin) => {
    const delayMs = running.restartDelayMs;
    running.restartDelayMs = Math.min(delayMs * 2, MAX_RESTART_DELAY_MS);
    running.restartTimer = setTimeout(() => {
      running.restartTimer = null;
      if (running.state !== 'failed') return;
      startAt(running, login);
      void running.serving.then((restarted) => {
        if (restarted.ok || running.holders === 0 || running.state !== 'failed') return;
        scheduleRestart(running, login);
      });
    }, delayMs);
  };

  const stop = (key: string, running: RunningProxy) => {
    if (proxiesByLogin.get(key) === running) proxiesByLogin.delete(key);
    running.state = 'stopped';
    running.unwatchLogin?.();
    if (running.restartTimer !== null) clearTimeout(running.restartTimer);
    running.lifeline?.end();
    running.child?.kill();
    if (running.socketFolder !== null) void fsp.rm(running.socketFolder, { recursive: true, force: true });
  };

  const startAt = (running: RunningProxy, login: ModelLogin) => {
    running.state = 'starting';
    running.serving = startProxy(running, login)
      .catch((error: unknown): ProxyOutcome => ({ ok: false, reason: `the credential proxy could not start: ${errorMessage(error)}` }))
      .then((outcome) => {
        if (running.state !== 'starting') return outcome;
        running.state = outcome.ok ? 'serving' : 'failed';
        if (outcome.ok) running.restartDelayMs = FIRST_RESTART_DELAY_MS;
        return outcome;
      });
  };

  const acquire = async (login: ModelLogin): Promise<ProxyAcquisition> => {
    const key = loginKeyOf(login);
    const running: RunningProxy = proxiesByLogin.get(key) ?? { state: 'failed', socketFolder: null, holders: 0, serving: Promise.resolve({ ok: false, reason: 'not started' }), child: null, lifeline: null, restartDelayMs: FIRST_RESTART_DELAY_MS, restartTimer: null, unwatchLogin: null };
    proxiesByLogin.set(key, running);
    if (running.state === 'failed') startAt(running, login);
    running.holders += 1;
    const loginWatch = running.unwatchLogin === null ? dependencies.watchLogin(login) : null;
    if (loginWatch !== null) running.unwatchLogin = loginWatch.unwatch;
    const [outcome] = await Promise.all([running.serving, loginWatch?.ready]);
    let isReleased = false;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      running.holders -= 1;
      if (running.holders === 0) stop(key, running);
    };
    if (!outcome.ok || running.socketFolder === null) {
      release();
      return { ok: false, reason: outcome.ok ? 'the credential proxy has no socket' : outcome.reason };
    }
    return { ok: true, socketPath: path.join(running.socketFolder, PROXY_SOCKET_NAME), proxiesFolder: path.dirname(running.socketFolder), release };
  };

  const closeAll = () => {
    for (const [key, running] of proxiesByLogin) stop(key, running);
    void proxiesFolder?.then((folder) => fsp.rm(folder, { recursive: true, force: true }));
  };

  return { acquire, closeAll, expectPlaceholder };
}

type CredentialProxies = ReturnType<typeof createCredentialProxies>;

export { createCredentialProxies };
export type { CredentialProxies, ModelLogin, PlaceholderExpectation };
