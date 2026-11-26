import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { clock } from '../../shared/clock.ts';
import { isPathInside } from '../../shared/paths.ts';
import { runCommand } from './git-exec.ts';
import { canCloneCopyOnWrite, checkSourceChangedSince, findEscapingSymlink } from './dependency-clone.ts';
import { cloneFlagsFor } from './core/dependency-clone-core.ts';
import {
  DEFAULT_COW_SHARED_HIDDEN_DIRS,
  DEFAULT_COW_WARM_INTERVAL_MS,
  filterIgnoredBuildDirs,
  hasDisallowedResolvedSegment,
  isCowDisabledByEnv,
  isDisallowedStagedEntry,
  isWarmStale,
  planCowWorktreeAdd,
  templatePathsFor,
  trackedAncestorDirsFrom,
} from './core/cow-worktree-core.ts';
import type { CowFallbackReason, CowTemplatePaths } from './core/cow-worktree-core.ts';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const cowSupportByDevicePair = new Map<string, boolean>();

type CowGitCommandResult = { ok: boolean; out: string; err?: string };

export type CowWorktreeGitOps = {
  runGit(args: string[], cwd: string): Promise<CowGitCommandResult>;
  addNoCheckoutWorktree(worktreePath: string, branch: string | null, startRef: string): Promise<{ ok: boolean; err?: string }>;
  addDetachedTemplate(templatePath: string, startRef: string, noCheckout: boolean): Promise<{ ok: boolean; err?: string }>;
  removeWorktreeForce(worktreePath: string): Promise<{ ok: boolean; err?: string }>;
  deleteBranchForce(branch: string): Promise<{ ok: boolean; err?: string }>;
};

export type CowCloneDir = (sourcePath: string, destinationPath: string, cloneFlags: readonly string[]) => Promise<boolean>;
export type CowCanClone = (sourceDir: string, targetDir: string) => Promise<boolean>;

type CowWorktreeAddOptions = {
  projectPath: string;
  worktreePath: string;
  branch: string | null;
  createBranch: boolean;
  startRef: string;
  templateStartRef: string;
  gitOps: CowWorktreeGitOps;
  sharedHiddenDirs?: readonly string[];
  warmIntervalMs?: number;
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cloneDir?: CowCloneDir;
  canClone?: CowCanClone;
};

type CowWorktreeAddResult =
  | { ok: true; templateDir: string }
  | { ok: false; reason: CowFallbackReason };

type WarmCowTemplateOptions = {
  projectPath: string;
  worktreePath: string;
  worktreeParent: string;
  gitOps: Pick<CowWorktreeGitOps, 'runGit'>;
  sharedHiddenDirs?: readonly string[];
  platform?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cloneDir?: CowCloneDir;
  canClone?: CowCanClone;
};

async function pathExists(targetPath: string): Promise<boolean> {
  return fsp.lstat(targetPath).then(() => true, () => false);
}

async function makeDirsWritable(targetPath: string): Promise<void> {
  const pendingDirs = [targetPath];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (currentDir === undefined) break;
    const stat = await fsp.lstat(currentDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    await fsp.chmod(currentDir, stat.mode | 0o700).catch(() => {});
    const entries = await fsp.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) pendingDirs.push(path.join(currentDir, entry.name));
    }
  }
}

async function removeTreeStrict(targetPath: string): Promise<void> {
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch {
    await makeDirsWritable(targetPath);
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
}

async function removeTreeForce(targetPath: string): Promise<void> {
  await removeTreeStrict(targetPath).catch(() => {});
}

async function removeWorktreeDir(gitOps: Pick<CowWorktreeGitOps, 'removeWorktreeForce'>, targetPath: string): Promise<void> {
  await gitOps.removeWorktreeForce(targetPath).catch(() => {});
  await removeTreeForce(targetPath);
}

async function defaultCanCloneDirs(sourceDir: string, targetDir: string): Promise<boolean> {
  await fsp.mkdir(targetDir, { recursive: true }).catch(() => {});
  const [sourceStat, targetStat] = await Promise.all([
    fsp.stat(sourceDir).catch(() => null),
    fsp.stat(targetDir).catch(() => null),
  ]);
  if (!sourceStat || !targetStat || sourceStat.dev !== targetStat.dev) return false;
  const deviceKey = `${sourceStat.dev}:${targetStat.dev}`;
  const cached = cowSupportByDevicePair.get(deviceKey);
  if (cached !== undefined) return cached;
  const probeSource = path.join(sourceDir, `.glimmervoid-cow-src-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(probeSource, 'x');
    const supported = await canCloneCopyOnWrite(probeSource, targetDir);
    cowSupportByDevicePair.set(deviceKey, supported);
    return supported;
  } catch {
    return false;
  } finally {
    await fsp.rm(probeSource, { force: true }).catch(() => {});
  }
}

async function defaultCloneEntry(sourcePath: string, destinationPath: string, cloneFlags: readonly string[]): Promise<boolean> {
  const copyOutcome = await runCommand('cp', [...cloneFlags, sourcePath, destinationPath], { timeoutMs: CLONE_TIMEOUT_MS });
  return copyOutcome.ok;
}

async function resolveCommonGitDir(projectPath: string, runGit: CowWorktreeGitOps['runGit']): Promise<string | null> {
  const commonDir = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], projectPath);
  if (!commonDir.ok || !commonDir.out.trim()) return null;
  return commonDir.out.trim();
}

async function isBareRepository(projectPath: string, runGit: CowWorktreeGitOps['runGit']): Promise<boolean> {
  const probe = await runGit(['rev-parse', '--is-bare-repository'], projectPath);
  return probe.ok && probe.out.trim() === 'true';
}

async function copyIndexAndResetHard(sourceDir: string, targetDir: string, runGit: CowWorktreeGitOps['runGit']): Promise<boolean> {
  const [sourceGitDir, targetGitDir] = await Promise.all([
    runGit(['rev-parse', '--absolute-git-dir'], sourceDir),
    runGit(['rev-parse', '--absolute-git-dir'], targetDir),
  ]);
  if (!sourceGitDir.ok || !targetGitDir.ok) return false;
  const sourceIndex = path.join(sourceGitDir.out.trim(), 'index');
  const targetIndex = path.join(targetGitDir.out.trim(), 'index');
  if (await pathExists(sourceIndex)) await fsp.copyFile(sourceIndex, targetIndex);
  await runGit(['update-index', '-q', '--refresh'], targetDir);
  const reset = await runGit(['reset', '--hard', '-q'], targetDir);
  return reset.ok;
}

async function cloneTemplateFromMainCheckout(options: {
  projectPath: string;
  templateDir: string;
  templateStartRef: string;
  cloneFlags: readonly string[];
  gitOps: CowWorktreeGitOps;
  cloneEntry: CowCloneDir;
  canClone: CowCanClone;
}): Promise<boolean> {
  const { projectPath, templateDir, templateStartRef, cloneFlags, gitOps, cloneEntry, canClone } = options;
  if (await isBareRepository(projectPath, gitOps.runGit)) return false;
  const topLevelOutcome = await gitOps.runGit(['rev-parse', '--show-toplevel'], projectPath);
  if (!topLevelOutcome.ok || !topLevelOutcome.out.trim()) return false;
  const mainCheckoutDir = topLevelOutcome.out.trim();
  if (!(await canClone(mainCheckoutDir, path.dirname(templateDir)))) return false;
  if (!(await gitOps.addDetachedTemplate(templateDir, templateStartRef, true)).ok) return false;
  const treeListing = await gitOps.runGit(['ls-tree', '-z', '--name-only', 'HEAD'], mainCheckoutDir);
  if (!treeListing.ok) return false;
  for (const entryName of treeListing.out.split('\0').filter(Boolean)) {
    const sourceEntry = path.join(mainCheckoutDir, entryName);
    if (!(await pathExists(sourceEntry))) continue;
    if (!(await cloneEntry(sourceEntry, path.join(templateDir, entryName), cloneFlags))) return false;
  }
  if (!(await copyIndexAndResetHard(mainCheckoutDir, templateDir, gitOps.runGit))) return false;
  return (await gitOps.runGit(['clean', '-ffdxq'], templateDir)).ok;
}

async function refreshTemplateCheckout(options: {
  projectPath: string;
  templateDir: string;
  templateStartRef: string;
  cloneFlags: readonly string[];
  gitOps: CowWorktreeGitOps;
  cloneEntry: CowCloneDir;
  canClone: CowCanClone;
}): Promise<boolean> {
  const { templateDir, templateStartRef, gitOps } = options;
  if (await pathExists(path.join(templateDir, '.git'))) {
    const checkedOut = await gitOps.runGit(['checkout', '--detach', '--force', templateStartRef], templateDir);
    if (checkedOut.ok) {
      await gitOps.runGit(['clean', '-ffdq'], templateDir);
      return true;
    }
  }
  await removeWorktreeDir(gitOps, templateDir);
  if (await cloneTemplateFromMainCheckout(options)) return true;
  await removeWorktreeDir(gitOps, templateDir);
  return (await gitOps.addDetachedTemplate(templateDir, templateStartRef, false)).ok;
}

async function readStampMtimeMs(stampPath: string): Promise<number | null> {
  const stat = await fsp.stat(stampPath).catch(() => null);
  return stat ? stat.mtimeMs : null;
}

async function writeWarmStamp(stampPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(stampPath), { recursive: true });
  await fsp.writeFile(stampPath, '');
}

async function hasSymlinkAncestorInTemplate(templateDir: string, relativeDir: string): Promise<boolean> {
  const realTemplateDir = await fsp.realpath(templateDir).catch(() => null);
  if (realTemplateDir === null) return true;
  let currentPath = templateDir;
  let deepestExistingPath = templateDir;
  for (const segment of relativeDir.split('/').filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const segmentStat = await fsp.lstat(currentPath).catch(() => null);
    if (segmentStat === null) break;
    if (segmentStat.isSymbolicLink()) return true;
    deepestExistingPath = currentPath;
  }
  const realAncestor = await fsp.realpath(deepestExistingPath).catch(() => null);
  if (realAncestor === null) return true;
  return !isPathInside(realTemplateDir, realAncestor, { allowEqual: true });
}

async function stripDisallowedStagedEntries(stagingPath: string, allowedHiddenDirs: ReadonlySet<string>): Promise<void> {
  const pendingDirs = [stagingPath];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (currentDir === undefined) break;
    const entries = await fsp.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    const disallowedPaths: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (isDisallowedStagedEntry(entry.name, entry.isDirectory() || entry.isSymbolicLink(), allowedHiddenDirs)) {
        disallowedPaths.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) pendingDirs.push(entryPath);
    }
    if (disallowedPaths.length === 0) continue;
    const parentStat = await fsp.lstat(currentDir);
    const parentWasReadOnly = (parentStat.mode & 0o200) === 0;
    if (parentWasReadOnly) await fsp.chmod(currentDir, parentStat.mode | 0o700);
    try {
      for (const disallowedPath of disallowedPaths) await removeTreeStrict(disallowedPath);
    } finally {
      if (parentWasReadOnly) await fsp.chmod(currentDir, parentStat.mode).catch(() => {});
    }
  }
}

async function renameStagedDir(stagingPath: string, destinationDir: string): Promise<void> {
  const stagingStat = await fsp.lstat(stagingPath);
  const stagingWasReadOnly = stagingStat.isDirectory() && (stagingStat.mode & 0o200) === 0;
  if (stagingWasReadOnly) await fsp.chmod(stagingPath, stagingStat.mode | 0o700);
  await fsp.rename(stagingPath, destinationDir);
  if (stagingWasReadOnly) await fsp.chmod(destinationDir, stagingStat.mode).catch(() => {});
}

async function warmTemplateBuildDirs(options: {
  sourceCheckoutDir: string;
  templatePaths: CowTemplatePaths;
  cloneFlags: readonly string[];
  sharedHiddenDirs: readonly string[];
  runGit: CowWorktreeGitOps['runGit'];
  cloneEntry: CowCloneDir;
}): Promise<void> {
  const { sourceCheckoutDir, templatePaths, cloneFlags, sharedHiddenDirs, runGit, cloneEntry } = options;
  const [ignoredListing, trackedListing] = await Promise.all([
    runGit(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], sourceCheckoutDir),
    runGit(['ls-files', '-z'], templatePaths.templateDir),
  ]);
  if (!ignoredListing.ok || !trackedListing.ok) return;
  const trackedAncestors = trackedAncestorDirsFrom(trackedListing.out);
  const candidateDirs = filterIgnoredBuildDirs(ignoredListing.out, sharedHiddenDirs, trackedAncestors);
  const allowedHiddenDirs = new Set(sharedHiddenDirs);
  const isDisallowedTarget = (resolvedSegments: readonly string[]) => hasDisallowedResolvedSegment(resolvedSegments, allowedHiddenDirs);
  for (const relativeDir of candidateDirs) {
    const sourceDir = path.join(sourceCheckoutDir, relativeDir);
    if (!(await pathExists(sourceDir))) continue;
    if (await hasSymlinkAncestorInTemplate(templatePaths.templateDir, relativeDir)) continue;
    const stagingPath = path.join(templatePaths.warmStagingDir, path.basename(relativeDir));
    const markerPath = `${templatePaths.warmStagingDir}.started`;
    await removeTreeForce(templatePaths.warmStagingDir);
    await fsp.mkdir(templatePaths.warmStagingDir, { recursive: true });
    await fsp.writeFile(markerPath, '');
    try {
      if (!(await cloneEntry(sourceDir, stagingPath, cloneFlags))) continue;
      await stripDisallowedStagedEntries(stagingPath, allowedHiddenDirs);
      if ((await findEscapingSymlink(relativeDir, stagingPath, isDisallowedTarget)) !== null) continue;
      if ((await checkSourceChangedSince(sourceDir, markerPath)) !== null) continue;
      if (await hasSymlinkAncestorInTemplate(templatePaths.templateDir, relativeDir)) continue;
      const destinationDir = path.join(templatePaths.templateDir, relativeDir);
      await removeTreeForce(destinationDir);
      await fsp.mkdir(path.dirname(destinationDir), { recursive: true });
      await renameStagedDir(stagingPath, destinationDir);
    } catch {
    } finally {
      await fsp.rm(markerPath, { force: true }).catch(() => {});
      await removeTreeForce(templatePaths.warmStagingDir);
    }
  }
}

async function populateWorktreeFromTemplate(options: {
  templateDir: string;
  worktreePath: string;
  branch: string | null;
  startRef: string;
  cloneFlags: readonly string[];
  gitOps: CowWorktreeGitOps;
  cloneEntry: CowCloneDir;
}): Promise<boolean> {
  const { templateDir, worktreePath, branch, startRef, cloneFlags, gitOps, cloneEntry } = options;
  if (!(await gitOps.addNoCheckoutWorktree(worktreePath, branch, startRef)).ok) return false;
  const templateEntries = await fsp.readdir(templateDir, { withFileTypes: true });
  for (const entry of templateEntries) {
    if (entry.name === '.git') continue;
    if (!(await cloneEntry(path.join(templateDir, entry.name), path.join(worktreePath, entry.name), cloneFlags))) return false;
  }
  if (!(await copyIndexAndResetHard(templateDir, worktreePath, gitOps.runGit))) return false;
  await gitOps.runGit(['clean', '-ffdq'], worktreePath);
  return true;
}

export async function addCowWorktree(options: CowWorktreeAddOptions): Promise<CowWorktreeAddResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const cloneEntry = options.cloneDir ?? defaultCloneEntry;
  const canClone = options.canClone ?? defaultCanCloneDirs;
  const sharedHiddenDirs = options.sharedHiddenDirs ?? DEFAULT_COW_SHARED_HIDDEN_DIRS;
  const warmIntervalMs = options.warmIntervalMs ?? DEFAULT_COW_WARM_INTERVAL_MS;

  const worktreeParent = path.dirname(options.worktreePath);
  const cowDisabled = isCowDisabledByEnv(env);
  const hasSubmodules = await pathExists(path.join(options.projectPath, '.gitmodules'));
  const shouldProbe = !cowDisabled && !hasSubmodules && cloneFlagsFor(platform) !== null;
  if (shouldProbe) await fsp.mkdir(worktreeParent, { recursive: true }).catch(() => {});
  const plan = planCowWorktreeAdd({
    platform,
    cowDisabled,
    hasSubmodules,
    canCloneCopyOnWrite: shouldProbe ? await canClone(worktreeParent, worktreeParent) : false,
  });
  if (plan.action === 'fallback') return { ok: false, reason: plan.reason };

  const repoCommonDir = await resolveCommonGitDir(options.projectPath, options.gitOps.runGit);
  if (!repoCommonDir) return { ok: false, reason: 'failed' };
  const templatePaths = templatePathsFor(worktreeParent, repoCommonDir);

  const branchExistedBefore = options.createBranch && options.branch !== null
    ? (await options.gitOps.runGit(['rev-parse', '--verify', '-q', `refs/heads/${options.branch}`], options.projectPath)).ok
    : true;

  try {
    await fsp.mkdir(templatePaths.rootDir, { recursive: true });
    const refreshed = await refreshTemplateCheckout({
      projectPath: options.projectPath,
      templateDir: templatePaths.templateDir,
      templateStartRef: options.templateStartRef,
      cloneFlags: plan.cloneFlags,
      gitOps: options.gitOps,
      cloneEntry,
      canClone,
    });
    if (!refreshed) return { ok: false, reason: 'failed' };
    if (await pathExists(path.join(templatePaths.templateDir, '.gitmodules'))) return { ok: false, reason: 'submodules' };

    const isBare = await isBareRepository(options.projectPath, options.gitOps.runGit);
    const stampMtimeMs = await readStampMtimeMs(templatePaths.stampPath);
    if (!isBare && isWarmStale(stampMtimeMs, clock.nowMs(), warmIntervalMs)) {
      await warmTemplateBuildDirs({
        sourceCheckoutDir: options.projectPath,
        templatePaths,
        cloneFlags: plan.cloneFlags,
        sharedHiddenDirs,
        runGit: options.gitOps.runGit,
        cloneEntry,
      });
      await writeWarmStamp(templatePaths.stampPath).catch(() => {});
    }

    const populated = await populateWorktreeFromTemplate({
      templateDir: templatePaths.templateDir,
      worktreePath: options.worktreePath,
      branch: options.createBranch ? options.branch : null,
      startRef: options.startRef,
      cloneFlags: plan.cloneFlags,
      gitOps: options.gitOps,
      cloneEntry,
    });
    if (populated) return { ok: true, templateDir: templatePaths.templateDir };
    await cleanupFailedWorktree(options, branchExistedBefore);
    return { ok: false, reason: 'failed' };
  } catch {
    await cleanupFailedWorktree(options, branchExistedBefore);
    return { ok: false, reason: 'failed' };
  }
}

async function cleanupFailedWorktree(options: CowWorktreeAddOptions, branchExistedBefore: boolean): Promise<void> {
  await removeWorktreeDir(options.gitOps, options.worktreePath);
  if (options.createBranch && !branchExistedBefore && options.branch) {
    await options.gitOps.deleteBranchForce(options.branch).catch(() => {});
  }
}

export async function warmCowTemplateFromWorktree(options: WarmCowTemplateOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (isCowDisabledByEnv(env)) return false;
  const cloneFlags = cloneFlagsFor(platform);
  if (!cloneFlags) return false;
  const canClone = options.canClone ?? defaultCanCloneDirs;
  const cloneEntry = options.cloneDir ?? defaultCloneEntry;
  const sharedHiddenDirs = options.sharedHiddenDirs ?? DEFAULT_COW_SHARED_HIDDEN_DIRS;

  const repoCommonDir = await resolveCommonGitDir(options.projectPath, options.gitOps.runGit);
  if (!repoCommonDir) return false;
  const templatePaths = templatePathsFor(options.worktreeParent, repoCommonDir);
  if (!(await pathExists(path.join(templatePaths.templateDir, '.git')))) return false;
  if (!(await canClone(options.worktreeParent, templatePaths.rootDir))) return false;
  try {
    await warmTemplateBuildDirs({
      sourceCheckoutDir: options.worktreePath,
      templatePaths,
      cloneFlags,
      sharedHiddenDirs,
      runGit: options.gitOps.runGit,
      cloneEntry,
    });
    await writeWarmStamp(templatePaths.stampPath).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
