import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { runCommand, runGit } from './git-exec.ts';
import type { CommandResult } from './git-exec.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import {
  CLONED_CACHE_DIRS,
  coherenceSeedArgs,
  coherenceSeedVersion,
  INSTALL_TIMEOUT_MS,
  mentionsNodeModulesBeyondCoherence,
  KNOWN_LOCKFILES,
  installEnvFrom,
  isLinkInsideCheckout,
  lastOutputLineOf,
  LOCKFILE_BY_KIND,
  packageDirsFromTrackedFiles,
  planDependencyClone,
  planDependencyInstall,
  planInstallScriptCopies,
  skipDependencyClone,
  stagingPathFor,
} from './core/dependency-clone-core.ts';
import type {
  DependencyCloneSkip,
  DependencyInstallOutcome,
  DependencyLock,
  InstallResult,
  LockKind,
  NestedPackageDir,
  PackageDirFacts,
  PlannedInstall,
} from './core/dependency-clone-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const NODE_MODULES = 'node_modules';
const COHERENCE_CONFIG_FILE = 'coherence.config.json';
const COHERENCE_SEED_TIMEOUT_MS = 2 * 60_000;
const COHERENCE_SEED_MARKER = '.glimmervoid-coherence-seed';
const COHERENCE_SEED_STAGING_KEY = '@coherence-seed';
const STAGED_ROOT_INSTALL_KEY = '@staged-root-install';
const STAGED_INSTALL_FILES: readonly string[] = ['package.json', 'package-lock.json', '.npmrc'];
const LINK_LIST_MAX_BYTES = 64 * 1024 * 1024;
const INSTALL_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

type DependencyCloneOutcome = DependencyCloneSkip | { action: 'cloned'; dirs: string[]; skippedDirs: string[]; elapsedMs: number };
export type DependencySeedOutcome = { clone: DependencyCloneOutcome; install: DependencyInstallOutcome };
type DependencySeedRun = { blocksSpawn: Promise<boolean>; completion: Promise<DependencySeedOutcome | null> };
type SeedRequest = { mainCheckout: string; worktreeDir: string; signal: AbortSignal };
export type SeedDependencies = (request: SeedRequest) => DependencySeedRun;

const seedQueue = createSerialQueue();

export function seedWorktreeDependencies({ mainCheckout, worktreeDir, signal, hookConfigRelPaths }: SeedRequest & { hookConfigRelPaths: readonly string[] }): DependencySeedRun {
  const rootSeeding = seedCoherence(mainCheckout, worktreeDir, signal).catch(() => false);
  const completion = rootSeeding
    .then((isRootSeeded) => seedQueue.run(() => seedInQueue(mainCheckout, worktreeDir, signal, isRootSeeded), { signal }))
    .catch(() => null);
  const blocksSpawn = rootSeeding.then((isRootSeeded) =>
    isRootSeeded ? hookConfigsNeedUnseededPackages(worktreeDir, hookConfigRelPaths) : hookConfigsNeedNodeModules(worktreeDir, hookConfigRelPaths),
  );
  return { blocksSpawn, completion };
}

async function seedInQueue(mainCheckout: string, worktreeDir: string, signal: AbortSignal, isRootSeeded: boolean): Promise<DependencySeedOutcome | null> {
  const clone = await cloneDependencies(mainCheckout, worktreeDir).catch(() => skipDependencyClone('failed'));
  if (signal.aborted) return null;
  const install = await installDependencies(mainCheckout, worktreeDir, signal, isRootSeeded).catch((error: unknown) => unreadableInstallOutcome(error));
  if (signal.aborted) return null;
  const skippedDirs = clone.action === 'cloned' ? clone.skippedDirs : [];
  const reportedDirs = new Set([...install.unsupportedDirs, ...install.results.map((result) => result.dir)]);
  const emptyDirs = await dirsWithoutNodeModules(worktreeDir, skippedDirs.filter((dir) => !reportedDirs.has(dir)));
  return { clone, install: { ...install, unsupportedDirs: [...install.unsupportedDirs, ...emptyDirs] } };
}

async function seedCoherence(mainCheckout: string, worktreeDir: string, signal: AbortSignal): Promise<boolean> {
  if (process.platform === 'win32' || signal.aborted) return false;
  const [hasCoherenceConfig, hasRootNodeModules, isSeedLeftover, isMainCheckoutInstalled, npmLockText, rootPackageJsonText] = await Promise.all([
    pathExists(path.join(worktreeDir, COHERENCE_CONFIG_FILE)),
    pathExists(path.join(worktreeDir, NODE_MODULES)),
    pathExists(path.join(worktreeDir, NODE_MODULES, COHERENCE_SEED_MARKER)),
    pathExists(path.join(mainCheckout, NODE_MODULES)),
    readTextOrNull(path.join(worktreeDir, LOCKFILE_BY_KIND.npm.lockfile)),
    readTextOrNull(path.join(worktreeDir, 'package.json')),
  ]);
  if (!hasCoherenceConfig) return false;
  if (hasRootNodeModules) return isSeedLeftover;
  if (process.platform === 'darwin' && isMainCheckoutInstalled) return false;
  const version = coherenceSeedVersion(npmLockText, rootPackageJsonText);
  if (!version) return false;
  const stagingDir = stagingPathFor(worktreeDir, COHERENCE_SEED_STAGING_KEY);
  try {
    await prepareStagingDir(stagingDir);
    await fsp.writeFile(path.join(stagingDir, 'package.json'), '{"private":true}\n');
    await copyIfPresent(path.join(worktreeDir, '.npmrc'), path.join(stagingDir, '.npmrc'));
    const seeded = await runCommand('npm', coherenceSeedArgs(version), {
      cwd: stagingDir,
      timeoutMs: COHERENCE_SEED_TIMEOUT_MS,
      maxBuffer: INSTALL_OUTPUT_MAX_BYTES,
      replaceEnv: installEnvFrom(process.env),
      signal,
    });
    if (!seeded.ok || signal.aborted) return false;
    await fsp.writeFile(path.join(stagingDir, NODE_MODULES, COHERENCE_SEED_MARKER), '');
    return await renamed(path.join(stagingDir, NODE_MODULES), path.join(worktreeDir, NODE_MODULES));
  } finally {
    await removeTree(stagingDir);
  }
}

async function hookConfigsNeedNodeModules(worktreeDir: string, hookConfigRelPaths: readonly string[]): Promise<boolean> {
  if (await pathExists(path.join(worktreeDir, COHERENCE_CONFIG_FILE))) return true;
  const hookConfigTexts = await Promise.all(hookConfigRelPaths.map((relPath) => readTextOrNull(path.join(worktreeDir, relPath))));
  return hookConfigTexts.some((configText) => configText?.includes('node_modules') === true);
}

async function hookConfigsNeedUnseededPackages(worktreeDir: string, hookConfigRelPaths: readonly string[]): Promise<boolean> {
  const hookConfigTexts = await Promise.all(hookConfigRelPaths.map((relPath) => readTextOrNull(path.join(worktreeDir, relPath))));
  return hookConfigTexts.some((configText) => configText !== null && mentionsNodeModulesBeyondCoherence(configText));
}

async function installDependencies(mainCheckout: string, worktreeDir: string, signal: AbortSignal, isRootSeeded: boolean): Promise<DependencyInstallOutcome> {
  const startedAt = performance.now();
  const packageDirFacts = (await listPackageDirFacts(worktreeDir)).map((facts) => (isRootSeeded && facts.dir === '.' ? { ...facts, hasNodeModules: false } : facts));
  const plan = planDependencyInstall(process.platform, packageDirFacts);
  const results: InstallResult[] = [];
  for (const install of plan.installs) {
    if (signal.aborted) break;
    const isStagedRootInstall = isRootSeeded && install.dir === '.' && install.command === 'npm';
    const mainPackageDir = path.join(mainCheckout, install.dir);
    results.push(await (isStagedRootInstall ? runStagedRootInstall(mainPackageDir, worktreeDir, install, signal) : runInstall(mainPackageDir, worktreeDir, install, signal)));
  }
  return { results, unsupportedDirs: plan.unsupportedDirs, elapsedMs: Math.round(performance.now() - startedAt) };
}

async function listTrackedPackageDirs(worktreeDir: string): Promise<string[]> {
  const tracked = await runGit(['ls-files', '-z', '--', 'package.json', '**/package.json'], { cwd: worktreeDir, trim: false });
  if (!tracked.ok) return [];
  return packageDirsFromTrackedFiles(tracked.out.split('\0').filter(Boolean));
}

async function listPackageDirFacts(worktreeDir: string): Promise<PackageDirFacts[]> {
  const packageDirs: PackageDirFacts[] = [];
  for (const relativeDir of await listTrackedPackageDirs(worktreeDir)) {
    const packageDir = path.join(worktreeDir, relativeDir);
    const lockfiles: string[] = [];
    for (const lockfile of KNOWN_LOCKFILES) {
      if (await pathExists(path.join(packageDir, lockfile))) lockfiles.push(lockfile);
    }
    packageDirs.push({ dir: relativeDir, hasNodeModules: await pathExists(path.join(packageDir, NODE_MODULES)), lockfiles });
  }
  return packageDirs;
}

async function runInstall(mainPackageDir: string, worktreeDir: string, install: PlannedInstall, signal: AbortSignal): Promise<InstallResult> {
  const packageDir = path.join(worktreeDir, install.dir);
  const run = await runInstallCommand(packageDir, install, signal);
  if (run.ok) return installSucceeded(install, await copyInstallScriptPackages(install, mainPackageDir, packageDir));
  await removeTree(path.join(packageDir, NODE_MODULES));
  return installRunFailed(install, run);
}

async function runStagedRootInstall(mainPackageDir: string, worktreeDir: string, install: PlannedInstall, signal: AbortSignal): Promise<InstallResult> {
  const stagingDir = stagingPathFor(worktreeDir, STAGED_ROOT_INSTALL_KEY);
  const previousNodeModules = `${stagingDir}-previous`;
  try {
    await prepareStagingDir(stagingDir);
    await removeTree(previousNodeModules);
    for (const file of STAGED_INSTALL_FILES) await copyIfPresent(path.join(worktreeDir, file), path.join(stagingDir, file));
    const run = await runInstallCommand(stagingDir, install, signal);
    if (!run.ok) return installRunFailed(install, run);
    const unbuiltPackages = await copyInstallScriptPackages(install, mainPackageDir, stagingDir);
    const isSwapped = await swapNodeModules(path.join(stagingDir, NODE_MODULES), path.join(worktreeDir, NODE_MODULES), previousNodeModules);
    if (isSwapped) return installSucceeded(install, unbuiltPackages);
    return installFailed(install, 'could not move the installed node_modules into the worktree', false);
  } finally {
    await removeTree(stagingDir);
    await removeTree(previousNodeModules);
  }
}

async function swapNodeModules(stagedNodeModules: string, liveNodeModules: string, previousNodeModules: string): Promise<boolean> {
  const hasLiveNodeModules = await pathExists(liveNodeModules);
  if (hasLiveNodeModules && !(await renamed(liveNodeModules, previousNodeModules))) return false;
  if (await renamed(stagedNodeModules, liveNodeModules)) return true;
  if (hasLiveNodeModules) await renamed(previousNodeModules, liveNodeModules);
  return false;
}

function runInstallCommand(cwd: string, install: PlannedInstall, signal: AbortSignal): Promise<CommandResult> {
  return runCommand(install.command, install.args, {
    cwd,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxBuffer: INSTALL_OUTPUT_MAX_BYTES,
    replaceEnv: installEnvFrom(process.env),
    signal,
  });
}

function installSucceeded(install: PlannedInstall, unbuiltPackages: string[]): InstallResult {
  return { dir: install.dir, command: [install.command, ...install.args].join(' '), ok: true, unbuiltPackages };
}

async function copyInstallScriptPackages(install: PlannedInstall, mainPackageDir: string, installedPackageDir: string): Promise<string[]> {
  if (install.command !== 'npm') return [];
  const installStatePath = LOCKFILE_BY_KIND.npm.installState;
  const [worktreeInstalledLockText, mainInstalledLockText] = await Promise.all([
    readTextOrNull(path.join(installedPackageDir, installStatePath)),
    readTextOrNull(path.join(mainPackageDir, installStatePath)),
  ]);
  const plan = planInstallScriptCopies(worktreeInstalledLockText, mainInstalledLockText);
  const unbuiltPackages = [...plan.unbuilt];
  for (const installPath of plan.copies) {
    const isCopied = await replacedWithCopy(path.join(mainPackageDir, installPath), path.join(installedPackageDir, installPath));
    if (!isCopied) unbuiltPackages.push(installPath);
  }
  return unbuiltPackages;
}

async function replacedWithCopy(source: string, destination: string): Promise<boolean> {
  const incomingCopy = `${destination}.glimmervoid-copy`;
  const outgoingCopy = `${destination}.glimmervoid-replaced`;
  try {
    await removeTree(incomingCopy);
    await fsp.cp(source, incomingCopy, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return await swapNodeModules(incomingCopy, destination, outgoingCopy);
  } catch {
    return false;
  } finally {
    await removeTree(incomingCopy);
    await removeTree(outgoingCopy);
  }
}

function installRunFailed(install: PlannedInstall, run: CommandResult): InstallResult {
  return installFailed(install, lastOutputLineOf(run.stderr ?? '') || lastOutputLineOf(run.err), run.timedOut === true);
}

function installFailed(install: PlannedInstall, lastOutputLine: string, timedOut: boolean): InstallResult {
  return { dir: install.dir, command: [install.command, ...install.args].join(' '), ok: false, lastOutputLine, timedOut };
}

async function prepareStagingDir(stagingDir: string): Promise<void> {
  await removeTree(stagingDir);
  await fsp.mkdir(stagingDir, { recursive: true });
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  await fsp.copyFile(source, destination).catch((error: unknown) => {
    if (isMissingFileError(error)) return;
    throw error;
  });
}

function renamed(from: string, to: string): Promise<boolean> {
  return fsp.rename(from, to).then(() => true, () => false);
}

async function dirsWithoutNodeModules(worktreeDir: string, relativeDirs: readonly string[]): Promise<string[]> {
  const emptyDirs: string[] = [];
  for (const relativeDir of relativeDirs) {
    if (!(await pathExists(path.join(worktreeDir, relativeDir, NODE_MODULES)))) emptyDirs.push(relativeDir);
  }
  return emptyDirs;
}

function unreadableInstallOutcome(error: unknown): DependencyInstallOutcome {
  return {
    results: [{ dir: '.', command: 'dependency install', ok: false, lastOutputLine: errorMessage(error), timedOut: false }],
    unsupportedDirs: [],
    elapsedMs: 0,
  };
}

async function cloneDependencies(mainCheckout: string, worktreeDir: string): Promise<DependencyCloneOutcome> {
  const startedAt = performance.now();
  if (process.platform !== 'darwin') return skipDependencyClone('platform');
  const [lock, worktreeHasNodeModules, mainHasNodeModules, mainFilesystem, rootFilesystem, mainStat, worktreeParentStat, nestedPackageDirs] = await Promise.all([
    readLock(mainCheckout, worktreeDir),
    pathExists(path.join(worktreeDir, NODE_MODULES)),
    pathExists(path.join(mainCheckout, NODE_MODULES)),
    fsp.statfs(mainCheckout),
    fsp.statfs('/'),
    fsp.stat(mainCheckout),
    fsp.stat(path.dirname(worktreeDir)),
    listNestedPackageDirs(mainCheckout, worktreeDir),
  ]);
  const plan = planDependencyClone({
    worktreeHasNodeModules,
    mainHasNodeModules,
    lock,
    mainFilesystemType: mainFilesystem.type,
    rootFilesystemType: rootFilesystem.type,
    mainDevice: mainStat.dev,
    worktreeParentDevice: worktreeParentStat.dev,
    nestedPackageDirs,
  });
  if (plan.action === 'skip') return plan;
  const stagedDirs = plan.dirs.map((relativeDir) => ({
    relativeDir,
    sourcePath: path.join(mainCheckout, relativeDir, NODE_MODULES),
    stagingPath: stagingPathFor(worktreeDir, relativeDir),
  }));
  const markerPath = `${stagingPathFor(worktreeDir, '')}.started`;
  await fsp.writeFile(markerPath, '');
  try {
    const stagingFailure = await stageAll(stagedDirs, markerPath);
    if (stagingFailure) {
      await discardStaged(stagedDirs);
      return skipDependencyClone(stagingFailure);
    }
  } finally {
    await fsp.rm(markerPath, { force: true });
  }
  const landedDirs: string[] = [];
  for (const { relativeDir, stagingPath } of stagedDirs) {
    const isLanded = await renamed(stagingPath, path.join(worktreeDir, relativeDir, NODE_MODULES));
    if (isLanded) {
      landedDirs.push(relativeDir);
      continue;
    }
    await removeTree(stagingPath);
  }
  if (!landedDirs.length) return skipDependencyClone('present');
  return { action: 'cloned', dirs: landedDirs, skippedDirs: plan.skippedDirs, elapsedMs: Math.round(performance.now() - startedAt) };
}

type StagedDir = { relativeDir: string; sourcePath: string; stagingPath: string };

async function stageAll(stagedDirs: readonly StagedDir[], markerPath: string): Promise<'failed' | 'outside-link' | 'torn' | null> {
  for (const { relativeDir, sourcePath, stagingPath } of stagedDirs) {
    await removeTree(stagingPath);
    const cloned = await runCommand('cp', ['-Rc', sourcePath, stagingPath], { timeoutMs: CLONE_TIMEOUT_MS });
    if (!cloned.ok) return 'failed';
    for (const cacheDir of CLONED_CACHE_DIRS) await removeTree(path.join(stagingPath, cacheDir));
    const linkCheck = await findLinkOutsideCheckout(relativeDir, stagingPath);
    if (linkCheck) return linkCheck;
  }
  for (const { sourcePath } of stagedDirs) {
    const changedDuringClone = await runCommand('find', [sourcePath, '-cnewer', markerPath, '-print', '-quit'], { timeoutMs: CLONE_TIMEOUT_MS });
    if (!changedDuringClone.ok) return 'failed';
    if (changedDuringClone.out) return 'torn';
  }
  return null;
}

async function findLinkOutsideCheckout(relativeDir: string, stagingPath: string): Promise<'failed' | 'outside-link' | null> {
  const links = await runCommand('find', [stagingPath, '-type', 'l', '-print0'], { timeoutMs: CLONE_TIMEOUT_MS, maxBuffer: LINK_LIST_MAX_BYTES, trim: false });
  if (!links.ok) return 'failed';
  for (const linkPath of links.out.split('\0').filter(Boolean)) {
    const linkTarget = await fsp.readlink(linkPath).catch(() => null);
    if (linkTarget === null) return 'failed';
    const linkPathInCheckout = path.join(relativeDir, NODE_MODULES, path.relative(stagingPath, linkPath));
    if (!isLinkInsideCheckout(linkPathInCheckout, linkTarget)) return 'outside-link';
  }
  return null;
}

async function readLock(mainDir: string, worktreeDir: string): Promise<DependencyLock | null> {
  for (const kind of ['npm', 'pnpm'] as const satisfies readonly LockKind[]) {
    const worktreeLockText = await readTextOrNull(path.join(worktreeDir, LOCKFILE_BY_KIND[kind].lockfile));
    if (worktreeLockText === null) continue;
    const mainStateText = await readTextOrNull(path.join(mainDir, LOCKFILE_BY_KIND[kind].installState));
    return { kind, worktreeLockText, mainStateText };
  }
  return null;
}

async function listNestedPackageDirs(mainCheckout: string, worktreeDir: string): Promise<NestedPackageDir[]> {
  const nestedDirs: NestedPackageDir[] = [];
  for (const relativeDir of await listTrackedPackageDirs(worktreeDir)) {
    if (relativeDir === '.') continue;
    if (await pathExists(path.join(worktreeDir, relativeDir, NODE_MODULES))) continue;
    if (!(await pathExists(path.join(mainCheckout, relativeDir, NODE_MODULES)))) continue;
    const mainPackageDir = path.join(mainCheckout, relativeDir);
    const worktreePackageDir = path.join(worktreeDir, relativeDir);
    nestedDirs.push({
      dir: relativeDir,
      ownLock: await readLock(mainPackageDir, worktreePackageDir),
      hasAnyLockfile: await hasAnyLockfile([mainPackageDir, worktreePackageDir]),
    });
  }
  return nestedDirs;
}

async function hasAnyLockfile(packageDirs: readonly string[]): Promise<boolean> {
  for (const packageDir of packageDirs) {
    for (const lockfile of KNOWN_LOCKFILES) {
      if (await pathExists(path.join(packageDir, lockfile))) return true;
    }
  }
  return false;
}

async function discardStaged(stagedDirs: readonly StagedDir[]): Promise<void> {
  for (const { stagingPath } of stagedDirs) await removeTree(stagingPath);
}

async function removeTree(target: string): Promise<void> {
  if (!(await pathExists(target))) return;
  await runCommand('rm', ['-rf', target], { timeoutMs: CLONE_TIMEOUT_MS });
}

function pathExists(target: string): Promise<boolean> {
  return fsp.lstat(target).then(() => true, () => false);
}

function readTextOrNull(file: string): Promise<string | null> {
  return fsp.readFile(file, 'utf8').then((text) => text, () => null);
}
