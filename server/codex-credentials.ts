import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestCodexAppServer } from './codex-app-server-request.ts';
import type { CodexAppServerCommand } from './codex-app-server-request.ts';
import { codexHomeDir, decideCodexLogin, parseCodexAuth } from './core/codex-credentials-core.ts';
import type { CodexLogin } from './core/codex-credentials-core.ts';
import type { LoginSource } from './agent-login/core/agent-connect-core.ts';

const HOST_REFRESH_TIMEOUT_MS = 60_000;

type HostLoginRefresher = (command: CodexAppServerCommand, env: NodeJS.ProcessEnv) => Promise<boolean>;

interface CodexCredentialsOptions {
  homeDir?: string;
  connectedCodexHome?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  codexCommand: () => CodexAppServerCommand | null;
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

async function refreshHostLoginOverAppServer(command: CodexAppServerCommand, env: NodeJS.ProcessEnv): Promise<boolean> {
  const response = await requestCodexAppServer(command, env, { method: 'account/read', params: { refreshToken: true }, timeoutMs: HOST_REFRESH_TIMEOUT_MS });
  return response !== null;
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
