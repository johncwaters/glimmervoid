import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from './child-process-safe.ts';
import { decideCodexLogin, parseCodexAuth } from './core/codex-credentials-core.ts';
import type { CodexLogin } from './core/codex-credentials-core.ts';
import type { LoginSource } from './agent-login/core/agent-connect-core.ts';

const HOST_REFRESH_TIMEOUT_MS = 60_000;

type CodexCommand = { file: string; argsBeforeAppServer: string[] };

type HostLoginRefresher = (command: CodexCommand, env: NodeJS.ProcessEnv) => Promise<boolean>;

interface CodexCredentialsOptions {
  homeDir?: string;
  connectedCodexHome?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  codexCommand: () => CodexCommand | null;
  refreshHostLogin?: HostLoginRefresher;
  readTextFile?: (filePath: string) => Promise<string | null>;
}

interface StoredLogin {
  login: CodexLogin;
  source: LoginSource;
}

type CodexLoginResult = { ok: true; login: CodexLogin } | { ok: false; reason: string };

async function readTextFileOrNull(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

function codexHomeDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env.CODEX_HOME?.trim();
  return override ? path.resolve(override) : path.join(homeDir, '.codex');
}

function refreshHostLoginOverAppServer(command: CodexCommand, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, [...command.argsBeforeAppServer, 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    let bufferedOutput = '';
    let isSettled = false;
    const settle = (hasRefreshed: boolean) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      child.kill();
      resolve(hasRefreshed);
    };
    const timer = setTimeout(() => settle(false), HOST_REFRESH_TIMEOUT_MS);
    const send = (message: unknown) => { child.stdin?.write(`${JSON.stringify(message)}\n`); };
    const handleLine = (line: string) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error !== undefined) return settle(false);
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: { refreshToken: true } });
        return;
      }
      if (message.id === 2) settle(message.error === undefined);
    };
    child.on('error', () => settle(false));
    child.on('exit', () => settle(false));
    child.stdin?.on('error', () => settle(false));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const lines = (bufferedOutput + chunk).split('\n');
      bufferedOutput = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'glimmervoid', title: null, version: '0.1.0' }, capabilities: null } });
  });
}

function createCodexCredentials({
  homeDir = os.homedir(),
  connectedCodexHome = null,
  env = process.env,
  now = () => Date.now(),
  codexCommand,
  refreshHostLogin = refreshHostLoginOverAppServer,
  readTextFile = readTextFileOrNull,
}: CodexCredentialsOptions) {
  let inFlightRefresh: Promise<boolean> | null = null;

  async function readLoginIn(codexHome: string): Promise<CodexLogin | null> {
    const stored = await readTextFile(path.join(codexHome, 'auth.json'));
    return stored === null ? null : parseCodexAuth(stored);
  }

  async function readStoredLogin(): Promise<StoredLogin | null> {
    const hostLogin = await readLoginIn(codexHomeDir(env, homeDir));
    if (hostLogin) return { login: hostLogin, source: 'host' };
    if (!connectedCodexHome) return null;
    const connectedLogin = await readLoginIn(connectedCodexHome);
    return connectedLogin ? { login: connectedLogin, source: 'glimmervoid' } : null;
  }

  function refreshEnvFor(source: LoginSource | null): NodeJS.ProcessEnv {
    if (source !== 'glimmervoid' || !connectedCodexHome) return env;
    return { ...env, CODEX_HOME: connectedCodexHome };
  }

  function refreshOnce(source: LoginSource | null): Promise<boolean> {
    const command = codexCommand();
    if (!command) return Promise.resolve(false);
    inFlightRefresh ??= refreshHostLogin(command, refreshEnvFor(source)).finally(() => { inFlightRefresh = null; });
    return inFlightRefresh;
  }

  async function resolveLogin({ mustRefresh }: { mustRefresh: boolean }): Promise<CodexLoginResult> {
    if (mustRefresh) await refreshOnce((await readStoredLogin())?.source ?? null);
    let hasRefreshed = mustRefresh;
    for (;;) {
      const stored = await readStoredLogin();
      const decision = decideCodexLogin({ login: stored?.login ?? null, nowMs: now(), hasRefreshed });
      if (decision.kind === 'use') return { ok: true, login: decision.login };
      if (decision.kind === 'unavailable') return { ok: false, reason: decision.reason };
      await refreshOnce(stored?.source ?? null);
      hasRefreshed = true;
    }
  }

  return {
    loginSource: async (): Promise<LoginSource | null> => (await readStoredLogin())?.source ?? null,
    hostLogin: () => resolveLogin({ mustRefresh: false }),
    refreshedHostLogin: () => resolveLogin({ mustRefresh: true }),
  };
}

export { createCodexCredentials };
