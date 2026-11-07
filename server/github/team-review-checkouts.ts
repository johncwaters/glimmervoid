import fs from 'node:fs/promises';
import path from 'node:path';
import * as core from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';
import { firstLine } from '../lanes/ephemeral-session.ts';
import type { NewWorkIsolation } from '../git/repo-cache.ts';
import { reapTeamReviewProcesses } from './team-review-reaper.ts';
import type { TeamReviewReapOptions } from './team-review-reaper.ts';
import type { ResumableReview } from '../../shared/contracts/team-review.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import type { OwnedPathOwner } from '../../shared/contracts/owned-paths.ts';
import { isPathInside } from '../../shared/paths.ts';
import { readGitDirsOfOwnCheckout, repositoryRootOfCommonGitDir } from '../lanes/work-lane.ts';

interface TeamReviewWiringConfig extends TeamReviewSettingsSource {
  replayBufferKB?: number;
  saneYolo?: boolean;
  saneYoloUnreadablePaths?: readonly string[];
  projects?: { path: string }[];
  repoRoots?: string[];
}

interface TeamReviewRepoCache {
  listRepos(): Promise<string[]>;
  ensureRepo(repo: string): Promise<string | null>;
  fetchPr(repo: string, number: number, baseRef: string): Promise<{ ok: boolean; headSha: string | null; err: string }>;
  hydrateTree(repo: string, headSha: string): Promise<{ ok: boolean; err: string }>;
  hydrateRange(repo: string, number: number, headSha: string): Promise<{ ok: boolean; err: string }>;
  hydrateSince(repo: string, sinceSha: string, headSha: string): Promise<boolean>;
  isolateNewWork(repo: string, since: { number: number; priorHead: string; priorBase: string; head: string }): Promise<NewWorkIsolation>;
}

interface TeamReviewGitWorkspace {
  stageDetachedWorktree(args: { projectPath: string; owner: OwnedPathOwner; worktreePath?: string; sha?: string }): Promise<{ ok: boolean; err?: string }>;
  originUrl(args: { projectPath: string }): Promise<string | null>;
  populate(args: { projectPath: string; wtDir: string; shareList: string[]; keepTrackableLinks?: boolean }): Promise<void>;
  removeWorktreeByPath(args: { projectPath: string; cwd?: string | null; cause: 'team-review' }): Promise<{ ok: boolean; err?: string; removalKept?: string }>;
  pruneWorktrees(args: { projectPath: string }): Promise<{ ok: boolean; err?: string }>;
  forgetRemovedPath?(worktreePath: string): Promise<void>;
  seedBranchFromOrigin?(args: { projectPath: string; name: string }): Promise<{ ok: boolean; out: string; err?: string }>;
}

type TeamReviewReap = (options: Required<TeamReviewReapOptions>) => Promise<void>;

function worktreeDirName(repo: string, number: number, suffix: string): string {
  return `glimmervoid-wt-${core.TEAM_REVIEW_LANE_ID}-${repo.replace(/[^\w.-]+/g, '-')}-${number}-${suffix}`;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return fs.lstat(candidatePath).then(() => true, () => false);
}

function isDirectChildOf(root: string, candidatePath: string): boolean {
  return path.dirname(path.resolve(candidatePath)) === path.resolve(root);
}

function isOwnedResumable(record: ResumableReview, roots: { workRoot: string; worktreeRoot: string }): boolean {
  return isDirectChildOf(roots.workRoot, record.workDir) && isDirectChildOf(roots.worktreeRoot, record.worktreePath);
}

async function isRealChildDirectoryOrMissing(root: string, candidatePath: string): Promise<boolean> {
  if (!isDirectChildOf(root, candidatePath)) return false;
  const candidateStat = await fs.lstat(candidatePath).catch((error: unknown) => (isMissingFileError(error, { includeNotDir: false }) ? 'missing' : null));
  if (candidateStat === 'missing') return true;
  if (!candidateStat?.isDirectory()) return false;
  const realPaths = await Promise.all([fs.realpath(candidatePath), fs.realpath(root)]).catch(() => null);
  if (!realPaths) return false;
  const [realCandidatePath, realRootPath] = realPaths;
  return path.dirname(realCandidatePath) === realRootPath;
}

async function isResumableInsideRoots(record: ResumableReview, roots: { workRoot: string; worktreeRoot: string }): Promise<boolean> {
  const [isWorkDirInside, isWorktreeInside] = await Promise.all([
    isRealChildDirectoryOrMissing(roots.workRoot, record.workDir),
    isRealChildDirectoryOrMissing(roots.worktreeRoot, record.worktreePath),
  ]);
  return isWorkDirInside && isWorktreeInside;
}

async function pruneCachedClone(
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees'>, projectPath: string, log: Pick<Console, 'warn'>,
): Promise<void> {
  const pruned = await gitWorkspace.pruneWorktrees({ projectPath })
    .catch((error: unknown) => ({ ok: false, err: errorMessage(error) }));
  if (!pruned.ok) log.warn(`[${core.TEAM_REVIEW_LANE_ID}] worktree prune failed in ${projectPath}: ${firstLine(pruned.err ?? '')}`);
}

async function deleteDirectory(directory: string, log: Pick<Console, 'warn'>): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true })
    .catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not delete ${directory}: ${errorMessage(error)}`));
}

async function deleteCheckout(
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'forgetRemovedPath'>, worktreePath: string, log: Pick<Console, 'warn'>,
): Promise<void> {
  await deleteDirectory(worktreePath, log);
  await gitWorkspace.forgetRemovedPath?.(worktreePath);
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  const stats = await fs.stat(candidatePath).catch(() => null);
  return stats?.isDirectory() === true;
}

async function mainCheckoutOf(checkoutPath: string): Promise<string | null> {
  const gitDirs = await readGitDirsOfOwnCheckout(checkoutPath).catch(() => null);
  if (gitDirs === null) return null;
  const isBareRepository = gitDirs.commonGitDir === checkoutPath;
  if (isBareRepository) return null;
  const isLinkedWorktree = gitDirs.worktreeAdminDir !== gitDirs.commonGitDir;
  if (!isLinkedWorktree) return checkoutPath;
  return repositoryRootOfCommonGitDir(gitDirs.commonGitDir);
}

async function configuredProjectPathsByRealPath(projects: readonly { path: string }[]): Promise<Map<string, string>> {
  const configuredPathByRealPath = new Map<string, string>();
  for (const project of projects) {
    const projectRealPath = await fs.realpath(project.path).catch(() => null);
    if (projectRealPath === null || configuredPathByRealPath.has(projectRealPath)) continue;
    configuredPathByRealPath.set(projectRealPath, project.path);
  }
  return configuredPathByRealPath;
}

async function findLocalCheckout({ repo, config, excludedRoots, gitWorkspace, log, requireInstalledModules = true, resolveCheckout }: {
  repo: string;
  config: Pick<TeamReviewWiringConfig, 'projects' | 'repoRoots'>;
  excludedRoots: string[];
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'originUrl'>;
  log: Pick<Console, 'warn'>;
  requireInstalledModules?: boolean;
  resolveCheckout?: (checkoutPath: string) => Promise<string | null>;
}): Promise<string | null> {
  const resolvedExcludedRoots = await Promise.all(excludedRoots.map(async (root) => fs.realpath(root).catch(() => path.resolve(root))));
  const candidatePaths = (config.projects ?? []).map((project) => project.path);
  for (const root of config.repoRoots ?? []) {
    const children = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not list local repositories in ${root}: ${errorMessage(error)}`);
      return [];
    });
    const childNames = children.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name).sort();
    for (const childName of childNames) {
      candidatePaths.push(path.join(root, childName));
    }
  }
  const seenPaths = new Set<string>();
  for (const candidatePath of candidatePaths) {
    const checkoutPath = await fs.realpath(candidatePath).catch(() => null);
    if (!checkoutPath || seenPaths.has(checkoutPath)) continue;
    seenPaths.add(checkoutPath);
    if (resolvedExcludedRoots.some((root) => isPathInside(root, checkoutPath))) continue;
    if (requireInstalledModules && !(await isDirectory(path.join(checkoutPath, 'node_modules')))) continue;
    const origin = await gitWorkspace.originUrl({ projectPath: checkoutPath }).catch(() => null);
    if (!origin || !core.remoteMatchesGithubRepo(origin, repo)) continue;
    const resolvedCheckout = resolveCheckout ? await resolveCheckout(checkoutPath) : checkoutPath;
    if (resolvedCheckout !== null) return resolvedCheckout;
  }
  return null;
}

async function isLinkedToCheckout(worktreePath: string, localCheckout: string): Promise<boolean> {
  const modulesPath = path.join(worktreePath, 'node_modules');
  const modulesLink = await fs.lstat(modulesPath).catch(() => null);
  if (!modulesLink?.isSymbolicLink()) return false;
  const linkedModules = await fs.realpath(modulesPath).catch(() => null);
  const checkoutModules = await fs.realpath(path.join(localCheckout, 'node_modules')).catch(() => null);
  return linkedModules !== null && linkedModules === checkoutModules;
}

async function sweepLeftoverCheckouts({ worktreeRoot, workRoot, keepPaths, repoCache, gitWorkspace, reapProcesses = reapTeamReviewProcesses, log }: {
  worktreeRoot: string;
  workRoot: string;
  keepPaths: ReadonlySet<string>;
  repoCache: Pick<TeamReviewRepoCache, 'listRepos'>;
  gitWorkspace: Pick<TeamReviewGitWorkspace, 'pruneWorktrees' | 'forgetRemovedPath'>;
  reapProcesses?: TeamReviewReap;
  log: Pick<Console, 'warn'>;
}): Promise<void> {
  await reapProcesses({ ownedDirectories: [workRoot, worktreeRoot], reviewRoots: [workRoot, worktreeRoot], scope: 'sweep', log }).catch((error: unknown) => log.warn(`[${core.TEAM_REVIEW_LANE_ID}] process reap failed: ${errorMessage(error)}`));
  for (const root of [worktreeRoot, workRoot]) {
    const leftoverNames = await fs.readdir(root).catch(() => []);
    for (const leftoverName of leftoverNames) {
      const directory = path.join(root, leftoverName);
      if (keepPaths.has(directory)) continue;
      await deleteCheckout(gitWorkspace, directory, log);
    }
  }
  const cachedClones = await repoCache.listRepos()
    .catch((error: unknown) => { log.warn(`[${core.TEAM_REVIEW_LANE_ID}] could not list cached clones: ${errorMessage(error)}`); return []; });
  for (const projectPath of cachedClones) await pruneCachedClone(gitWorkspace, projectPath, log);
}

export { worktreeDirName, pathExists, isOwnedResumable, isResumableInsideRoots, pruneCachedClone, deleteDirectory, deleteCheckout, mainCheckoutOf, configuredProjectPathsByRealPath, findLocalCheckout, isLinkedToCheckout, sweepLeftoverCheckouts };
export type { TeamReviewWiringConfig, TeamReviewRepoCache, TeamReviewGitWorkspace, TeamReviewReap };
