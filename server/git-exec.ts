import { errorMessage } from '../shared/text.ts';
import { execFileAsync } from './child-process-safe.ts';

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

interface CommandResult {
  ok: boolean;
  out: string;
  err: string;
  stderr?: string;
  error?: unknown;
  timedOut?: boolean;
  exitCode?: number | null;
}

interface ExecFileOptions {
  cwd?: string;
  encoding: 'utf8';
  timeout: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  replaceEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  input?: string;
  trim?: boolean;
  keepStdoutOnFailure?: boolean;
  preferStderr?: boolean;
  execFileFn?: ExecFileFn;
}

interface RunGitOptions extends RunCommandOptions {
  gitPath?: string;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return value == null ? '' : String(value);
}

function childEnv(env: Record<string, string> | undefined, replaceEnv: NodeJS.ProcessEnv | undefined): { env?: NodeJS.ProcessEnv } {
  if (replaceEnv) return { env: replaceEnv };
  if (env) return { env: { ...process.env, ...env } };
  return {};
}

async function runCommand(file: string, args: readonly string[], {
  cwd,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxBuffer,
  env,
  replaceEnv,
  signal,
  input,
  trim = true,
  keepStdoutOnFailure = false,
  preferStderr = false,
  execFileFn = execFileAsync,
}: RunCommandOptions = {}): Promise<CommandResult> {
  const execOptions: ExecFileOptions = {
    encoding: 'utf8',
    timeout: timeoutMs,
    ...(cwd === undefined ? {} : { cwd }),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(signal ? { signal } : {}),
    ...(input === undefined ? {} : { input }),
    ...childEnv(env, replaceEnv),
  };
  try {
    const { stdout, stderr } = await execFileFn(file, args, execOptions);
    const out = outputText(stdout);
    return { ok: true, out: trim ? out.trim() : out, err: '', stderr: outputText(stderr) };
  } catch (error) {
    const failure = (error ?? {}) as { stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown; code?: unknown };
    const stdout = outputText(failure.stdout);
    const stderr = outputText(failure.stderr);
    const message = errorMessage(error);
    const out = keepStdoutOnFailure ? (trim ? stdout.trim() : stdout) : '';
    return {
      ok: false,
      out,
      err: preferStderr ? stderr || message : message,
      stderr,
      error,
      timedOut: failure.killed === true && Boolean(failure.signal),
      exitCode: typeof failure.code === 'number' ? failure.code : null,
    };
  }
}

function runGit(args: readonly string[], { gitPath = 'git', env, replaceEnv, ...rest }: RunGitOptions = {}): Promise<CommandResult> {
  const baseEnv = replaceEnv ?? (env ? { ...process.env, ...env } : process.env);
  return runCommand(gitPath, args, { ...rest, replaceEnv: { ...baseEnv, GIT_TERMINAL_PROMPT: '0' } });
}

function gitCommandFailure(args: readonly string[], command: CommandResult, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): unknown {
  if (!command.timedOut) return command.error;
  return new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, { cause: command.error });
}

function runGh(args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return runCommand('gh', args, options);
}

export { DEFAULT_COMMAND_TIMEOUT_MS, gitCommandFailure, runCommand, runGh, runGit };
export type { CommandResult, ExecFileFn, ExecFileOptions, RunCommandOptions, RunGitOptions };
