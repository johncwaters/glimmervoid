import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CoherenceHooksState } from '../../shared/contracts/session.ts';
import { errorCode, errorMessage, isMissingFileError } from '../../shared/text.ts';
import {
  buildCoherenceTargetShims, COHERENCE_HOOKS_INACTIVE, COHERENCE_NATIVE_CONTROL_FILES, COHERENCE_TARGET_BIN_NAMES, COHERENCE_TARGET_SCRIPTS,
  coherenceHooksStateFromCheck, planCoherenceTargetShims,
} from '../core/coherence-session-core.ts';
import type { CoherenceHost, CoherenceTargetBinName } from '../core/coherence-session-core.ts';
import { COHERENCE_CONFIG_FILENAME } from '../core/coherence-config-core.ts';
import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import { factoryGitEnvironment, runHardenedGit } from '../git/git-workspace.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';

const GIT_PROBE_TIMEOUT_MS = 10_000;
const HOOKS_CHECK_TIMEOUT_MS = 20_000;
const COHERENCE_PACKAGE_DIRECTORY = path.join('node_modules', '@danilocampos', 'coherence');
const TARGET_BIN_DIRECTORY = path.join('node_modules', '.bin');

type CoherenceHooksRequest = { root: string; host: CoherenceHost; canWriteShims: boolean };

type CoherenceRuntime = Pick<ReturnType<typeof createCoherenceRuntime>, 'cliPath' | 'hookCliPath' | 'run'>;

async function isRegularFileNoFollow(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function isPathIgnored(root: string, relativePath: string): Promise<boolean> {
  try {
    await runHardenedGit(['check-ignore', '-q', '--', relativePath.split(path.sep).join('/')], { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function readMainCheckout(root: string): Promise<string | null> {
  try {
    const { stdout } = await runHardenedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS });
    const commonGitDir = stdout.trim();
    return path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : null;
  } catch {
    return null;
  }
}

async function realRegularFile(filePath: string): Promise<string | null> {
  try {
    const resolvedPath = await realpath(filePath);
    return (await stat(resolvedPath)).isFile() ? resolvedPath : null;
  } catch {
    return null;
  }
}

async function readInstalledScripts(mainCheckout: string): Promise<Record<CoherenceTargetBinName, string> | null> {
  const hookScript = await realRegularFile(path.join(mainCheckout, COHERENCE_PACKAGE_DIRECTORY, COHERENCE_TARGET_SCRIPTS['coherence-hook']));
  const cliScript = await realRegularFile(path.join(mainCheckout, COHERENCE_PACKAGE_DIRECTORY, COHERENCE_TARGET_SCRIPTS.coherence));
  return hookScript && cliScript ? { 'coherence-hook': hookScript, coherence: cliScript } : null;
}

async function isInstalledBinEntry(binDirectory: string, binName: CoherenceTargetBinName, platform: NodeJS.Platform): Promise<boolean> {
  const entryPath = path.join(binDirectory, binName);
  const entry = await lstat(entryPath).catch(() => null);
  if (!entry) return false;
  if (entry.isFile()) return platform === 'win32' || (entry.mode & 0o111) !== 0;
  if (!entry.isSymbolicLink()) return false;
  const targetPath = await realRegularFile(entryPath);
  if (!targetPath) return false;
  const pathFromNodeModules = path.relative(path.dirname(binDirectory), targetPath);
  return !pathFromNodeModules.startsWith('..') && !path.isAbsolute(pathFromNodeModules);
}

async function hasCoherenceInSharedBin(root: string, platform: NodeJS.Platform): Promise<boolean> {
  const sharedBinDirectory = await realpath(path.join(root, TARGET_BIN_DIRECTORY)).catch(() => null);
  if (!sharedBinDirectory) return false;
  for (const binName of COHERENCE_TARGET_BIN_NAMES) {
    if (!await isInstalledBinEntry(sharedBinDirectory, binName, platform)) return false;
  }
  return true;
}

async function ensureRealDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await mkdir(directory).catch((error: unknown) => {
    if (errorCode(error) !== 'EEXIST') throw error;
  });
  return (await lstat(directory)).isDirectory();
}

async function writeNewFile(filePath: string, text: string, mode: number): Promise<void> {
  const handle = await open(filePath, 'wx', mode).catch((error: unknown) => {
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

function scrubbedCheckEnv(gitEnvironment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(gitEnvironment).filter(([key]) => !key.startsWith('COHERENCE_') && key !== 'CODEX_THREAD_ID'));
}

export function createCoherenceNativeHooks({ runtime = createCoherenceRuntime(), nodePath = process.execPath, platform = process.platform, log = console }: {
  runtime?: CoherenceRuntime; nodePath?: string; platform?: NodeJS.Platform; log?: Pick<Console, 'warn'>;
} = {}) {
  async function chooseScripts(root: string): Promise<Record<CoherenceTargetBinName, string> | null> {
    const mainCheckout = await readMainCheckout(root);
    const installedScripts = mainCheckout ? await readInstalledScripts(mainCheckout) : null;
    if (installedScripts) return installedScripts;
    return runtime.hookCliPath && runtime.cliPath ? { 'coherence-hook': runtime.hookCliPath, coherence: runtime.cliPath } : null;
  }

  async function writeTargetShims(root: string, binNames: readonly CoherenceTargetBinName[]): Promise<void> {
    if (binNames.length === 0) return;
    const scriptPathByBinName = await chooseScripts(root);
    if (!scriptPathByBinName) return;
    const shims = buildCoherenceTargetShims({ nodePath, scriptPathByBinName, binNames, platform });
    if (!await ensureRealDirectory(path.join(root, 'node_modules'))) return;
    const binDirectory = path.join(root, TARGET_BIN_DIRECTORY);
    if (!await ensureRealDirectory(binDirectory)) return;
    for (const shim of shims) await writeNewFile(path.join(binDirectory, shim.fileName), shim.text, shim.mode);
  }

  async function runHooksCheck(root: string, host: CoherenceHost): Promise<CoherenceHooksState> {
    try {
      await runtime.run({ cwd: root, args: ['hooks', '--check', '--host', host], env: scrubbedCheckEnv(await factoryGitEnvironment(root)), timeoutMs: HOOKS_CHECK_TIMEOUT_MS });
      return coherenceHooksStateFromCheck(0);
    } catch (error) {
      return coherenceHooksStateFromCheck(isCompletedCommandFailure(error) ? error.code : null);
    }
  }

  async function prepare({ root, host, canWriteShims }: CoherenceHooksRequest): Promise<CoherenceHooksState> {
    if (!await isRegularFileNoFollow(path.join(root, COHERENCE_CONFIG_FILENAME))) return { active: false, reason: COHERENCE_HOOKS_INACTIVE.configMissing };
    for (const controlFile of COHERENCE_NATIVE_CONTROL_FILES[host]) {
      if (!await isRegularFileNoFollow(path.join(root, controlFile))) return { active: false, reason: COHERENCE_HOOKS_INACTIVE.controlFilesMissing };
    }
    if (!canWriteShims) return runHooksCheck(root, host);
    const isNodeModulesShared = await isSymbolicLink(path.join(root, 'node_modules')) || await isSymbolicLink(path.join(root, TARGET_BIN_DIRECTORY));
    if (isNodeModulesShared) {
      if (!await hasCoherenceInSharedBin(root, platform)) return { active: false, reason: COHERENCE_HOOKS_INACTIVE.sharedNodeModulesMissingCoherence };
      return runHooksCheck(root, host);
    }
    const targets: { binName: CoherenceTargetBinName; exists: boolean; isIgnored: boolean }[] = [];
    for (const binName of COHERENCE_TARGET_BIN_NAMES) {
      const relativePath = path.join(TARGET_BIN_DIRECTORY, binName);
      const exists = await pathEntryExists(path.join(root, relativePath));
      targets.push({ binName, exists, isIgnored: !exists && await isPathIgnored(root, relativePath) });
    }
    const plan = planCoherenceTargetShims(targets);
    if (!plan.ok) return plan.state;
    await writeTargetShims(root, plan.binNamesToWrite).catch((error: unknown) => {
      log.warn(`[coherence] could not write the hook target shims in ${root}: ${errorMessage(error)}`);
    });
    return runHooksCheck(root, host);
  }

  async function prepareSafely(request: CoherenceHooksRequest): Promise<CoherenceHooksState> {
    try {
      return await prepare(request);
    } catch (error) {
      log.warn(`[coherence] could not prepare the native hooks in ${request.root}: ${errorMessage(error)}`);
      return coherenceHooksStateFromCheck(null);
    }
  }

  return { prepare: prepareSafely };
}

export type CoherenceNativeHooks = ReturnType<typeof createCoherenceNativeHooks>;
