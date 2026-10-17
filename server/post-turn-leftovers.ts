import fsp from 'node:fs/promises';
import path from 'node:path';

import { listRepoWorktreePaths } from '../session/core/conversation-history.ts';
import { isPathInside, equalsIgnoringCaseOnWindows } from '../shared/paths.ts';
import { REPORT_FOLDER_GIT_PATH, isReportGitPath, trackedReportCleanupCommands, trackedReportNoticeText, untrackedReportFileNames } from '../shared/post-turn-leftovers.ts';
import type { RepositoryTrackingReports } from '../shared/post-turn-leftovers.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { runGit } from './git/git-exec.ts';

const GIT_TIMEOUT_MS = 10_000;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

interface LeftoverProject {
  path: string;
  repos?: string[] | undefined;
}

interface WorktreeCleanup {
  removedFileCount: number;
  trackedReportGitPaths: string[];
}

const NOTHING_CLEANED: WorktreeCleanup = { removedFileCount: 0, trackedReportGitPaths: [] };

type Logger = Pick<Console, 'log' | 'warn'>;

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, trim: false });
  if (!result.ok) throw result.error ?? new Error(result.err);
  return result.out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function collectWorktreePaths(projects: readonly LeftoverProject[]): Promise<string[]> {
  const repositoryPaths = new Set(projects.flatMap((project) => [project.path, ...(project.repos ?? [])]).filter(Boolean));
  const worktreePaths = new Set<string>();
  for (const repositoryPath of repositoryPaths) {
    if (worktreePaths.has(repositoryPath)) continue;
    await yieldToEventLoop();
    for (const worktreePath of await listRepoWorktreePaths(repositoryPath, gitOutput)) worktreePaths.add(worktreePath);
  }
  return [...worktreePaths];
}

async function readFileNames(folder: string): Promise<string[] | null> {
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function removeFolderIfEmpty(folder: string): Promise<void> {
  if ((await fsp.readdir(folder)).length > 0) return;
  await fsp.rmdir(folder);
}

async function isRealDirectory(folder: string): Promise<boolean> {
  try {
    return (await fsp.lstat(folder)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function isReportFolderOwnedByWorktree(worktreePath: string, reportFolder: string): Promise<boolean> {
  if (!(await isRealDirectory(path.dirname(reportFolder))) || !(await isRealDirectory(reportFolder))) return false;
  const realWorktreePath = await fsp.realpath(worktreePath);
  if (!isPathInside(realWorktreePath, await fsp.realpath(reportFolder), { allowEqual: false })) return false;
  const reportFolderTopLevel = (await gitOutput(['rev-parse', '--show-toplevel'], reportFolder)).trim();
  return equalsIgnoringCaseOnWindows(await fsp.realpath(reportFolderTopLevel), realWorktreePath);
}

async function listTrackedReportGitPaths(worktreePath: string): Promise<string[]> {
  const trackedGitPaths = (await gitOutput(['ls-files', '-z', '--', REPORT_FOLDER_GIT_PATH], worktreePath)).split('\0');
  return trackedGitPaths.filter(isReportGitPath);
}

async function cleanWorktree(worktreePath: string): Promise<WorktreeCleanup> {
  const reportFolder = path.join(worktreePath, ...REPORT_FOLDER_GIT_PATH.split('/'));
  if (!(await isReportFolderOwnedByWorktree(worktreePath, reportFolder))) return NOTHING_CLEANED;
  const fileNames = await readFileNames(reportFolder);
  if (fileNames === null) return NOTHING_CLEANED;
  const trackedReportGitPaths = await listTrackedReportGitPaths(worktreePath);
  const deletableFileNames = untrackedReportFileNames(fileNames, trackedReportGitPaths);
  for (const fileName of deletableFileNames) await fsp.rm(path.join(reportFolder, fileName), { force: true });
  await removeFolderIfEmpty(reportFolder);
  await removeFolderIfEmpty(path.dirname(reportFolder));
  return { removedFileCount: deletableFileNames.length, trackedReportGitPaths };
}

async function cleanPostTurnLeftovers({ projects, logger = console, platform = process.platform }: { projects: readonly LeftoverProject[]; logger?: Logger; platform?: string }): Promise<RepositoryTrackingReports[]> {
  const repositoriesTrackingReports: RepositoryTrackingReports[] = [];
  let removedFileCount = 0;
  for (const worktreePath of await collectWorktreePaths(projects)) {
    await yieldToEventLoop();
    if (CONTROL_CHARACTER.test(worktreePath)) {
      logger.warn(`[post-turn] skipped the old report folder in ${JSON.stringify(worktreePath)} because its path contains a control character`);
      continue;
    }
    try {
      const cleanup = await cleanWorktree(worktreePath);
      removedFileCount += cleanup.removedFileCount;
      if (cleanup.trackedReportGitPaths.length > 0) repositoriesTrackingReports.push({ repositoryPath: worktreePath, trackedReportGitPaths: cleanup.trackedReportGitPaths });
    } catch (error) {
      logger.warn(`[post-turn] could not clean the old report folder in ${worktreePath}: ${errorMessage(error)}`);
    }
  }
  if (removedFileCount > 0) logger.log(`[post-turn] removed ${removedFileCount} old post-turn report files that earlier versions left in your repositories`);
  if (repositoriesTrackingReports.length > 0) {
    logger.warn(`[post-turn] ${trackedReportNoticeText(repositoriesTrackingReports.length)}\n${trackedReportCleanupCommands(repositoriesTrackingReports, platform)}`);
  }
  return repositoriesTrackingReports;
}

async function recheckRepositoriesTrackingReports(repositories: readonly RepositoryTrackingReports[], logger: Logger = console): Promise<RepositoryTrackingReports[]> {
  const repositoriesStillTrackingReports: RepositoryTrackingReports[] = [];
  for (const { repositoryPath } of repositories) {
    await yieldToEventLoop();
    try {
      const trackedReportGitPaths = await listTrackedReportGitPaths(repositoryPath);
      if (trackedReportGitPaths.length > 0) repositoriesStillTrackingReports.push({ repositoryPath, trackedReportGitPaths });
    } catch (error) {
      logger.warn(`[post-turn] could not re-check the old report folder in ${repositoryPath}: ${errorMessage(error)}`);
    }
  }
  return repositoriesStillTrackingReports;
}

export { cleanPostTurnLeftovers, recheckRepositoriesTrackingReports };
