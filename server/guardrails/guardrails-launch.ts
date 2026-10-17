import { access, chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawTextOr } from '../../shared/coerce.ts';
import { GuardrailsLaunchOwner } from '../../shared/contracts/guardrails-launch.ts';
import { isPathInside } from '../../shared/paths.ts';
import { errorCode, errorMessage, isMissingFileError } from '../../shared/text.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { listClaudeGlobalConfigPathCandidates } from '../core/claude-trust-core.ts';
import { decideConfigPath } from '../core/config-path-core.ts';
import { bridgeSocketLauncherEnv } from './core/guardrails-bridge-socket-core.ts';
import { buildGuardrailsLaunchPlan, lockedClaudeMountPoints, guardrailsPlaceholderPaths, guardrailsPolicyProbePaths, standardWriteBlockCandidates } from './core/guardrails-policy-core.ts';
import type { GuardrailsHost, GuardrailsHostPaths, GuardrailsLaunchPlan, GuardrailsRole } from './core/guardrails-policy-core.ts';
import { codexHomes, grokHomes, projectDirCandidates } from '../usage/core/usage-scan-core.ts';
import { loadJsonStateFile, writeJsonAtomic } from '../json-file.ts';
import { relayPath, resolvePackageBin } from '../runtime-paths.ts';

interface WrappedCommand {
  file: string;
  args: string[];
}

interface GuardrailsLaunch {
  wrap: (file: string, args: readonly string[], options: { hasTerminal: boolean }) => Promise<WrappedCommand>;
  env: Record<string, string>;
  cwd?: string;
  dispose: () => Promise<void>;
}

interface GuardrailsLaunchRequest {
  role: GuardrailsRole;
  launchId: string;
  tempDir?: string;
  enterDir?: string;
}

type GuardrailsLaunchResult = { ok: true; launch: GuardrailsLaunch } | { ok: false; reason: string };

const LAUNCH_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GUARDED_ENV_COMMAND = '/usr/bin/env';
const POLICY_FOLDER = 'guardrails-policies';
const TEMP_FOLDER = 'guardrails-temp';
const LAUNCH_HOME_FOLDER = 'guardrails-homes';
const START_FOLDER = 'start';
const OWNER_FILE_SUFFIX = '.owner.json';
const ENTER_FOLDER_SCRIPT = 'cd "$1" && shift && exec "$@"';
const LOGIN_FILE_MODE = 0o600;
const ABSENT_PATH_DENY_PLATFORM = 'darwin';
const OWN_PID_NAMESPACE_LINK = '/proc/self/ns/pid';

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

async function symlinkTargetsInside(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const symlinkEntries = entries.filter((entry) => entry.isSymbolicLink());
  const targets = await Promise.all(symlinkEntries.map((entry) => realpath(path.join(folder, entry.name)).catch(() => null)));
  return targets.filter((target): target is string => target !== null);
}

async function blockedPathsWithRealTargets(candidates: readonly string[], operatorBlockedPaths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(candidates.map(async (candidate) => {
    const isPresentEntry = await lstat(candidate).then(() => true, (error: unknown) => !isMissingFileError(error));
    const isKeptWhenAbsent = process.platform === ABSENT_PATH_DENY_PLATFORM || operatorBlockedPaths.includes(candidate);
    if (!isPresentEntry) return isKeptWhenAbsent ? [candidate] : [];
    const realCandidate = await realpath(candidate).catch(() => candidate);
    return [candidate, realCandidate, ...await symlinkTargetsInside(realCandidate)];
  }));
  return [...new Set(resolved.flat())];
}

async function configuredConfigFile(glimmervoidHome: string): Promise<string> {
  const { envPath, homePath } = decideConfigPath({ env: process.env, homeDir: glimmervoidHome }, () => false);
  const configFile = envPath ?? homePath;
  return path.join(await realPathWhenPresent(path.dirname(configFile)), path.basename(configFile));
}

function scannedClaudeHomes(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const envWithoutConfigDirOverride = { ...env, CLAUDE_CONFIG_DIR: undefined };
  return [env, envWithoutConfigDirOverride]
    .flatMap((scannedEnv) => projectDirCandidates(scannedEnv, [], homeDir))
    .map((projectsDir) => path.dirname(projectsDir));
}

async function resolveVendorLocations(env: NodeJS.ProcessEnv, homeDir: string): Promise<GuardrailsHost['vendorLocations'] | null> {
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

async function withRealRoots(role: GuardrailsRole): Promise<GuardrailsRole> {
  const [writableRoots, lockedCheckouts, commitCheckouts] = await Promise.all([
    Promise.all(role.writableRoots.map((root) => realpath(root))),
    Promise.all(role.lockedCheckouts.map((checkout) => realpath(checkout))),
    Promise.all(role.commitCheckouts.map(async ({ checkout, gitDir }) => ({ checkout: await realpath(checkout), gitDir: await realpath(gitDir) }))),
  ]);
  const vendorHome = role.vendorHome.scope === 'launch' ? { ...role.vendorHome, cwd: await realPathWhenPresent(role.vendorHome.cwd) } : role.vendorHome;
  return { ...role, vendorHome, writableRoots, lockedCheckouts, commitCheckouts, readableWithinDenied: await realPathsWhenPresent(role.readableWithinDenied) };
}

async function lstatWhenPresent(candidate: string): Promise<Stats | null> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return null;
  }
}

async function isRegularFile(candidate: string): Promise<boolean> {
  return (await lstatWhenPresent(candidate))?.isFile() ?? false;
}

async function isRealDirectory(candidate: string): Promise<boolean> {
  return (await lstatWhenPresent(candidate))?.isDirectory() ?? false;
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

async function createMissingMountPoints(mountPoints: readonly string[]): Promise<void> {
  for (const mountPoint of mountPoints) {
    if (!await isRealDirectory(path.dirname(mountPoint))) continue;
    await mkdir(mountPoint).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
  }
}

async function isNewerThanTarget(linkPath: string, targetPath: string): Promise<boolean> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (targetStats === null) return true;
  return (await lstat(linkPath)).mtimeMs > targetStats.mtimeMs;
}

async function keepRefreshedLogins(logins: GuardrailsLaunchOwner['logins'], launchId: string, { onlyWhenNewer }: { onlyWhenNewer: boolean }): Promise<void> {
  for (const { linkPath, targetPath } of logins) {
    if (!await isRegularFile(linkPath)) continue;
    if (onlyWhenNewer && !await isNewerThanTarget(linkPath, targetPath)) continue;
    const stagedPath = `${targetPath}.${launchId}`;
    await copyFile(linkPath, stagedPath);
    await chmod(stagedPath, LOGIN_FILE_MODE);
    await rename(stagedPath, targetPath);
  }
}

interface LaunchFolders {
  policyPath: string;
  ownerPath: string;
  launchHomeDir: string;
  ownedTempDir: string | null;
}

async function removeLaunch(folders: LaunchFolders, owner: GuardrailsLaunchOwner, launchId: string, { onlyNewerLogins }: { onlyNewerLogins: boolean }): Promise<void> {
  await rm(folders.policyPath, { force: true });
  await removeLeftoverPlaceholders(owner.placeholderPaths);
  const loginsInLaunchHome = owner.logins.filter((login) => isPathInside(folders.launchHomeDir, login.linkPath, { allowEqual: false }));
  await keepRefreshedLogins(loginsInLaunchHome, launchId, { onlyWhenNewer: onlyNewerLogins });
  await rm(folders.launchHomeDir, { recursive: true, force: true });
  if (folders.ownedTempDir !== null) await rm(folders.ownedTempDir, { recursive: true, force: true });
  await rm(folders.ownerPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function readOwnPidNamespace(): Promise<string | null> {
  return readlink(OWN_PID_NAMESPACE_LINK).catch(() => null);
}

async function readOwnerFile(ownerPath: string): Promise<GuardrailsLaunchOwner | null> {
  const outcome = await loadJsonStateFile({ filePath: ownerPath, quarantine: false, parse: (raw) => GuardrailsLaunchOwner.safeParse(raw).data ?? null });
  return outcome.status === 'loaded' ? outcome.value : null;
}

async function sweepOrphanedGuardrailsLaunches(log: Pick<Console, 'log' | 'warn'> = console): Promise<void> {
  try {
    const policyDir = path.join(glimmervoidHomeDir(), POLICY_FOLDER);
    const entryNames = await readdir(policyDir).catch((error: unknown) => {
      if (isMissingFileError(error)) return [];
      throw error;
    });
    const glimmervoidHome = await realpath(glimmervoidHomeDir());
    const sweeperPidNamespace = await readOwnPidNamespace();
    let removedLaunchCount = 0;
    for (const entryName of entryNames) {
      if (!entryName.endsWith(OWNER_FILE_SUFFIX)) continue;
      const launchId = entryName.slice(0, -OWNER_FILE_SUFFIX.length);
      if (!LAUNCH_ID_SHAPE.test(launchId)) continue;
      const ownerPath = path.join(policyDir, entryName);
      const owner = await readOwnerFile(ownerPath);
      if (owner === null || owner.ownerHost !== os.hostname() || owner.ownerPidNamespace !== sweeperPidNamespace || isProcessAlive(owner.ownerPid)) continue;
      try {
        await removeLaunch({
          policyPath: path.join(policyDir, `${launchId}.json`),
          ownerPath,
          launchHomeDir: path.join(glimmervoidHome, LAUNCH_HOME_FOLDER, launchId),
          ownedTempDir: owner.ownsTempDir ? path.join(glimmervoidHome, TEMP_FOLDER, launchId) : null,
        }, owner, launchId, { onlyNewerLogins: true });
        removedLaunchCount += 1;
      } catch (error) {
        log.warn(`[guardrails] could not remove the leftover launch ${launchId}: ${errorMessage(error)}`);
      }
    }
    if (removedLaunchCount > 0) log.log(`[guardrails] removed ${removedLaunchCount} launch folders left by sessions that ended without a clean shutdown`);
  } catch (error) {
    log.warn(`[guardrails] could not sweep leftover launch folders: ${errorMessage(error)}`);
  }
}

function launcherCommand(plan: GuardrailsLaunchPlan, policyPath: string): WrappedCommand | null {
  if (plan.launcher === 'open-network') return { file: process.execPath, args: [relayPath('guardrails-open-launcher'), policyPath] };
  const runtimeCliPath = resolvePackageBin('@anthropic-ai/sandbox-runtime', 'srt');
  if (!runtimeCliPath) return null;
  return { file: process.execPath, args: [runtimeCliPath, '--settings', policyPath, '--'] };
}

function guardedEnvPrefix(plan: GuardrailsLaunchPlan): string[] {
  const assignments = Object.entries(plan.guardedEnv).map(([name, value]) => `${name}=${value}`);
  return assignments.length === 0 ? [] : [GUARDED_ENV_COMMAND, ...assignments];
}

function enteringFolder(enterDir: string | undefined, file: string, args: readonly string[]): string[] {
  if (enterDir === undefined) return [file, ...args];
  return ['/bin/sh', '-c', ENTER_FOLDER_SCRIPT, 'sh', enterDir, file, ...args];
}

async function prepareGuardrailsLaunch({ role, launchId, tempDir, enterDir }: GuardrailsLaunchRequest): Promise<GuardrailsLaunchResult> {
  if (!LAUNCH_ID_SHAPE.test(launchId)) return { ok: false, reason: 'guardrails launch id is invalid' };
  try {
    const policyDir = path.join(glimmervoidHomeDir(), POLICY_FOLDER);
    await mkdir(policyDir, { recursive: true, mode: 0o700 });
    const [homeDir, glimmervoidHome, realRole, ownerPidNamespace] = await Promise.all([realpath(os.homedir()), realpath(glimmervoidHomeDir()), withRealRoots(role), readOwnPidNamespace()]);
    const ownsTempDir = tempDir === undefined;
    const launchTempDir = tempDir === undefined ? path.join(glimmervoidHome, TEMP_FOLDER, launchId) : path.resolve(tempDir);
    const launchHomeDir = path.join(glimmervoidHome, LAUNCH_HOME_FOLDER, launchId);
    const vendorLocations = await resolveVendorLocations(process.env, homeDir);
    if (vendorLocations === null) return { ok: false, reason: 'CODEX_HOME names no folder' };
    const xdgConfigHomeOverride = rawTextOr(process.env.XDG_CONFIG_HOME, null);
    const stableHostPaths = {
      homeDir,
      glimmervoidHome,
      glimmervoidConfigFile: await configuredConfigFile(glimmervoidHome),
      tempDir: launchTempDir,
      launchHomeDir,
      vendorLocations,
      unwrappedVendorHomes: await realPathsWhenPresent(grokHomes(process.env, homeDir)),
      relocatedXdgConfigHome: xdgConfigHomeOverride === null ? null : await realPathWhenPresent(xdgConfigHomeOverride),
    };
    const buildPlanFromCurrentDisk = async () => {
      const [homeEntryNames, glimmervoidHomeEntryNames] = await Promise.all([readdir(homeDir), readdir(glimmervoidHome)]);
      const hostPaths: GuardrailsHostPaths = { ...stableHostPaths, homeEntryNames, glimmervoidHomeEntryNames };
      const [existingPaths, writeBlockedPaths] = await Promise.all([
        presentPaths(guardrailsPolicyProbePaths(realRole, hostPaths)),
        blockedPathsWithRealTargets(standardWriteBlockCandidates(realRole, hostPaths), realRole.blockedPaths ?? []),
      ]);
      return buildGuardrailsLaunchPlan(realRole, { ...hostPaths, existingPaths, writeBlockedPaths });
    };
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
    const folders: LaunchFolders = {
      policyPath,
      ownerPath: path.join(policyDir, `${launchId}${OWNER_FILE_SUFFIX}`),
      launchHomeDir,
      ownedTempDir: ownsTempDir ? launchTempDir : null,
    };
    const owner: GuardrailsLaunchOwner = {
      ownerPid: process.pid,
      ownerHost: os.hostname(),
      ownerPidNamespace,
      ownsTempDir,
      logins: plan.launchHomeLinks.filter((link) => link.isLogin).map(({ linkPath, targetPath }) => ({ linkPath, targetPath })),
      placeholderPaths: [],
    };
    await writeJsonAtomic(folders.ownerPath, owner);
    const envPrefix = guardedEnvPrefix(plan);
    return {
      ok: true,
      launch: {
        wrap: async (file, args, { hasTerminal }) => {
          const rebuilt = await buildPlanFromCurrentDisk();
          if (!rebuilt.ok) throw new Error(rebuilt.reason);
          await writeJsonAtomic(policyPath, { ...rebuilt.plan.policy, allowPty: hasTerminal && rebuilt.plan.launcher === 'open-network' });
          owner.placeholderPaths = await absentPaths(guardrailsPlaceholderPaths(realRole));
          await writeJsonAtomic(folders.ownerPath, owner);
          await createMissingMountPoints(lockedClaudeMountPoints(realRole));
          return { file: launcher.file, args: [...launcher.args, ...envPrefix, ...enteringFolder(enterDir, file, args)] };
        },
        env: { ...plan.launchEnv, ...bridgeSocketLauncherEnv(os.tmpdir(), process.platform) },
        ...(startDir === undefined ? {} : { cwd: startDir }),
        dispose: () => removeLaunch(folders, owner, launchId, { onlyNewerLogins: false }),
      },
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export { prepareGuardrailsLaunch, sweepOrphanedGuardrailsLaunches };
export type { GuardrailsLaunch, GuardrailsLaunchResult };
