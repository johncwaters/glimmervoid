import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from './child-process-safe.ts';
import { decideArmToken, keychainServiceFor, parseStoredCredentials } from './core/claude-credentials-core.ts';
import type { LoginAccessToken } from './core/claude-credentials-core.ts';
import type { LoginSource } from './agent-login/core/agent-connect-core.ts';

const OVERRIDE_TOKEN_ENV = 'GLIMMERVOID_CLAUDE_OAUTH_TOKEN';
const LOGIN_REFRESH_TIMEOUT_MS = 120_000;
const ARM_ONLY_ENV_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']);

type Sleeper = (durationMs: number, signal: AbortSignal | undefined) => Promise<void>;

type CommandRunner = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<{ ok: boolean; stdout: string }>;

interface ClaudeCredentialsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  connectedConfigDir?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  claudeCommand: () => string | null;
  runCommand?: CommandRunner;
  readTextFile?: (filePath: string) => Promise<string | null>;
  sleep?: Sleeper;
}

async function runCommandSafely(command: string, args: string[], { env, timeoutMs, signal }: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, env, signal });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function readTextFileOrNull(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch(() => null);
}

function sleepUnlessAborted(durationMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

interface StoredLogin {
  token: LoginAccessToken;
  source: LoginSource;
}

function loginEnvironment(env: NodeJS.ProcessEnv, connectedConfigDir: string | null): NodeJS.ProcessEnv {
  const operatorEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of ARM_ONLY_ENV_KEYS) delete operatorEnv[key];
  if (connectedConfigDir) operatorEnv.CLAUDE_CONFIG_DIR = connectedConfigDir;
  return operatorEnv;
}

function createClaudeCredentials({
  platform = process.platform,
  homeDir = os.homedir(),
  connectedConfigDir = null,
  env = process.env,
  now = () => Date.now(),
  claudeCommand,
  runCommand = runCommandSafely,
  readTextFile = readTextFileOrNull,
  sleep = sleepUnlessAborted,
}: ClaudeCredentialsOptions) {
  const overrideToken = env[OVERRIDE_TOKEN_ENV] || null;
  delete env[OVERRIDE_TOKEN_ENV];

  async function readLoginTokenIn(configDir: string | null): Promise<LoginAccessToken | null> {
    if (platform === 'darwin') {
      const keychain = await runCommand('security', ['find-generic-password', '-s', keychainServiceFor(configDir), '-w'], { timeoutMs: 10_000 });
      return keychain.ok ? parseStoredCredentials(keychain.stdout) : null;
    }
    const stored = await readTextFile(path.join(configDir ?? path.join(homeDir, '.claude'), '.credentials.json'));
    return stored === null ? null : parseStoredCredentials(stored);
  }

  async function readStoredLogin(): Promise<StoredLogin | null> {
    const hostToken = await readLoginTokenIn(null);
    if (hostToken) return { token: hostToken, source: 'host' };
    if (!connectedConfigDir) return null;
    const connectedToken = await readLoginTokenIn(connectedConfigDir);
    return connectedToken ? { token: connectedToken, source: 'glimmervoid' } : null;
  }

  async function refreshLogin(command: string, source: LoginSource | null, signal: AbortSignal | undefined): Promise<void> {
    const configDir = source === 'glimmervoid' ? connectedConfigDir : null;
    await runCommand(command, ['-p', 'Reply with OK.'], { env: loginEnvironment(env, configDir), timeoutMs: LOGIN_REFRESH_TIMEOUT_MS, signal });
  }

  async function resolveArmToken(cellTimeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    if (overrideToken) return { ok: true, token: overrideToken };
    const cancelled = { ok: false as const, reason: 'the run was cancelled before the login was refreshed' };
    const commandMissing = { ok: false as const, reason: 'the claude command could not be found, so the Claude Code login cannot be refreshed' };
    let hasRefreshed = false;
    let hasWaitedForExpiry = false;
    let expiresAtBeforeRefresh: number | null = null;
    for (;;) {
      const stored = await readStoredLogin();
      const login = stored?.token ?? null;
      const decision = decideArmToken({ login, nowMs: now(), cellTimeoutSeconds, hasRefreshed, expiresAtBeforeRefresh, hasWaitedForExpiry });
      if (decision.kind === 'use') return { ok: true, token: decision.token };
      if (decision.kind === 'unavailable') return { ok: false, reason: decision.reason };
      if (signal?.aborted) return cancelled;
      const refreshCommand = claudeCommand();
      if (!refreshCommand) return commandMissing;
      if (decision.kind === 'wait') {
        await sleep(Math.max(0, decision.untilMs - now()), signal);
        if (signal?.aborted) return cancelled;
        hasWaitedForExpiry = true;
      }
      expiresAtBeforeRefresh = login?.expiresAt ?? null;
      await refreshLogin(refreshCommand, stored?.source ?? null, signal);
      hasRefreshed = true;
    }
  }

  async function loginSource(): Promise<LoginSource | null> {
    if (overrideToken) return 'host';
    return (await readStoredLogin())?.source ?? null;
  }

  return { loginSource, resolveArmToken };
}

export { OVERRIDE_TOKEN_ENV, createClaudeCredentials };
export type { CommandRunner, Sleeper };
