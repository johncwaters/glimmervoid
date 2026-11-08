import type { ChildProcess } from 'node:child_process';
import { spawn } from '../../server/child-process-safe.ts';
import { cliPath } from '../../server/runtime-paths.ts';
import { stableNodePath } from '../../server/stable-node-path.ts';
import { nextBackoffMs } from '../../shared/backoff.ts';
import type { WatcherChildEndKind } from '../../shared/contracts/telemetry.ts';
import { isRecord } from '../../shared/coerce.ts';
import { endKindOf } from './watcher-telemetry-core.ts';
import { GITHUB_API_BASE_ENV, githubApiOrigin, LINK_SECRET_ENV, LINK_SERVER_URL_ENV, WATCHER_HOME_ENV, WATCHER_LISTENING_MESSAGE } from '../../shared/contracts/watcher-link.ts';

interface WatcherChildEnding {
  endKind: WatcherChildEndKind;
  runMs: number;
  willRestart: boolean;
}

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 5 * 60_000;
const STABLE_RUN_MS = 60_000;
const INHERITED_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', GITHUB_API_BASE_ENV];

function inheritedEnvironment(): Record<string, string> {
  const entries = INHERITED_ENVIRONMENT_NAMES.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  });
  return Object.fromEntries(entries);
}

function createWatcherSupervisor({ linkSecret, serverUrl, watcherHome, onListening, onEnded, log = console }: {
  linkSecret: Buffer;
  serverUrl: string;
  watcherHome: string;
  onListening: (watcherUrl: string) => void;
  onEnded: (ending: WatcherChildEnding) => void;
  log?: Pick<Console, 'log' | 'warn'>;
}) {
  let crashCount = 0;
  let supervision: 'watching' | 'stopped' = 'watching';
  let runningChild: ChildProcess | null = null;
  let pendingRestart: NodeJS.Timeout | null = null;
  const isGithubApiOverrideIgnored = Boolean(process.env[GITHUB_API_BASE_ENV]) && githubApiOrigin(process.env) === githubApiOrigin({});
  if (isGithubApiOverrideIgnored) log.warn(`[watcher] ${GITHUB_API_BASE_ENV} does not name a loopback address, so GitHub probes keep reaching GitHub`);

  function scheduleRestart(endedHow: string, endKind: WatcherChildEndKind, runDurationMs: number): void {
    runningChild = null;
    onEnded({ endKind, runMs: runDurationMs, willRestart: supervision !== 'stopped' });
    if (supervision === 'stopped') return;
    crashCount = runDurationMs >= STABLE_RUN_MS ? 1 : crashCount + 1;
    const delayMs = nextBackoffMs({ attempt: crashCount, baseMs: RESTART_BASE_MS, maxMs: RESTART_MAX_MS, jitter: 'none' });
    log.warn(`[watcher] child ${endedHow}, restarting in ${Math.round(delayMs / 1000)}s`);
    pendingRestart = setTimeout(start, delayMs);
    pendingRestart.unref();
  }

  function spawnWatcherChild(): ChildProcess | Error {
    try {
      return spawn(stableNodePath, [cliPath, 'watch'], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...inheritedEnvironment(), [LINK_SECRET_ENV]: linkSecret.toString('hex'), [LINK_SERVER_URL_ENV]: serverUrl, [WATCHER_HOME_ENV]: watcherHome },
      });
    } catch (spawnError) {
      return spawnError instanceof Error ? spawnError : new Error(String(spawnError));
    }
  }

  function start(): void {
    pendingRestart = null;
    if (supervision === 'stopped') return;
    const startedAtMs = Date.now();
    let hasEnded = false;
    const endOnce = (endedHow: string, endKind: WatcherChildEndKind) => {
      if (hasEnded) return;
      hasEnded = true;
      scheduleRestart(endedHow, endKind, Date.now() - startedAtMs);
    };
    const failedToStart = (startError: Error) => endOnce(`failed to start (${startError.message})`, endKindOf({ exitCode: null, didFailToStart: true }));
    const watcherChild = spawnWatcherChild();
    if (watcherChild instanceof Error) {
      failedToStart(watcherChild);
      return;
    }
    runningChild = watcherChild;
    watcherChild.on('message', (message: unknown) => {
      if (!isRecord(message) || message.type !== WATCHER_LISTENING_MESSAGE || typeof message.port !== 'number') return;
      onListening(`http://127.0.0.1:${message.port}`);
    });
    watcherChild.once('error', failedToStart);
    watcherChild.once('exit', (code, signal) => endOnce(`exited (${signal ?? `code ${code}`})`, endKindOf({ exitCode: code, didFailToStart: false })));
    log.log(`[watcher] started child pid ${watcherChild.pid}`);
  }

  function stop(): void {
    supervision = 'stopped';
    if (pendingRestart !== null) clearTimeout(pendingRestart);
    runningChild?.kill();
  }

  return { start, stop };
}

export { createWatcherSupervisor };
export type { WatcherChildEnding };
