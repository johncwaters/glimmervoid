import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from './child-process-safe.ts';
import { decideArmToken, parseStoredCredentials } from './core/claude-credentials-core.ts';
import type { LoginAccessToken } from './core/claude-credentials-core.ts';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OVERRIDE_TOKEN_ENV = 'GLIMMERVOID_CLAUDE_OAUTH_TOKEN';
const LOGIN_REFRESH_TIMEOUT_MS = 120_000;
const ARM_ONLY_ENV_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']);

type CommandRunner = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<{ ok: boolean; stdout: string }>;

interface ClaudeCredentialsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  claudeCommand: () => string | null;
  runCommand?: CommandRunner;
  readTextFile?: (filePath: string) => Promise<string | null>;
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

function loginEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const operatorEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of ARM_ONLY_ENV_KEYS) delete operatorEnv[key];
  return operatorEnv;
}

function createClaudeCredentials({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  now = () => Date.now(),
  claudeCommand,
  runCommand = runCommandSafely,
  readTextFile = readTextFileOrNull,
}: ClaudeCredentialsOptions) {
  const overrideToken = env[OVERRIDE_TOKEN_ENV] || null;
  delete env[OVERRIDE_TOKEN_ENV];

  async function readLoginToken(): Promise<LoginAccessToken | null> {
    if (platform === 'darwin') {
      const keychain = await runCommand('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeoutMs: 10_000 });
      return keychain.ok ? parseStoredCredentials(keychain.stdout) : null;
    }
    const stored = await readTextFile(path.join(homeDir, '.claude', '.credentials.json'));
    return stored === null ? null : parseStoredCredentials(stored);
  }

  async function refreshLogin(signal: AbortSignal | undefined): Promise<void> {
    const command = claudeCommand();
    if (!command) return;
    await runCommand(command, ['-p', 'Reply with OK.'], { env: loginEnvironment(env), timeoutMs: LOGIN_REFRESH_TIMEOUT_MS, signal });
  }

  async function resolveArmToken(cellTimeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    if (overrideToken) return { ok: true, token: overrideToken };
    let hasRefreshed = false;
    let expiresAtBeforeRefresh: number | null = null;
    for (;;) {
      const login = await readLoginToken();
      const decision = decideArmToken({ login, nowMs: now(), cellTimeoutSeconds, hasRefreshed, expiresAtBeforeRefresh });
      if (decision.kind === 'use') return { ok: true, token: decision.token };
      if (decision.kind === 'unavailable') return { ok: false, reason: decision.reason };
      if (signal?.aborted) return { ok: false, reason: 'the run was cancelled before the login was refreshed' };
      expiresAtBeforeRefresh = login?.expiresAt ?? null;
      await refreshLogin(signal);
      hasRefreshed = true;
    }
  }

  return { resolveArmToken };
}

export { OVERRIDE_TOKEN_ENV, createClaudeCredentials };
export type { ClaudeCredentialsOptions, CommandRunner };
