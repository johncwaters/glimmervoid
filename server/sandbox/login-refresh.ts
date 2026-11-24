import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommandSafely } from '../child-process-safe.ts';
import { requestCodexAppServer } from '../codex-app-server-request.ts';
import { writeTextAtomic } from '../json-file.ts';
import { commandFor, resolveAdapter } from '../../session/adapters/index.ts';
import { withoutGlimmervoidSecrets } from '../../session/core/spawn-env.ts';
import { choiceSelection, selectionArgs } from '../../shared/agent-models-core.ts';
import { clock } from '../../shared/clock.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';
import { errorMessage } from '../../shared/text.ts';
import { isKeyringLoginAgent, withoutInheritedCredentials } from './core/credential-decider-core.ts';
import { kimiLoginFileText, kimiRefreshRequest, kimiRefreshTokenOf, loginExpiryAtMs, nextRefreshAtMs } from './core/login-refresh-core.ts';
import { kimiLoginSource } from '../../shared/kimi-login-core.ts';
import type { ModelLogin } from './credential-proxy.ts';
import type { KeyringRead } from './keyring-reader.ts';

const REFRESH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
const KIMI_LOCK_STALE_MS = 5_000;
const KIMI_LOCK_KEEPALIVE_MS = 2_000;
const KIMI_LOCK_WAIT_MS = 500;
const KIMI_LOCK_ATTEMPTS = 20;
const KIMI_CONFIG_NAME = 'config.toml';
const KIMI_LOGIN_FILE_EXTENSION = '.json';
const KIMI_LASTING_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const CLAUDE_SIGNED_OUT_OUTPUT = /\/login|log ?in again|not logged in|invalid api key/i;
const ANTIGRAVITY_SIGNED_OUT_OUTPUT = /not logged in|authentication required|log ?in|sign ?in/i;
const ANTIGRAVITY_REFRESH_ARGS: readonly string[] = Object.freeze(['models']);
const CLAUDE_REFRESH_ARGS = ['-p', 'Reply with OK.', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', ...selectionArgs(choiceSelection('claude-code', { model: DEFAULT_MODELS.loginRefresh }))];

interface LoginWatch {
  ready: Promise<void>;
  unwatch: () => void;
}

type ReadKeyringLogin = (agent: string) => Promise<KeyringRead>;

interface WatchedLogin {
  login: ModelLogin;
  holders: number;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  isStopped: boolean;
  failureCount: number;
  lastingFailureMtimeMs: number | null;
  lastWarning: string | null;
}

interface LoginState {
  text: string;
  mtimeMs: number;
  expiresAtMs: number;
  dueAtMs: number;
}

type RefreshOutcome = { ok: true } | { ok: false; reason: string; isLasting: boolean };

const REFRESHED: RefreshOutcome = Object.freeze({ ok: true });

function transientFailure(reason: string): RefreshOutcome {
  return { ok: false, reason, isLasting: false };
}

function lastingFailure(reason: string): RefreshOutcome {
  return { ok: false, reason, isLasting: true };
}

function refreshEnv(extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...withoutInheritedCredentials(withoutGlimmervoidSecrets(process.env), []), ...extraEnv };
}

function agentCommand(agent: string, agentArgs: readonly string[]): { file: string; args: string[] } | null {
  const adapter = resolveAdapter(agent);
  if (!adapter) return null;
  return adapter.buildSpawnCommand({ platform: process.platform, resolved: commandFor(adapter), agentArgs: [...agentArgs] });
}

async function refreshClaudeLogin(loginFile: string): Promise<RefreshOutcome> {
  const home = path.dirname(loginFile);
  const command = agentCommand('claude-code', CLAUDE_REFRESH_ARGS);
  if (command === null) return transientFailure('Claude Code is not installed');
  const workFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-login-refresh-'));
  try {
    const homeEnv: Record<string, string> = home === path.join(os.homedir(), '.claude') ? {} : { CLAUDE_CONFIG_DIR: home };
    const run = await runCommandSafely(command.file, command.args, { cwd: workFolder, env: refreshEnv(homeEnv), timeoutMs: REFRESH_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 });
    if (run.ok) return REFRESHED;
    const output = `${run.stdout}\n${run.stderr}`;
    const reason = `claude -p failed: ${output.trim().slice(-300) || `exit ${run.exitCode}`}`;
    return CLAUDE_SIGNED_OUT_OUTPUT.test(output) ? lastingFailure(reason) : transientFailure(reason);
  } finally {
    await fsp.rm(workFolder, { recursive: true, force: true });
  }
}

async function refreshCodexLogin(loginFile: string): Promise<RefreshOutcome> {
  const command = agentCommand('codex', []);
  if (command === null) return transientFailure('Codex is not installed');
  const env = refreshEnv({ CODEX_HOME: path.dirname(loginFile) });
  const response = await requestCodexAppServer({ file: command.file, argsBeforeAppServer: command.args }, env, { method: 'account/read', params: { refreshToken: true }, timeoutMs: REFRESH_TIMEOUT_MS });
  return response === null ? transientFailure('codex app-server did not answer account/read') : REFRESHED;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function takeKimiLock(lockFolder: string): Promise<boolean> {
  for (let attempt = 0; attempt < KIMI_LOCK_ATTEMPTS; attempt += 1) {
    const isTaken = await fsp.mkdir(lockFolder).then(() => true, () => false);
    if (isTaken) return true;
    const lockStat = await fsp.lstat(lockFolder).catch(() => null);
    if (lockStat?.isDirectory() === true && clock.nowMs() - lockStat.mtimeMs > KIMI_LOCK_STALE_MS) await fsp.rmdir(lockFolder).catch(() => {});
    await delay(KIMI_LOCK_WAIT_MS);
  }
  return false;
}

async function withKimiRefreshLock(home: string, tokenName: string, work: () => Promise<RefreshOutcome>): Promise<RefreshOutcome> {
  const lockFolder = `${path.join(home, 'oauth', tokenName)}.lock`;
  await fsp.mkdir(path.dirname(lockFolder), { recursive: true, mode: 0o700 });
  const isLockHeld = await takeKimiLock(lockFolder);
  const keepalive = isLockHeld ? setInterval(() => {
    const now = clock.now();
    void fsp.utimes(lockFolder, now, now).catch(() => {});
  }, KIMI_LOCK_KEEPALIVE_MS) : null;
  try {
    return await work();
  } finally {
    if (keepalive !== null) clearInterval(keepalive);
    if (isLockHeld) await fsp.rmdir(lockFolder).catch(() => {});
  }
}

async function postKimiRefresh(refreshToken: string, home: string): Promise<{ reply: unknown } | RefreshOutcome> {
  const configText = await fsp.readFile(path.join(home, KIMI_CONFIG_NAME), 'utf8').catch(() => null);
  const login = kimiLoginSource(configText, process.env);
  if ('refusal' in login) return lastingFailure(login.refusal);
  const request = kimiRefreshRequest(refreshToken, process.env, login.oauthHost);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: request.body,
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (response.ok) return { reply: await response.json() };
  const reason = `the Kimi Code token endpoint answered ${response.status}`;
  if (KIMI_LASTING_STATUSES.has(response.status)) return lastingFailure(reason);
  const body = await response.text().catch(() => '');
  return body.includes('invalid_grant') ? lastingFailure(reason) : transientFailure(reason);
}

async function refreshKimiLogin(loginFile: string): Promise<RefreshOutcome> {
  const home = path.dirname(path.dirname(loginFile));
  return withKimiRefreshLock(home, path.basename(loginFile, KIMI_LOGIN_FILE_EXTENSION), async () => {
    const current = await readFileLoginState('kimi', loginFile);
    if (current === null || clock.nowMs() < current.dueAtMs) return REFRESHED;
    const refreshToken = kimiRefreshTokenOf(current.text);
    if (refreshToken === null) return lastingFailure('the Kimi Code login has no refresh token');
    const answer = await postKimiRefresh(refreshToken, home);
    if (!('reply' in answer)) return answer;
    const loginText = kimiLoginFileText(answer.reply, clock.nowMs());
    if (loginText === null) return transientFailure('the Kimi Code token endpoint answered in a shape Glimmervoid does not read');
    await writeTextAtomic(loginFile, loginText, { mode: 0o600, enforceMode: true });
    return REFRESHED;
  });
}

async function refreshAntigravityLogin(): Promise<RefreshOutcome> {
  const command = agentCommand('antigravity', ANTIGRAVITY_REFRESH_ARGS);
  if (command === null) return transientFailure('Antigravity CLI is not installed');
  const run = await runCommandSafely(command.file, command.args, { cwd: os.homedir(), env: refreshEnv({}), timeoutMs: REFRESH_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 });
  if (run.ok) return REFRESHED;
  const output = `${run.stdout}\n${run.stderr}`;
  const reason = `agy models failed: ${output.trim().slice(-300) || `exit ${run.exitCode}`}`;
  return ANTIGRAVITY_SIGNED_OUT_OUTPUT.test(output) ? lastingFailure(reason) : transientFailure(reason);
}

function withLoginFile(refresh: (loginFile: string) => Promise<RefreshOutcome>): (login: ModelLogin) => Promise<RefreshOutcome> {
  return async (login) => login.loginFile === null ? transientFailure('the login has no file') : refresh(login.loginFile);
}

const REFRESH_BY_AGENT: Readonly<Record<string, (login: ModelLogin) => Promise<RefreshOutcome>>> = Object.freeze({
  'claude-code': withLoginFile(refreshClaudeLogin),
  codex: withLoginFile(refreshCodexLogin),
  kimi: withLoginFile(refreshKimiLogin),
  antigravity: refreshAntigravityLogin,
});

function loginStateOf(agent: string, text: string, changeStampMs: number): LoginState | null {
  const expiresAtMs = loginExpiryAtMs(agent, text);
  if (expiresAtMs === null) return null;
  return { text, mtimeMs: changeStampMs, expiresAtMs, dueAtMs: nextRefreshAtMs(agent, expiresAtMs, Math.max(0, expiresAtMs - changeStampMs)) };
}

async function readFileLoginState(agent: string, loginFile: string): Promise<LoginState | null> {
  const [text, loginStat] = await Promise.all([fsp.readFile(loginFile, 'utf8').catch(() => null), fsp.stat(loginFile).catch(() => null)]);
  if (text === null || loginStat === null) return null;
  return loginStateOf(agent, text, loginStat.mtimeMs);
}

async function readKeyringLoginState(agent: string, readKeyringLogin: ReadKeyringLogin): Promise<LoginState | null> {
  const keyringLogin = await readKeyringLogin(agent);
  if ('refusal' in keyringLogin) return null;
  const expiresAtMs = loginExpiryAtMs(agent, keyringLogin.secret);
  return expiresAtMs === null ? null : loginStateOf(agent, keyringLogin.secret, expiresAtMs);
}

function loginReaderFor(readKeyringLogin: ReadKeyringLogin): (login: ModelLogin) => Promise<LoginState | null> {
  return async (login) => {
    if (isKeyringLoginAgent(login.agent)) return readKeyringLoginState(login.agent, readKeyringLogin);
    return login.loginFile === null ? null : readFileLoginState(login.agent, login.loginFile);
  };
}

function loginLabelOf(login: ModelLogin): string {
  return login.loginFile ?? 'the keyring';
}

function retryDelayMs(failureCount: number): number {
  return Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, failureCount - 1), MAX_RETRY_DELAY_MS);
}

function createLoginRefresher(logger: Pick<Console, 'warn'>, readKeyringLogin: ReadKeyringLogin) {
  const watchedByKey = new Map<string, WatchedLogin>();
  const readLoginState = loginReaderFor(readKeyringLogin);

  const warnOnce = (watched: WatchedLogin, warning: string) => {
    if (watched.lastWarning === warning) return;
    watched.lastWarning = warning;
    logger.warn(warning);
  };

  const schedule = (watched: WatchedLogin, login: ModelLogin, delayMs: number) => {
    if (watched.isStopped) return;
    if (watched.timer !== null) clearTimeout(watched.timer);
    watched.timer = setTimeout(() => {
      watched.timer = null;
      void keepFresh(watched, login);
    }, Math.max(0, delayMs));
    watched.timer.unref();
  };

  const afterFailure = (watched: WatchedLogin, login: ModelLogin, reason: string): number => {
    watched.failureCount += 1;
    const delayMs = retryDelayMs(watched.failureCount);
    warnOnce(watched, `[login-refresh] ${login.agent} login at ${loginLabelOf(login)} did not refresh: ${reason}; retrying in ${Math.round(delayMs / 1000)} s`);
    return delayMs;
  };

  const refreshOnce = async (watched: WatchedLogin, login: ModelLogin, before: LoginState): Promise<number> => {
    const refresh = REFRESH_BY_AGENT[login.agent];
    if (refresh === undefined) return Number.POSITIVE_INFINITY;
    const outcome = await refresh(login).catch((error: unknown) => transientFailure(errorMessage(error)));
    const after = await readLoginState(login);
    if (!outcome.ok && outcome.isLasting) {
      watched.lastingFailureMtimeMs = after?.mtimeMs ?? before.mtimeMs;
      warnOnce(watched, `[login-refresh] ${login.agent} login at ${loginLabelOf(login)} needs signing in again: ${outcome.reason}; waiting for the login to change`);
      return RETRY_DELAY_MS;
    }
    if (!outcome.ok) return afterFailure(watched, login, outcome.reason);
    if (after === null || after.expiresAtMs <= before.expiresAtMs) return afterFailure(watched, login, 'the login kept its old expiry');
    watched.failureCount = 0;
    watched.lastWarning = null;
    return after.dueAtMs - clock.nowMs();
  };

  const nextDelayMs = async (watched: WatchedLogin, login: ModelLogin): Promise<number> => {
    const state = await readLoginState(login);
    if (state === null) {
      warnOnce(watched, `[login-refresh] ${login.agent} login at ${loginLabelOf(login)} is missing or unreadable; checking again in ${RETRY_DELAY_MS / 1000} s`);
      return RETRY_DELAY_MS;
    }
    if (watched.lastingFailureMtimeMs === state.mtimeMs) return RETRY_DELAY_MS;
    watched.lastingFailureMtimeMs = null;
    if (clock.nowMs() < state.dueAtMs) return state.dueAtMs - clock.nowMs();
    return refreshOnce(watched, login, state);
  };

  const keepFresh = (watched: WatchedLogin, login: ModelLogin): Promise<void> => {
    watched.inFlight ??= nextDelayMs(watched, login)
      .then((delayMs) => { if (Number.isFinite(delayMs)) schedule(watched, login, delayMs); })
      .finally(() => { watched.inFlight = null; });
    return watched.inFlight;
  };

  const watchKeyOf = (login: ModelLogin) => `${login.agent}\n${login.loginFile ?? ''}`;

  const watch = (login: ModelLogin): LoginWatch => {
    const isWatchable = login.loginFile !== null || isKeyringLoginAgent(login.agent);
    if (!isWatchable || REFRESH_BY_AGENT[login.agent] === undefined) return { ready: Promise.resolve(), unwatch: () => {} };
    const key = watchKeyOf(login);
    const watched = watchedByKey.get(key) ?? { login: { agent: login.agent, loginFile: login.loginFile }, holders: 0, timer: null, inFlight: null, isStopped: false, failureCount: 0, lastingFailureMtimeMs: null, lastWarning: null };
    watchedByKey.set(key, watched);
    watched.holders += 1;
    const ready = watched.inFlight ?? (watched.timer === null ? keepFresh(watched, watched.login) : Promise.resolve());
    let isUnwatched = false;
    const unwatch = () => {
      if (isUnwatched) return;
      isUnwatched = true;
      watched.holders -= 1;
      if (watched.holders > 0) return;
      watched.isStopped = true;
      if (watched.timer !== null) clearTimeout(watched.timer);
      if (watchedByKey.get(key) === watched) watchedByKey.delete(key);
    };
    return { ready: ready.catch(() => {}), unwatch };
  };

  const refreshIfDue = async (login: ModelLogin): Promise<void> => {
    const watched = watchedByKey.get(watchKeyOf(login));
    if (watched === undefined || watched.isStopped) return;
    if (watched.inFlight !== null) return watched.inFlight;
    const isWaitingOutFailure = watched.failureCount > 0 || watched.lastingFailureMtimeMs !== null;
    if (isWaitingOutFailure) return;
    await keepFresh(watched, watched.login);
  };

  const recheckAll = () => {
    for (const watched of watchedByKey.values()) void keepFresh(watched, watched.login);
  };

  return { watch, recheckAll, refreshIfDue };
}

export { createLoginRefresher };
