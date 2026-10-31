import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCommand, runGit } from './git-exec.ts';
import { createSerialQueue } from '../spawn-gate.ts';
import {
  CLONED_CACHE_DIRS,
  KNOWN_LOCKFILES,
  isLinkInsideCheckout,
  LOCKFILE_BY_KIND,
  packageDirsFromTrackedFiles,
  planDependencyClone,
  skipDependencyClone,
  stagingPathFor,
} from './core/dependency-clone-core.ts';
import type { DependencyCloneSkip, DependencyLock, LockKind, NestedPackageDir } from './core/dependency-clone-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const NODE_MODULES = 'node_modules';
const LINK_LIST_MAX_BYTES = 64 * 1024 * 1024;

type DependencyCloneOutcome = DependencyCloneSkip | { action: 'cloned'; dirs: string[]; staleDirs: string[]; elapsedMs: number };
export type SeedDependencies = (args: { mainCheckout: string; worktreeDir: string }) => Promise<DependencyCloneOutcome>;

const cloneQueue = createSerialQueue();

export const seedWorktreeDependencies: SeedDependencies = ({ mainCheckout, worktreeDir }) =>
  cloneQueue.run(() => cloneDependencies(mainCheckout, worktreeDir).catch(() => skipDependencyClone('failed')));

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
  return { action: 'cloned', dirs: landedDirs, staleDirs: plan.staleDirs, elapsedMs: Math.round(performance.now() - startedAt) };
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
  const tracked = await runGit(['ls-files', '-z', '--', 'package.json', '**/package.json'], { cwd: worktreeDir, trim: false });
  if (!tracked.ok) return [];
  const nestedDirs: NestedPackageDir[] = [];
  for (const relativeDir of packageDirsFromTrackedFiles(tracked.out.split('\0').filter(Boolean))) {
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
