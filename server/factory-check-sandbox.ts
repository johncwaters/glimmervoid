import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from './child-process-safe.ts';
import { prepareSandboxLaunch } from './sandbox-launch.ts';

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
  const tempDir = path.join(scratchParent, 'tmp');
  await mkdir(tempDir);
  const prepared = await prepareSandboxLaunch({
    role: {
      vendors: [], vendorHome: { scope: 'state' }, network: { access: 'none' }, writableRoots: writablePaths,
      lockedCheckouts: [], commitCheckouts: [], readDenied: [], readableWithinDenied: readablePaths,
    },
    launchId: path.basename(scratchParent),
    tempDir,
  });
  if (!prepared.ok) throw new Error(`Factory checks need the sandbox runtime: ${prepared.reason}`);
  const { launch } = prepared;
  const runCheck: FactoryCheckRunner = async (argv, { timeout, signal, ...execOptions }) => {
    const [checkCommand, ...checkArgs] = argv;
    if (checkCommand === undefined) throw new Error('Factory check command is empty');
    const wrapped = await launch.wrap(checkCommand, checkArgs);
    const timeoutSignal = AbortSignal.timeout(timeout);
    try {
      return await execFileAsync(wrapped.file, wrapped.args, {
        ...execOptions, signal: AbortSignal.any([signal, timeoutSignal]), env: { ...execOptions.env, ...launch.env },
      });
    } catch (error) {
      if (!timeoutSignal.aborted) throw error;
      throw timedOutCheckFailure(timeout, error);
    }
  };
  return { runCheck, dispose: launch.dispose };
};

export { prepareSandboxedCheckRunner };
export type { FactoryCheckRunner, FactoryCheckSandbox, PrepareFactoryCheckRunner };
