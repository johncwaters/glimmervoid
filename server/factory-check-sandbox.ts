import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { buildFactoryCheckSandboxSettings } from './core/factory-core.ts';
import { writeJsonAtomic } from './json-file.ts';
import { resolvePackageBin } from './runtime-paths.ts';

interface FactoryCheckExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  signal: AbortSignal;
}

type FactoryCheckRunner = (argv: string[], options: FactoryCheckExecOptions) => Promise<{ stdout: string; stderr: string }>;

interface FactoryCheckSandbox {
  runCheck: FactoryCheckRunner;
  dispose: () => Promise<void>;
}

type PrepareFactoryCheckRunner = (paths: { scratchParent: string; writablePaths: string[]; readablePaths?: string[] }) => Promise<FactoryCheckSandbox>;

const TIMED_OUT_CHECK_STREAM_TAIL_CHARS = 1500;

function capturedStreamTail(failure: unknown, stream: 'stdout' | 'stderr'): string {
  if (!(failure instanceof Error)) return '';
  const captured: unknown = Reflect.get(failure, stream);
  if (typeof captured !== 'string') return '';
  return captured.slice(-TIMED_OUT_CHECK_STREAM_TAIL_CHARS);
}

function timedOutCheckFailure(timeoutMs: number, abortFailure: unknown): Error {
  const timeoutNotice = `Check timed out after ${Math.round(timeoutMs / 1000)} seconds`;
  return Object.assign(new Error(timeoutNotice, { cause: abortFailure }), {
    stdout: capturedStreamTail(abortFailure, 'stdout'),
    stderr: `${capturedStreamTail(abortFailure, 'stderr')}\n${timeoutNotice}`,
  });
}

const prepareSandboxedCheckRunner: PrepareFactoryCheckRunner = async ({ scratchParent, writablePaths, readablePaths = [] }) => {
  const sandboxCliPath = resolvePackageBin('@anthropic-ai/sandbox-runtime', 'srt');
  if (!sandboxCliPath) throw new Error('Factory checks need the sandbox runtime, and its CLI could not be resolved');
  const tempDir = path.join(scratchParent, 'tmp');
  const policyDir = path.join(glimmervoidHomeDir(), 'factory-check-policies');
  const settingsPath = path.join(policyDir, `${path.basename(scratchParent)}.json`);
  await mkdir(tempDir);
  await mkdir(policyDir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(settingsPath, buildFactoryCheckSandboxSettings({
    writablePaths: [...writablePaths, tempDir],
    privatePaths: [glimmervoidHomeDir()],
    readablePaths: [...readablePaths, ...writablePaths, tempDir],
  }));
  const runCheck: FactoryCheckRunner = async (argv, { timeout, signal, ...execOptions }) => {
    const timeoutSignal = AbortSignal.timeout(timeout);
    try {
      return await execFileAsync(process.execPath, [sandboxCliPath, '--settings', settingsPath, '--', ...argv], {
        ...execOptions, signal: AbortSignal.any([signal, timeoutSignal]), env: { ...execOptions.env, CLAUDE_CODE_TMPDIR: tempDir },
      });
    } catch (error) {
      if (!timeoutSignal.aborted) throw error;
      throw timedOutCheckFailure(timeout, error);
    }
  };
  return { runCheck, dispose: () => rm(settingsPath, { force: true }) };
};

export { prepareSandboxedCheckRunner };
export type { FactoryCheckRunner, FactoryCheckSandbox, PrepareFactoryCheckRunner };
