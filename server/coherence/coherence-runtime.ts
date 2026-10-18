import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isMissingFileError } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { COHERENCE_CONFIG_FILENAME } from './core/coherence-config-core.ts';
import { buildCoherenceShims, COHERENCE_NATIVE_CONTROL_FILES } from './core/coherence-session-core.ts';
import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { writeTextAtomic } from '../json-file.ts';
import { cliPath as glimmervoidCliPath, resolvePackageBin } from '../runtime-paths.ts';

const COHERENCE_CONFIG_PROBE_TIMEOUT_MS = 5_000;

export function createCoherenceRuntime() {
  const cliPath = resolvePackageBin('@danilocampos/coherence', 'coherence');
  const hookCliPath = resolvePackageBin('@danilocampos/coherence', 'coherence-hook');

  async function run({ cwd, args, env, timeoutMs = 30_000 }: {
    cwd: string; args: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  }): Promise<string> {
    if (!cliPath) throw new Error('Could not resolve the coherence CLI');
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  async function ensureShims(binDir: string): Promise<void> {
    if (!cliPath) throw new Error('Could not resolve the coherence CLI');
    const shims = buildCoherenceShims({ nodePath: process.execPath, cliPath, glimmervoidCliPath });
    await mkdir(binDir, { recursive: true });
    for (const shim of shims) {
      const shimPath = path.join(binDir, shim.fileName);
      const existingText = await readFile(shimPath, 'utf8').catch((error: unknown) => {
        if (isMissingFileError(error, { includeNotDir: false })) return null;
        throw error;
      });
      if (existingText !== shim.text) await writeTextAtomic(shimPath, shim.text, { mode: shim.mode });
      if (!shim.fileName.endsWith('.cmd')) await chmod(shimPath, shim.mode);
    }
  }

  async function hasPathAt(projectPath: string, sha: string, relativePath: string): Promise<boolean> {
    try {
      await runHardenedGit(['cat-file', '-e', `${sha}:${relativePath}`], {
        cwd: projectPath, encoding: 'utf8', timeout: COHERENCE_CONFIG_PROBE_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (isCompletedCommandFailure(error)) return false;
      throw error;
    }
  }

  async function hasNativeControlAt(projectPath: string, sha: string): Promise<boolean> {
    for (const relativePath of [COHERENCE_CONFIG_FILENAME, ...COHERENCE_NATIVE_CONTROL_FILES.claude]) {
      if (!await hasPathAt(projectPath, sha, relativePath)) return false;
    }
    return true;
  }

  async function hasConfigInWorkingTree(directory: string): Promise<boolean> {
    try {
      return (await stat(path.join(directory, 'coherence.config.json'))).isFile();
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  return { cliPath, hookCliPath, run, ensureShims, hasNativeControlAt, hasConfigInWorkingTree };
}
