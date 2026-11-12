import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestCodexAppServer } from './codex-app-server-request.ts';
import type { CodexAppServerCommand } from './codex-app-server-request.ts';
import { codexHomeDir, decideCodexLogin, parseCodexAuth } from './core/codex-credentials-core.ts';
import type { CodexLogin } from './core/codex-credentials-core.ts';
import type { LoginSource } from './agent-login/core/agent-connect-core.ts';
import { clock } from '../shared/clock.ts';

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
  codexHome: string | null;
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
  now = () => clock.nowMs(),
  codexCommand,
  refreshHostLogin = refreshHostLoginOverAppServer,
  readTextFile = readTextFileOrNull,
}: CodexCredentialsOptions) {
  const inFlightRefreshByHome = new Map<string, Promise<boolean>>();

  async function readLoginIn(codexHome: string): Promise<CodexLogin | null> {
    const stored = await readTextFile(path.join(codexHome, 'auth.json'));
    return stored === null ? null : parseCodexAuth(stored);
  }

  async function readStoredLogin(): Promise<StoredLogin | null> {
    const hostLogin = await readLoginIn(codexHomeDir(env, homeDir));
    if (hostLogin) return { login: hostLogin, codexHome: null };
    if (!connectedCodexHome) return null;
    const connectedLogin = await readLoginIn(connectedCodexHome);
    return connectedLogin ? { login: connectedLogin, codexHome: connectedCodexHome } : null;
  }

  async function readAccountLogin(accountCodexHome: string): Promise<StoredLogin | null> {
    const accountLogin = await readLoginIn(accountCodexHome);
    return accountLogin ? { login: accountLogin, codexHome: accountCodexHome } : null;
  }

  function refreshOnce(codexHome: string | null): Promise<boolean> {
    const command = codexCommand();
    if (!command) return Promise.resolve(false);
    const homeKey = codexHome ?? '';
    const inFlightRefresh = inFlightRefreshByHome.get(homeKey);
    if (inFlightRefresh) return inFlightRefresh;
    const refreshEnv = codexHome === null ? env : { ...env, CODEX_HOME: codexHome };
    const refresh = refreshHostLogin(command, refreshEnv).finally(() => { inFlightRefreshByHome.delete(homeKey); });
    inFlightRefreshByHome.set(homeKey, refresh);
    return refresh;
  }

  async function resolveLogin({ mustRefresh, accountCodexHome }: { mustRefresh: boolean; accountCodexHome: string | null }): Promise<CodexLoginResult> {
    const readLogin = accountCodexHome === null ? readStoredLogin : () => readAccountLogin(accountCodexHome);
    if (mustRefresh) await refreshOnce((await readLogin())?.codexHome ?? accountCodexHome);
    let hasRefreshed = mustRefresh;
    for (;;) {
      const stored = await readLogin();
      const decision = decideCodexLogin({ login: stored?.login ?? null, nowMs: now(), hasRefreshed });
      if (decision.kind === 'use') return { ok: true, login: decision.login };
      if (decision.kind === 'unavailable') return { ok: false, reason: decision.reason };
      await refreshOnce(stored?.codexHome ?? accountCodexHome);
      hasRefreshed = true;
    }
  }

  return {
    loginSource: async (): Promise<LoginSource | null> => {
      const stored = await readStoredLogin();
      if (!stored) return null;
      return stored.codexHome === null ? 'host' : 'glimmervoid';
    },
    hostLogin: (accountCodexHome: string | null = null) => resolveLogin({ mustRefresh: false, accountCodexHome }),
    refreshedHostLogin: (accountCodexHome: string | null = null) => resolveLogin({ mustRefresh: true, accountCodexHome }),
  };
}

export { createCodexCredentials };
