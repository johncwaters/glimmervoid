import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../../shared/text.ts';
import { runCommand, runGit } from './git-exec.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import {
  CLONED_CACHE_DIRS,
  INSTALL_TIMEOUT_MS,
  KNOWN_LOCKFILES,
  installEnvFrom,
  isLinkInsideCheckout,
  lastOutputLineOf,
  LOCKFILE_BY_KIND,
  packageDirsFromTrackedFiles,
  planDependencyClone,
  planDependencyInstall,
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
const LINK_LIST_MAX_BYTES = 64 * 1024 * 1024;
const INSTALL_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

type DependencyCloneOutcome = DependencyCloneSkip | { action: 'cloned'; dirs: string[]; skippedDirs: string[]; elapsedMs: number };
export type DependencySeedOutcome = { clone: DependencyCloneOutcome; install: DependencyInstallOutcome };
export type SeedDependencies = (args: { mainCheckout: string; worktreeDir: string }) => Promise<DependencySeedOutcome>;

const seedQueue = createSerialQueue();

export const seedWorktreeDependencies: SeedDependencies = ({ mainCheckout, worktreeDir }) =>
  seedQueue.run(async () => {
    const clone = await cloneDependencies(mainCheckout, worktreeDir).catch(() => skipDependencyClone('failed'));
    const install = await installDependencies(worktreeDir).catch((error: unknown) => unreadableInstallOutcome(error));
    const skippedDirs = clone.action === 'cloned' ? clone.skippedDirs : [];
    const reportedDirs = new Set([...install.unsupportedDirs, ...install.results.map((result) => result.dir)]);
    const emptyDirs = await dirsWithoutNodeModules(worktreeDir, skippedDirs.filter((dir) => !reportedDirs.has(dir)));
    return { clone, install: { ...install, unsupportedDirs: [...install.unsupportedDirs, ...emptyDirs] } };
  });

async function installDependencies(worktreeDir: string): Promise<DependencyInstallOutcome> {
  const startedAt = performance.now();
  const plan = planDependencyInstall(process.platform, await listPackageDirFacts(worktreeDir));
  const results: InstallResult[] = [];
  for (const install of plan.installs) results.push(await runInstall(worktreeDir, install));
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

async function runInstall(worktreeDir: string, install: PlannedInstall): Promise<InstallResult> {
  const packageDir = path.join(worktreeDir, install.dir);
  const commandLine = [install.command, ...install.args].join(' ');
  const run = await runCommand(install.command, install.args, {
    cwd: packageDir,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxBuffer: INSTALL_OUTPUT_MAX_BYTES,
    replaceEnv: installEnvFrom(process.env),
  });
  if (run.ok) return { dir: install.dir, command: commandLine, ok: true };
  await removeTree(path.join(packageDir, NODE_MODULES));
  return { dir: install.dir, command: commandLine, ok: false, lastOutputLine: lastOutputLineOf(run.stderr ?? '') || lastOutputLineOf(run.err), timedOut: run.timedOut === true };
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
    const isLanded = await fsp.rename(stagingPath, path.join(worktreeDir, relativeDir, NODE_MODULES)).then(() => true, () => false);
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
