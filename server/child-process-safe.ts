
import cp from "node:child_process";
import type {
  ChildProcess,
  ExecException,
  ExecFileOptions,
  ExecFileOptionsWithStringEncoding,
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithStringEncoding,
  ExecSyncOptions,
  ExecSyncOptionsWithStringEncoding,
  SpawnOptions,
} from "node:child_process";
import { promisify } from "node:util";

type ExecFileCallback = (
  error: ExecException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileFn = ((file: string, ...rest: unknown[]) => ChildProcess) & {
  [promisify.custom]: (file: string, ...rest: unknown[]) => Promise<ExecFileResult>;
};

let refusedNodePath: string | null = null;

const STOPPED_CHILD_KILL_GRACE_MS = 2_000;

function refuseLaunchesOf(nodePath: string): void {
  refusedNodePath = nodePath;
}

function assertLaunchable(file: string): void {
  if (file !== refusedNodePath) return;
  throw new Error(`[launch] refused ${file}: launch Node through stableNodePath from server/stable-node-path.ts, because a Node upgrade deletes this path under the running server`);
}

function hide(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== 'object') return { windowsHide: true };
  return { ...options, windowsHide: true };
}

function split(rest: unknown[]): {
  args: string[] | undefined;
  options: Record<string, unknown> | undefined;
  callback: ExecFileCallback | undefined;
} {
  let args: string[] | undefined;
  let options: Record<string, unknown> | undefined;
  let callback: ExecFileCallback | undefined;
  for (const v of rest) {
    if (Array.isArray(v) && !v.every((entry) => typeof entry === 'string')) throw new TypeError('command arguments must all be strings');
    if (Array.isArray(v)) args = v;
    if (typeof v === "function") callback = v as ExecFileCallback;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      options = v as Record<string, unknown>;
    }
  }
  return { args, options, callback };
}

const execFile: ExecFileFn = Object.assign(
  function execFile(file: string, ...rest: unknown[]): ChildProcess {
    assertLaunchable(file);
    const { args, options, callback } = split(rest);
    const execOptions = hide(options) as ExecFileOptions;
    return cp.execFile(file, args, execOptions, callback);
  },
  {
    [promisify.custom]: (file: string, ...rest: unknown[]) => new Promise<ExecFileResult>((resolve, reject) => {
      assertLaunchable(file);
      const { args, options } = split(rest);
      const { input, ...commandOptions } = options ?? {};
      const execOptions = hide(commandOptions) as ExecFileOptionsWithStringEncoding;
      const callback = (err: ExecException | null, stdout: string, stderr: string) => {
        if (err) {
          const failure = err as ExecException & { stdout?: string; stderr?: string };
          failure.stdout = stdout;
          failure.stderr = stderr;
          return rejectOnceExited(child, () => reject(failure));
        }
        resolve({ stdout, stderr });
      };
      const child: ChildProcess = cp.execFile(file, args, execOptions, callback);
      killIfStopIgnored(child, execOptions.timeout, execOptions.signal);
      if (typeof input !== 'string') return;
      if (!child.stdin) return reject(new Error('execFile stdin unavailable'));
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') return;
        reject(error);
      });
      child.stdin.end(input);
    }),
  },
);

function rejectOnceExited(child: ChildProcess, rejectFailure: () => void): void {
  const isStillRunning = child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (isStillRunning) {
    child.once('exit', rejectFailure);
    return;
  }
  rejectFailure();
}

function killIfStopIgnored(child: ChildProcess, timeoutMs: number | undefined, signal: AbortSignal | undefined): void {
  const pendingTimers: NodeJS.Timeout[] = [];
  const scheduleForcedKill = () => {
    const forcedKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
    }, STOPPED_CHILD_KILL_GRACE_MS);
    forcedKillTimer.unref();
    pendingTimers.push(forcedKillTimer);
  };
  if (timeoutMs) {
    const timeoutTimer = setTimeout(scheduleForcedKill, timeoutMs);
    timeoutTimer.unref();
    pendingTimers.push(timeoutTimer);
  }
  signal?.addEventListener('abort', scheduleForcedKill, { once: true });
  child.once('exit', () => {
    for (const timer of pendingTimers) clearTimeout(timer);
    signal?.removeEventListener('abort', scheduleForcedKill);
  });
}

function execFileSync(file: string, options: ExecFileSyncOptionsWithStringEncoding): string;
function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
function execFileSync(file: string, options?: ExecFileSyncOptions): string | Buffer;
function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
function execFileSync(file: string, ...rest: unknown[]): string | Buffer {
  assertLaunchable(file);
  const { args, options } = split(rest);
  const execOptions = hide(options) as ExecFileSyncOptions;
  if (args) return cp.execFileSync(file, args, execOptions);
  return cp.execFileSync(file, execOptions);
}

function execSync(command: string, options: ExecSyncOptionsWithStringEncoding): string;
function execSync(command: string, options?: ExecSyncOptions): string | Buffer;
function execSync(command: string, options?: ExecSyncOptions): string | Buffer {
  return cp.execSync(command, hide(options) as ExecSyncOptions);
}

function spawn(file: string, ...rest: unknown[]): ChildProcess {
  assertLaunchable(file);
  const { args, options } = split(rest);
  const spawnOptions = hide(options) as SpawnOptions;
  if (args) return cp.spawn(file, args, spawnOptions);
  return cp.spawn(file, spawnOptions);
}

const execFileAsync = promisify(execFile);

interface CommandRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
}

interface CommandRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failureCode: string | null;
  signal: string | null;
  wasKilled: boolean;
}

async function runCommandSafely(command: string, args: string[], { cwd, env, timeoutMs, maxBufferBytes, signal }: CommandRunOptions): Promise<CommandRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBufferBytes, ...(signal ? { signal } : {}) });
    return { ok: true, stdout, stderr, exitCode: 0, failureCode: null, signal: null, wasKilled: false };
  } catch (error) {
    const failure = (error ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
    return {
      ok: false,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr || failure.message || ""),
      exitCode: typeof failure.code === "number" ? failure.code : null,
      failureCode: typeof failure.code === "string" ? failure.code : null,
      signal: typeof failure.signal === "string" ? failure.signal : null,
      wasKilled: failure.killed === true,
    };
  }
}

export { assertLaunchable, execFile, execFileAsync, execFileSync, execSync, refuseLaunchesOf, runCommandSafely, spawn, hide };
export type { CommandRunOptions, CommandRunResult };
