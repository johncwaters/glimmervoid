import fs from 'node:fs/promises';
import path from 'node:path';

import { execFile, spawn } from '../child-process-safe.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import { fnoxConfigText, fnoxEnvironment, fnoxReadArguments, fnoxTestArguments, readOutcomeOf, testOutcomeOf } from './core/fnox-core.ts';
import type { FnoxRunResult, ReadOutcome } from './core/fnox-core.ts';
import type { SecretName, SecretSource, SecretSourceTestResult } from '../../shared/contracts/secrets.ts';

const FNOX_READ_TIMEOUT_MS = 120_000;
const FNOX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STDIN_CONFIG_PATH = '/dev/stdin';
const UNCREATABLE_CONFIG_FOLDER = '/dev/null/fnox';

interface FnoxRunnerOptions {
  fnoxPath: string;
  runsRoot: string;
  environment: NodeJS.ProcessEnv;
  readTimeoutMs?: number;
}

interface FnoxRunner {
  read(source: SecretSource, name: SecretName): Promise<ReadOutcome>;
  test(source: SecretSource): Promise<SecretSourceTestResult>;
}

interface FnoxLaunch {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinText: string;
}

const isWindows = process.platform === 'win32';

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function createFnoxRunner({ fnoxPath, runsRoot, environment, readTimeoutMs = FNOX_READ_TIMEOUT_MS }: FnoxRunnerOptions): FnoxRunner {
  const queue = createSerialQueue();

  function runFnoxProcess({ args, cwd, env, stdinText }: FnoxLaunch): Promise<FnoxRunResult> {
    return new Promise((resolve) => {
      const child = spawn(fnoxPath, args, { cwd, env, detached: !isWindows, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let wasKilled = false;
      let failureCode: string | null = null;
      let isSettled = false;

      function settle(exitCode: number | null): void {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(deadline);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({ ok: exitCode === 0 && !wasKilled && failureCode === null, stdout, stderr, failureCode, wasKilled });
      }

      function stopTree(): void {
        wasKilled = true;
        killProcessTree(child.pid);
      }

      function collect(chunks: Buffer[]) {
        return (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > FNOX_OUTPUT_LIMIT_BYTES) {
            failureCode = 'output-too-large';
            killProcessTree(child.pid);
            return;
          }
          chunks.push(chunk);
        };
      }

      const deadline = setTimeout(stopTree, readTimeoutMs);
      child.stdout?.on('data', collect(stdoutChunks));
      child.stderr?.on('data', collect(stderrChunks));
      child.stdin?.on('error', () => undefined);
      child.on('error', (error: NodeJS.ErrnoException) => {
        failureCode = error.code ?? 'spawn-failed';
        if (child.pid === undefined) settle(null);
      });
      child.on('close', (exitCode: number | null) => settle(exitCode));
      child.stdin?.end(stdinText);
    });
  }

  async function runWithConfigFile(configText: string, argumentsFor: (configPath: string) => string[]): Promise<FnoxRunResult> {
    await fs.mkdir(runsRoot, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    const runFolder = await fs.mkdtemp(path.join(runsRoot, 'run-'));
    try {
      await fs.chmod(runFolder, PRIVATE_FOLDER_MODE);
      const configPath = path.join(runFolder, 'fnox.toml');
      const emptyConfigFolder = path.join(runFolder, 'global');
      await fs.writeFile(configPath, configText, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      await fs.mkdir(emptyConfigFolder, { mode: PRIVATE_FOLDER_MODE });
      return await runFnoxProcess({ args: argumentsFor(configPath), cwd: runFolder, env: fnoxEnvironment(environment, emptyConfigFolder), stdinText: '' });
    } finally {
      await fs.rm(runFolder, { recursive: true, force: true });
    }
  }

  function runFnox(configText: string, argumentsFor: (configPath: string) => string[]): Promise<FnoxRunResult> {
    if (isWindows) return runWithConfigFile(configText, argumentsFor);
    return runFnoxProcess({ args: argumentsFor(STDIN_CONFIG_PATH), cwd: path.parse(runsRoot).root, env: fnoxEnvironment(environment, UNCREATABLE_CONFIG_FOLDER), stdinText: configText });
  }

  function read(source: SecretSource, name: SecretName): Promise<ReadOutcome> {
    return queue.run(async () => readOutcomeOf(await runFnox(fnoxConfigText(source, name), (configPath) => fnoxReadArguments(configPath, name)), source, name));
  }

  function test(source: SecretSource): Promise<SecretSourceTestResult> {
    return runFnox(fnoxConfigText(source, null), fnoxTestArguments).then((result) => testOutcomeOf(result, source));
  }

  return { read, test };
}

export { createFnoxRunner };
