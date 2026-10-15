import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from '../child-process-safe.ts';
import { prepareSandboxLaunch } from '../sandbox/sandbox-launch.ts';
import type { GitWorkspaceInstance } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { buildFactoryCheckEnv, listFailingTestFiles, listFailingTestFilesOutsideScopes, parseCheckCommand, redactSecretLines, summarizeFailedCheckOutput } from './core/factory-core.ts';
import type { FactoryCheck } from './core/factory-core.ts';
import { capFactoryDecisionOutput, envFileSecretValues } from './core/factory-decision-log-core.ts';

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
    const wrapped = await launch.wrap(checkCommand, checkArgs, { hasTerminal: false });
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
export type { PrepareFactoryCheckRunner };

export type FactoryCheckoutRun = {
  confirmedFlakes: string[]; checks: FactoryCheck[]; loggedChecks: FactoryCheck[]; decisionReasonChecks: FactoryCheck[]; checkoutSecretValues: string[];
  failingFilesOutsideScopesByCommand: Map<string, string[]>; failureTextByCommand: Map<string, string>; outputPathsByCommand: Map<string, string>; checkoutPaths: string[];
};

export function factoryFailureText(error: unknown, maxChars = 4000): string {
  if (!(error instanceof Error)) return String(error).slice(-maxChars);
  const output = ['stdout', 'stderr'].flatMap((key) => {
    const value = Reflect.get(error, key);
    const causeValue: unknown = error.cause instanceof Error ? Reflect.get(error.cause, key) : undefined;
    if (typeof causeValue === 'string' && (typeof value !== 'string' || causeValue.length > value.length)) return [causeValue];
    return typeof value === 'string' ? [value] : [];
  }).join('\n');
  return `${error.message}\n${output}`.slice(-maxChars);
}

const FORCED_TEST_REPORTER_NODE_OPTIONS = '--test-reporter=tap';

function isTestReporterConflict(error: unknown): boolean {
  const text = factoryFailureText(error, 16 * 1024 * 1024);
  const isReporterArgumentConflict = text.includes('ERR_INVALID_ARG_VALUE') && text.includes("'--test-reporter'");
  const isNodeOptionsRefusal = text.includes('--test-reporter') && text.includes('is not allowed in NODE_OPTIONS');
  return isReporterArgumentConflict || isNodeOptionsRefusal;
}

function withForcedTapReporter(runCheck: FactoryCheckRunner): FactoryCheckRunner {
  return async (argv, options) => {
    try {
      return await runCheck(argv, { ...options, env: { ...options.env, NODE_OPTIONS: FORCED_TEST_REPORTER_NODE_OPTIONS } });
    } catch (error) {
      if (!isTestReporterConflict(error)) throw error;
      return runCheck(argv, options);
    }
  };
}

interface FactoryCheckoutRunOptions {
  projectPath: string;
  sha: string;
  commands: readonly string[];
  writeScopes: readonly string[];
  sharedEntries: string[];
  gitWorkspace: Pick<GitWorkspaceInstance, 'stageDetachedWorktree' | 'populate' | 'removeWorktreeByPath' | 'pruneWorktrees'>;
  baseEnv: NodeJS.ProcessEnv;
  secretValues: readonly (string | undefined)[];
  signal: AbortSignal;
  isLive?: () => boolean;
  prepareCheckRunner?: PrepareFactoryCheckRunner;
  rerunFailedChecks?: boolean;
  writeFailedCheckOutputFile?: (outputText: string) => Promise<string | null>;
}

async function readCheckoutSecretValues(checkoutPath: string, sharedEntries: readonly string[]): Promise<string[]> {
  const sharedEnvFiles = sharedEntries.filter((sharedEntry) => !sharedEntry.includes('..') && path.basename(sharedEntry).startsWith('.env'));
  const envFileTexts = await Promise.all(sharedEnvFiles.map(async (sharedEnvFile) => {
    try {
      const envFilePath = path.join(checkoutPath, sharedEnvFile);
      return (await lstat(envFilePath)).isFile() ? await readFile(envFilePath, 'utf8') : '';
    } catch {
      return '';
    }
  }));
  return envFileTexts.flatMap(envFileSecretValues);
}

export async function runChecksInCleanCheckout({
  projectPath, sha, commands, writeScopes, sharedEntries, gitWorkspace, baseEnv, secretValues, signal,
  isLive = () => true, prepareCheckRunner = prepareSandboxedCheckRunner, rerunFailedChecks = false,
  writeFailedCheckOutputFile = async () => null,
}: FactoryCheckoutRunOptions): Promise<FactoryCheckoutRun | null> {
  const checkoutParent = await makeHostScratchDirectory('check-');
  const checkoutPath = path.join(checkoutParent, 'checkout');
  const env = buildFactoryCheckEnv(baseEnv, process.platform);
  const isolation = { disableHooks: true, disableRepoCommands: true, replaceEnv: env };
  let checkSandbox: FactoryCheckSandbox | null = null;
  try {
    const staged = await gitWorkspace.stageDetachedWorktree({ projectPath, worktreePath: checkoutPath, sha, ...isolation });
    if (!staged.ok) throw new Error(`Could not stage the factory check checkout: ${staged.err}`);
    await gitWorkspace.populate({ projectPath, wtDir: checkoutPath, shareList: sharedEntries, ...isolation });
    checkSandbox = await prepareCheckRunner({ scratchParent: checkoutParent, writablePaths: [checkoutPath] });
    const runCheck = withForcedTapReporter(checkSandbox.runCheck);
    const checkoutSecretValues = await readCheckoutSecretValues(checkoutPath, sharedEntries);
    const checks: FactoryCheck[] = [];
    const loggedChecks: FactoryCheck[] = [];
    const decisionReasonChecks: FactoryCheck[] = [];
    const confirmedFlakes = new Set<string>();
    const failingFilesOutsideScopesByCommand = new Map<string, string[]>();
    const failureTextByCommand = new Map<string, string>();
    const outputPathsByCommand = new Map<string, string>();
    const checkoutPaths = [...new Set([checkoutPath, await realpath(checkoutPath)])];
    const loggedText = (capturedText: string) => redactSecretLines(capturedText, [...secretValues, ...checkoutSecretValues]);
    const captureCheck = async (argv: string[]) => {
      try {
        const output = await runCheck(argv, { cwd: checkoutPath, env, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, signal });
        return { pass: true, output: `${output.stdout}\n${output.stderr}` };
      } catch (error) {
        return { pass: false, output: factoryFailureText(error, Infinity) };
      }
    };
    for (const command of commands) {
      if (!isLive() || signal.aborted) return null;
      const argv = parseCheckCommand(command);
      if (!argv) {
        const refusedCheck = { command, pass: false, output: 'Check command contains shell syntax or is empty' };
        checks.push(refusedCheck);
        loggedChecks.push(refusedCheck);
        decisionReasonChecks.push(refusedCheck);
        continue;
      }
      let capturedCheck = await captureCheck(argv);
      if (!isLive() || signal.aborted) return null;
      if (!capturedCheck.pass && rerunFailedChecks) {
        const failingTestFiles = listFailingTestFiles({ output: capturedCheck.output, checkoutPaths });
        capturedCheck = await captureCheck(argv);
        if (!isLive() || signal.aborted) return null;
        if (capturedCheck.pass) {
          for (const flake of failingTestFiles.length > 0 ? failingTestFiles : [command]) confirmedFlakes.add(flake);
        }
      }
      if (capturedCheck.pass) {
        checks.push({ command, pass: true, output: redactSecretLines(capturedCheck.output, secretValues).slice(-4000) });
        const loggedCheck = { command, pass: true, output: capFactoryDecisionOutput(loggedText(capturedCheck.output)) };
        loggedChecks.push(loggedCheck);
        decisionReasonChecks.push(loggedCheck);
        continue;
      }
      const fullFailureText = capturedCheck.output;
      failureTextByCommand.set(command, fullFailureText);
      failingFilesOutsideScopesByCommand.set(command, listFailingTestFilesOutsideScopes({ output: fullFailureText, checkoutPaths, writeScopes }));
      const loggedFailureText = loggedText(fullFailureText);
      const outputPath = await writeFailedCheckOutputFile(loggedFailureText).catch(() => null);
      if (outputPath !== null) outputPathsByCommand.set(command, outputPath);
      const feedbackOutput = summarizeFailedCheckOutput(loggedFailureText, 3500, { checkoutPaths, writeScopes });
      checks.push({ command, pass: false, output: feedbackOutput });
      loggedChecks.push({ command, pass: false, output: capFactoryDecisionOutput(loggedFailureText) });
      decisionReasonChecks.push({ command, pass: false, output: feedbackOutput });
    }
    return { checks, loggedChecks, decisionReasonChecks, confirmedFlakes: [...confirmedFlakes], checkoutSecretValues, failingFilesOutsideScopesByCommand, failureTextByCommand, outputPathsByCommand, checkoutPaths };
  } finally {
    try {
      const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkoutPath, ...isolation });
      if (!removed.ok) {
        await rm(checkoutPath, { recursive: true, force: true });
        await gitWorkspace.pruneWorktrees({ projectPath, ...isolation });
      }
      await rm(checkoutParent, { recursive: true, force: true });
    } finally {
      await checkSandbox?.dispose();
    }
  }
}
