import { access, chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rawTextOr } from '../shared/coerce.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { listClaudeGlobalConfigPathCandidates } from './core/claude-trust-core.ts';
import { buildSandboxLaunchPlan, sandboxPlaceholderPaths, sandboxPolicyProbePaths } from './core/sandbox-policy-core.ts';
import type { SandboxHost, SandboxLaunchPlan, SandboxRole } from './core/sandbox-policy-core.ts';
import { codexHomes, grokHomes, projectDirCandidates } from './core/usage-scan-core.ts';
import { writeJsonAtomic } from './json-file.ts';
import { relayPath, resolvePackageBin } from './runtime-paths.ts';

interface WrappedCommand {
  file: string;
  args: string[];
}

interface SandboxLaunch {
  wrap: (file: string, args: readonly string[]) => Promise<WrappedCommand>;
  env: Record<string, string>;
  cwd?: string;
  dispose: () => Promise<void>;
}

interface SandboxLaunchRequest {
  role: SandboxRole;
  launchId: string;
  tempDir?: string;
  enterDir?: string;
}

type SandboxLaunchResult = { ok: true; launch: SandboxLaunch } | { ok: false; reason: string };

const LAUNCH_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SANDBOXED_ENV_COMMAND = '/usr/bin/env';
const POLICY_FOLDER = 'sandbox-policies';
const TEMP_FOLDER = 'sandbox-temp';
const LAUNCH_HOME_FOLDER = 'sandbox-homes';
const START_FOLDER = 'start';
const ENTER_FOLDER_SCRIPT = 'cd "$1" && shift && exec "$@"';
const LOGIN_FILE_MODE = 0o600;

async function isPresent(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return false;
  }
}

async function presentPaths(candidates: readonly string[]): Promise<Set<string>> {
  const presence = await Promise.all(candidates.map(isPresent));
  return new Set(candidates.filter((_candidate, index) => presence[index]));
}

async function realPathWhenPresent(candidate: string): Promise<string> {
  if (!path.isAbsolute(candidate)) return candidate;
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return candidate;
  }
}

function realPathsWhenPresent(candidates: readonly string[]): Promise<string[]> {
  return Promise.all(candidates.map(realPathWhenPresent));
}

function scannedClaudeHomes(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const envWithoutConfigDirOverride = { ...env, CLAUDE_CONFIG_DIR: undefined };
  return [env, envWithoutConfigDirOverride]
    .flatMap((scannedEnv) => projectDirCandidates(scannedEnv, [], homeDir))
    .map((projectsDir) => path.dirname(projectsDir));
}

async function resolveVendorLocations(env: NodeJS.ProcessEnv, homeDir: string): Promise<SandboxHost['vendorLocations'] | null> {
  const [legacyClaudeConfigPath, claudeConfigPath] = listClaudeGlobalConfigPathCandidates(env, homeDir);
  const [codexStateFolder, ...otherCodexHomes] = codexHomes(env, homeDir);
  if (codexStateFolder === undefined) return null;
  return {
    claude: {
      stateFolder: await realPathWhenPresent(path.dirname(legacyClaudeConfigPath)),
      configFiles: [await realPathWhenPresent(claudeConfigPath)],
      otherHomes: await realPathsWhenPresent(scannedClaudeHomes(env, homeDir)),
    },
    codex: { stateFolder: await realPathWhenPresent(codexStateFolder), configFiles: [], otherHomes: await realPathsWhenPresent(otherCodexHomes) },
  };
}

async function withRealRoots(role: SandboxRole): Promise<SandboxRole> {
  const [writableRoots, lockedCheckouts, commitCheckouts] = await Promise.all([
    Promise.all(role.writableRoots.map((root) => realpath(root))),
    Promise.all(role.lockedCheckouts.map((checkout) => realpath(checkout))),
    Promise.all(role.commitCheckouts.map(async ({ checkout, gitDir }) => ({ checkout: await realpath(checkout), gitDir: await realpath(gitDir) }))),
  ]);
  const vendorHome = role.vendorHome.scope === 'launch' ? { ...role.vendorHome, cwd: await realPathWhenPresent(role.vendorHome.cwd) } : role.vendorHome;
  return { ...role, vendorHome, writableRoots, lockedCheckouts, commitCheckouts, readableWithinDenied: await realPathsWhenPresent(role.readableWithinDenied) };
}

async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isFile();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return false;
  }
}

async function absentPaths(candidates: readonly string[]): Promise<string[]> {
  const presentCandidates = await presentPaths(candidates);
  return candidates.filter((candidate) => !presentCandidates.has(candidate));
}

async function removeLeftoverPlaceholders(placeholderPaths: readonly string[]): Promise<void> {
  for (const placeholderPath of placeholderPaths) {
    const placeholderStats = await lstat(placeholderPath).catch(() => null);
    if (placeholderStats?.isFile() && placeholderStats.size === 0) await rm(placeholderPath, { force: true });
  }
}

async function keepRefreshedLogins(links: SandboxLaunchPlan['launchHomeLinks'], launchId: string): Promise<void> {
  for (const { linkPath, targetPath } of links.filter((link) => link.isLogin)) {
    if (!await isRegularFile(linkPath)) continue;
    const stagedPath = `${targetPath}.${launchId}`;
    await copyFile(linkPath, stagedPath);
    await chmod(stagedPath, LOGIN_FILE_MODE);
    await rename(stagedPath, targetPath);
  }
}

function launcherCommand(plan: SandboxLaunchPlan, policyPath: string): WrappedCommand | null {
  if (plan.launcher === 'open-network') return { file: process.execPath, args: [relayPath('sandbox-open-launcher'), policyPath] };
  const runtimeCliPath = resolvePackageBin('@anthropic-ai/sandbox-runtime', 'srt');
  if (!runtimeCliPath) return null;
  return { file: process.execPath, args: [runtimeCliPath, '--settings', policyPath, '--'] };
}

function sandboxedEnvPrefix(plan: SandboxLaunchPlan): string[] {
  const assignments = Object.entries(plan.sandboxedEnv).map(([name, value]) => `${name}=${value}`);
  return assignments.length === 0 ? [] : [SANDBOXED_ENV_COMMAND, ...assignments];
}

function enteringFolder(enterDir: string | undefined, file: string, args: readonly string[]): string[] {
  if (enterDir === undefined) return [file, ...args];
  return ['/bin/sh', '-c', ENTER_FOLDER_SCRIPT, 'sh', enterDir, file, ...args];
}

async function prepareSandboxLaunch({ role, launchId, tempDir, enterDir }: SandboxLaunchRequest): Promise<SandboxLaunchResult> {
  if (!LAUNCH_ID_SHAPE.test(launchId)) return { ok: false, reason: 'sandbox launch id is invalid' };
  try {
    const policyDir = path.join(glimmervoidHomeDir(), POLICY_FOLDER);
    await mkdir(policyDir, { recursive: true, mode: 0o700 });
    const [homeDir, glimmervoidHome, realRole] = await Promise.all([realpath(os.homedir()), realpath(glimmervoidHomeDir()), withRealRoots(role)]);
    const ownsTempDir = tempDir === undefined;
    const launchTempDir = tempDir === undefined ? path.join(glimmervoidHome, TEMP_FOLDER, launchId) : path.resolve(tempDir);
    const launchHomeDir = path.join(glimmervoidHome, LAUNCH_HOME_FOLDER, launchId);
    const vendorLocations = await resolveVendorLocations(process.env, homeDir);
    if (vendorLocations === null) return { ok: false, reason: 'CODEX_HOME names no folder' };
    const xdgConfigHomeOverride = rawTextOr(process.env.XDG_CONFIG_HOME, null);
    const hostPaths = {
      homeDir,
      glimmervoidHome,
      tempDir: launchTempDir,
      launchHomeDir,
      homeEntryNames: await readdir(homeDir),
      vendorLocations,
      unwrappedVendorHomes: await realPathsWhenPresent(grokHomes(process.env, homeDir)),
      relocatedXdgConfigHome: xdgConfigHomeOverride === null ? null : await realPathWhenPresent(xdgConfigHomeOverride),
    };
    const buildPlanFromCurrentDisk = async () => buildSandboxLaunchPlan(realRole, { ...hostPaths, existingPaths: await presentPaths(sandboxPolicyProbePaths(realRole, hostPaths)) });
    const built = await buildPlanFromCurrentDisk();
    if (!built.ok) return built;
    const { plan } = built;
    const policyPath = path.join(policyDir, `${launchId}.json`);
    const launcher = launcherCommand(plan, policyPath);
    if (!launcher) return { ok: false, reason: 'the sandbox runtime CLI could not be resolved' };
    await Promise.all(plan.requiredDirectories.map((directory) => mkdir(directory, { recursive: true })));
    const startDir = enterDir === undefined ? undefined : path.join(launchTempDir, START_FOLDER);
    if (startDir !== undefined) await mkdir(startDir, { recursive: true });
    await Promise.all(plan.launchHomeLinks.map((link) => symlink(link.targetPath, link.linkPath)));
    await writeJsonAtomic(policyPath, plan.policy);
    const envPrefix = sandboxedEnvPrefix(plan);
    let placeholderPathsAbsentAtWrap: string[] = [];
    return {
      ok: true,
      launch: {
        wrap: async (file, args) => {
          const rebuilt = await buildPlanFromCurrentDisk();
          if (!rebuilt.ok) throw new Error(rebuilt.reason);
          await writeJsonAtomic(policyPath, rebuilt.plan.policy);
          placeholderPathsAbsentAtWrap = await absentPaths(sandboxPlaceholderPaths(realRole));
          return { file: launcher.file, args: [...launcher.args, ...envPrefix, ...enteringFolder(enterDir, file, args)] };
        },
        env: { ...plan.launchEnv },
        ...(startDir === undefined ? {} : { cwd: startDir }),
        dispose: async () => {
          await rm(policyPath, { force: true });
          await removeLeftoverPlaceholders(placeholderPathsAbsentAtWrap);
          await keepRefreshedLogins(plan.launchHomeLinks, launchId);
          await rm(launchHomeDir, { recursive: true, force: true });
          if (ownsTempDir) await rm(launchTempDir, { recursive: true, force: true });
        },
      },
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export { prepareSandboxLaunch };
export type { SandboxLaunch, SandboxLaunchResult };
