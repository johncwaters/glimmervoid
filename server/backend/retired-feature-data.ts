import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../../shared/text.ts';
import type { RemovalCause } from '../../shared/contracts/removal-record.ts';
import { recordSweptPath } from '../removal-journal.ts';

const RETIRED_RUNS_FOLDER = 'benchmark-runs';
const SUITES_FOLDER = 'benchmarks';
const RETIRED_SUITE_FOLDERS: readonly string[] = Object.freeze(['runs', 'work']);
const RETIRED_WORKTREES_FOLDER = 'worktrees';
const RETIRED_ISSUES_CACHE_FILE = 'issues-cache.json';
const RETIRED_CODER_OWNED_WORKSPACES_FILE = 'coder-owned-workspaces.json';

interface RetiredWorktreeRemover {
  removeWorktreeByPath(args: { projectPath: string; cwd: string; cause: 'benchmark' }): Promise<{ ok: boolean; err?: string; removalKept?: string }>;
}

function worktreeOwnerRepo(gitFileText: string): string | null {
  const gitDir = /^gitdir:\s*(.+)$/m.exec(gitFileText)?.[1]?.trim();
  if (!gitDir) return null;
  const worktreesDir = path.dirname(gitDir);
  const dotGitDir = path.dirname(worktreesDir);
  if (path.basename(worktreesDir) !== 'worktrees' || path.basename(dotGitDir) !== '.git') return null;
  return path.dirname(dotGitDir);
}

async function unregisterWorktrees(worktreesDir: string, git: RetiredWorktreeRemover, log: Pick<Console, 'warn'>): Promise<boolean> {
  const entries = await readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  let isEveryRegistrationGone = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const worktreePath = path.join(worktreesDir, entry.name);
    const projectPath = worktreeOwnerRepo(await readFile(path.join(worktreePath, '.git'), 'utf8').catch(() => ''));
    if (!projectPath) continue;
    const removal = await git.removeWorktreeByPath({ projectPath, cwd: worktreePath, cause: 'benchmark' }).catch((error: unknown) => ({ ok: false, err: errorMessage(error), removalKept: undefined }));
    if (removal.ok) continue;
    isEveryRegistrationGone = false;
    log.warn(`[race] kept the retired benchmark worktree ${worktreePath}: ${removal.removalKept ?? removal.err ?? 'git refused the removal'}`);
  }
  return isEveryRegistrationGone;
}

interface RetiredPath {
  retiredPath: string;
  kind: 'folder' | 'file';
  cause: RemovalCause;
  checkPassed: string;
}

async function sweepRetiredPath({ retiredPath, kind, cause, checkPassed }: RetiredPath, log: Pick<Console, 'warn'>): Promise<void> {
  const isPresent = await stat(retiredPath).then((stats) => (kind === 'folder' ? stats.isDirectory() : stats.isFile()), () => false);
  if (!isPresent) return;
  if (!(await recordSweptPath({ cause, kind, path: retiredPath, checksPassed: [checkPassed], log }))) return;
  await rm(retiredPath, { recursive: kind === 'folder', force: true }).catch((error: unknown) => {
    log.warn(`[retired] could not delete the retired ${kind} ${retiredPath}: ${errorMessage(error)}`);
  });
}

function retiredBenchmarkFolder(folderPath: string): RetiredPath {
  return { retiredPath: folderPath, kind: 'folder', cause: 'benchmark', checkPassed: 'benchmarks-lane-retired' };
}

async function deleteRetiredBenchmarkRuns(glimmervoidHome: string, git: RetiredWorktreeRemover, log: Pick<Console, 'warn'> = console): Promise<void> {
  await sweepRetiredPath(retiredBenchmarkFolder(path.join(glimmervoidHome, RETIRED_RUNS_FOLDER)), log);
  const suitesRoot = path.join(glimmervoidHome, SUITES_FOLDER);
  const suiteEntries = await readdir(suitesRoot, { withFileTypes: true }).catch(() => []);
  for (const suiteEntry of suiteEntries) {
    if (!suiteEntry.isDirectory()) continue;
    const suiteDir = path.join(suitesRoot, suiteEntry.name);
    for (const folderName of RETIRED_SUITE_FOLDERS) await sweepRetiredPath(retiredBenchmarkFolder(path.join(suiteDir, folderName)), log);
    if (await unregisterWorktrees(path.join(suiteDir, RETIRED_WORKTREES_FOLDER), git, log)) await sweepRetiredPath(retiredBenchmarkFolder(path.join(suiteDir, RETIRED_WORKTREES_FOLDER)), log);
  }
}

const PLAN_RECORD_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

async function deleteRetiredPlans(plansFolderPath: string, log: Pick<Console, 'warn'> = console): Promise<void> {
  const entries = await readdir(plansFolderPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !PLAN_RECORD_FILE_NAME.test(entry.name)) continue;
    const planPath = path.join(plansFolderPath, entry.name);
    if (!(await recordSweptPath({ cause: 'plan-review', kind: 'file', path: planPath, checksPassed: ['plan-view-retired'], log }))) continue;
    await rm(planPath, { force: true }).catch((error: unknown) => {
      log.warn(`[retired] could not delete the retired plan record ${planPath}: ${errorMessage(error)}`);
    });
  }
  if (entries.length > 0) await rmdir(plansFolderPath).catch(() => undefined);
}

function isRetiredIssuesCacheFile(fileName: string): boolean {
  if (fileName === RETIRED_ISSUES_CACHE_FILE) return true;
  if (!fileName.startsWith(`${RETIRED_ISSUES_CACHE_FILE}.`)) return false;
  return fileName.endsWith('.tmp') || fileName.includes('.corrupt-');
}

async function deleteRetiredIssuesCache(glimmervoidHome: string, log: Pick<Console, 'warn'> = console): Promise<void> {
  const entries = await readdir(glimmervoidHome, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !isRetiredIssuesCacheFile(entry.name)) continue;
    await sweepRetiredPath({ retiredPath: path.join(glimmervoidHome, entry.name), kind: 'file', cause: 'issues', checkPassed: 'issues-tab-retired' }, log);
  }
}

async function deleteRetiredRemoteSessionData(glimmervoidHome: string, agentLoginsFolderPath: string, log: Pick<Console, 'warn'> = console): Promise<void> {
  await sweepRetiredPath({ retiredPath: path.join(glimmervoidHome, RETIRED_CODER_OWNED_WORKSPACES_FILE), kind: 'file', cause: 'remote-sessions', checkPassed: 'remote-coder-sessions-retired' }, log);
  await sweepRetiredPath({ retiredPath: agentLoginsFolderPath, kind: 'folder', cause: 'remote-sessions', checkPassed: 'agent-connect-retired' }, log);
}

export { deleteRetiredBenchmarkRuns, deleteRetiredIssuesCache, deleteRetiredPlans, deleteRetiredRemoteSessionData };
