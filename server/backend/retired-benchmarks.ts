import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../../shared/text.ts';
import { recordSweptPath } from '../removal-journal.ts';

const RETIRED_RUNS_FOLDER = 'benchmark-runs';
const SUITES_FOLDER = 'benchmarks';
const RETIRED_SUITE_FOLDERS: readonly string[] = Object.freeze(['runs', 'work']);
const RETIRED_WORKTREES_FOLDER = 'worktrees';

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

async function sweepFolder(folderPath: string, log: Pick<Console, 'warn'>): Promise<void> {
  const isPresent = await stat(folderPath).then((stats) => stats.isDirectory(), () => false);
  if (!isPresent) return;
  if (!(await recordSweptPath({ cause: 'benchmark', kind: 'folder', path: folderPath, checksPassed: ['benchmarks-lane-retired'], log }))) return;
  await rm(folderPath, { recursive: true, force: true }).catch((error: unknown) => {
    log.warn(`[race] could not delete the retired benchmark folder ${folderPath}: ${errorMessage(error)}`);
  });
}

async function deleteRetiredBenchmarkRuns(glimmervoidHome: string, git: RetiredWorktreeRemover, log: Pick<Console, 'warn'> = console): Promise<void> {
  await sweepFolder(path.join(glimmervoidHome, RETIRED_RUNS_FOLDER), log);
  const suitesRoot = path.join(glimmervoidHome, SUITES_FOLDER);
  const suiteEntries = await readdir(suitesRoot, { withFileTypes: true }).catch(() => []);
  for (const suiteEntry of suiteEntries) {
    if (!suiteEntry.isDirectory()) continue;
    const suiteDir = path.join(suitesRoot, suiteEntry.name);
    for (const folderName of RETIRED_SUITE_FOLDERS) await sweepFolder(path.join(suiteDir, folderName), log);
    if (await unregisterWorktrees(path.join(suiteDir, RETIRED_WORKTREES_FOLDER), git, log)) await sweepFolder(path.join(suiteDir, RETIRED_WORKTREES_FOLDER), log);
  }
}

export { deleteRetiredBenchmarkRuns };
