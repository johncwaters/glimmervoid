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
import { withoutInheritedCredentials } from './core/credential-decider-core.ts';
import { kimiLoginFileText, kimiRefreshRequest, kimiRefreshTokenOf, loginExpiryAtMs, nextRefreshAtMs } from './core/login-refresh-core.ts';
import { kimiLoginSource } from '../../shared/kimi-login-core.ts';
import type { ModelLogin } from './credential-proxy.ts';

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
const CLAUDE_REFRESH_ARGS = ['-p', 'Reply with OK.', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', ...selectionArgs(choiceSelection('claude-code', { model: DEFAULT_MODELS.loginRefresh }))];

interface LoginWatch {
  ready: Promise<void>;
  unwatch: () => void;
}

interface WatchedLogin {
  login: ModelLogin & { loginFile: string };
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
    const current = await readLoginState('kimi', loginFile);
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

const REFRESH_BY_AGENT: Readonly<Record<string, (loginFile: string) => Promise<RefreshOutcome>>> = Object.freeze({
  'claude-code': refreshClaudeLogin,
  codex: refreshCodexLogin,
  kimi: refreshKimiLogin,
});

async function readLoginState(agent: string, loginFile: string): Promise<LoginState | null> {
  const [text, loginStat] = await Promise.all([fsp.readFile(loginFile, 'utf8').catch(() => null), fsp.stat(loginFile).catch(() => null)]);
  if (text === null || loginStat === null) return null;
  const expiresAtMs = loginExpiryAtMs(agent, text);
  if (expiresAtMs === null) return null;
  return { text, mtimeMs: loginStat.mtimeMs, expiresAtMs, dueAtMs: nextRefreshAtMs(agent, expiresAtMs, Math.max(0, expiresAtMs - loginStat.mtimeMs)) };
}

function retryDelayMs(failureCount: number): number {
  return Math.min(RETRY_DELAY_MS * 2 ** Math.max(0, failureCount - 1), MAX_RETRY_DELAY_MS);
}

function createLoginRefresher(logger: Pick<Console, 'warn'>) {
  const watchedByKey = new Map<string, WatchedLogin>();

  const warnOnce = (watched: WatchedLogin, warning: string) => {
    if (watched.lastWarning === warning) return;
    watched.lastWarning = warning;
    logger.warn(warning);
  };

  const schedule = (watched: WatchedLogin, login: ModelLogin & { loginFile: string }, delayMs: number) => {
    if (watched.isStopped) return;
    if (watched.timer !== null) clearTimeout(watched.timer);
    watched.timer = setTimeout(() => {
      watched.timer = null;
      void keepFresh(watched, login);
    }, Math.max(0, delayMs));
    watched.timer.unref();
  };

  const afterFailure = (watched: WatchedLogin, login: ModelLogin & { loginFile: string }, reason: string): number => {
    watched.failureCount += 1;
    const delayMs = retryDelayMs(watched.failureCount);
    warnOnce(watched, `[login-refresh] ${login.agent} login at ${login.loginFile} did not refresh: ${reason}; retrying in ${Math.round(delayMs / 1000)} s`);
    return delayMs;
  };

  const refreshOnce = async (watched: WatchedLogin, login: ModelLogin & { loginFile: string }, before: LoginState): Promise<number> => {
    const refresh = REFRESH_BY_AGENT[login.agent];
    if (refresh === undefined) return Number.POSITIVE_INFINITY;
    const outcome = await refresh(login.loginFile).catch((error: unknown) => transientFailure(errorMessage(error)));
    const after = await readLoginState(login.agent, login.loginFile);
    if (!outcome.ok && outcome.isLasting) {
      watched.lastingFailureMtimeMs = after?.mtimeMs ?? before.mtimeMs;
      warnOnce(watched, `[login-refresh] ${login.agent} login at ${login.loginFile} needs signing in again: ${outcome.reason}; waiting for the login to change`);
      return RETRY_DELAY_MS;
    }
    if (!outcome.ok) return afterFailure(watched, login, outcome.reason);
    if (after === null || after.expiresAtMs <= before.expiresAtMs) return afterFailure(watched, login, 'the login kept its old expiry');
    watched.failureCount = 0;
    watched.lastWarning = null;
    return after.dueAtMs - clock.nowMs();
  };

  const nextDelayMs = async (watched: WatchedLogin, login: ModelLogin & { loginFile: string }): Promise<number> => {
    const state = await readLoginState(login.agent, login.loginFile);
    if (state === null) {
      warnOnce(watched, `[login-refresh] ${login.agent} login at ${login.loginFile} is missing or unreadable; checking again in ${RETRY_DELAY_MS / 1000} s`);
      return RETRY_DELAY_MS;
    }
    if (watched.lastingFailureMtimeMs === state.mtimeMs) return RETRY_DELAY_MS;
    watched.lastingFailureMtimeMs = null;
    if (clock.nowMs() < state.dueAtMs) return state.dueAtMs - clock.nowMs();
    return refreshOnce(watched, login, state);
  };

  const keepFresh = (watched: WatchedLogin, login: ModelLogin & { loginFile: string }): Promise<void> => {
    watched.inFlight ??= nextDelayMs(watched, login)
      .then((delayMs) => { if (Number.isFinite(delayMs)) schedule(watched, login, delayMs); })
      .finally(() => { watched.inFlight = null; });
    return watched.inFlight;
  };

  const watch = (login: ModelLogin): LoginWatch => {
    const loginFile = login.loginFile;
    if (loginFile === null || REFRESH_BY_AGENT[login.agent] === undefined) return { ready: Promise.resolve(), unwatch: () => {} };
    const key = `${login.agent}\n${loginFile}`;
    const watched = watchedByKey.get(key) ?? { login: { agent: login.agent, loginFile }, holders: 0, timer: null, inFlight: null, isStopped: false, failureCount: 0, lastingFailureMtimeMs: null, lastWarning: null };
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

  const recheckAll = () => {
    for (const watched of watchedByKey.values()) void keepFresh(watched, watched.login);
  };

  return { watch, recheckAll };
}

export { createLoginRefresher };
