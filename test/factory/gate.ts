import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { isPathInside } from '../../shared/paths.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { resolveInside } from './cleanup.ts';
import { hasOnlyLocalOrigin } from './verdict.ts';
import type { GateEvidence, GateRemote, RealCommits } from './verdict.ts';
import type { BatchSnapshot, SeededTarget } from './seed.ts';

export async function runGit(directory: string, argumentsPassed: string[], signal?: AbortSignal): Promise<string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return (await execFileAsync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...argumentsPassed], {
    env: environment, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, signal,
  })).stdout.trim();
}

export async function readRealCommits(repositoryPath: string): Promise<RealCommits> {
  const [main, originMain] = await Promise.all(['refs/heads/main', 'refs/remotes/origin/main'].map((revision) => runGit(repositoryPath, ['rev-parse', '--verify', revision])));
  if (!main || !originMain) throw new Error('Cannot read real main and origin/main');
  return { main, originMain };
}

async function localRemotePath(repositoryPath: string, url: string): Promise<string | null> {
  try {
    if (url.startsWith('file://')) return await realpath(fileURLToPath(url));
    if (/^[\w+.-]+:/.test(url)) return null;
    return await realpath(path.resolve(repositoryPath, url));
  } catch { return null; }
}

export async function readRemotes(repositoryPath: string): Promise<GateRemote[]> {
  const names = (await runGit(repositoryPath, ['remote'])).split('\n').filter(Boolean);
  return Promise.all(names.map(async (name) => {
    const fetchUrls = (await runGit(repositoryPath, ['remote', 'get-url', '--all', name])).split('\n');
    const pushUrls = (await runGit(repositoryPath, ['remote', 'get-url', '--push', '--all', name])).split('\n');
    const resolvedFetchPaths = await Promise.all(fetchUrls.map((url) => localRemotePath(repositoryPath, url)));
    const resolvedPushPaths = await Promise.all(pushUrls.map((url) => localRemotePath(repositoryPath, url)));
    return { name, fetchUrls, pushUrls, resolvedFetchPaths, resolvedPushPaths };
  }));
}

const RUN_COMMIT_CHECK_LIMIT = 200;

async function gitExitCode(repositoryPath: string, argumentsPassed: string[]): Promise<number> {
  try {
    await runGit(repositoryPath, argumentsPassed);
    return 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') return error.code;
    throw error;
  }
}

async function hasCommit(repositoryPath: string, sha: string): Promise<boolean> {
  if (await gitExitCode(repositoryPath, ['cat-file', '-e', `${sha}^{commit}`]) === 0) return true;
  if (await gitExitCode(repositoryPath, ['cat-file', '-e', sha]) === 1) return false;
  throw new Error(`Cannot tell whether commit ${sha} exists in ${repositoryPath}`);
}

async function listRunCommits(originPath: string, snapshotRefCommits: string[]): Promise<string[]> {
  const listed = await runGit(originPath, ['--git-dir', originPath, 'rev-list', `--max-count=${RUN_COMMIT_CHECK_LIMIT + 1}`, '--all', '--not', ...snapshotRefCommits]);
  return listed.split('\n').filter(Boolean);
}

async function findLeakedCommits(realRepositoryPath: string, runCommits: string[]): Promise<string[]> {
  const leakedCommits: string[] = [];
  for (const sha of runCommits) if (await hasCommit(realRepositoryPath, sha)) leakedCommits.push(sha);
  return leakedCommits;
}

async function readWorkingCloneRemotes(projectPath: string): Promise<GateRemote[]> {
  await lstat(path.join(projectPath, '.git'));
  return readRemotes(projectPath);
}

export async function readGateProof(
  realRepositoryPath: string, originPath: string | null, projectPath: string | null, snapshotRefCommits: string[],
): Promise<Pick<GateEvidence, 'originPath' | 'after' | 'remotes' | 'leakedCommits' | 'isCommitListCapped' | 'proofErrors'>> {
  const proofErrors: string[] = [];
  const attempt = async <Evidence>(read: () => Promise<Evidence>): Promise<Evidence | null> => {
    try { return await read(); }
    catch (error) {
      proofErrors.push(errorMessage(error));
      return null;
    }
  };
  const after = await attempt(() => readRealCommits(realRepositoryPath)) ?? { main: null, originMain: null };
  const canonicalOriginPath = originPath ? await attempt(() => realpath(originPath)) : null;
  const remotes = projectPath ? await attempt(() => readWorkingCloneRemotes(projectPath)) : null;
  const runCommits = canonicalOriginPath ? await attempt(() => listRunCommits(canonicalOriginPath, snapshotRefCommits)) : null;
  const leakedCommits = runCommits ? await attempt(() => findLeakedCommits(realRepositoryPath, runCommits.slice(0, RUN_COMMIT_CHECK_LIMIT))) : null;
  return { originPath: canonicalOriginPath, after, remotes, leakedCommits, isCommitListCapped: (runCommits?.length ?? 0) > RUN_COMMIT_CHECK_LIMIT, proofErrors };
}

async function assertNoAlternates(repositoryPath: string): Promise<void> {
  const alternatesPath = await runGit(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects/info/alternates']);
  try { await lstat(alternatesPath); }
  catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
  throw new Error(`git alternates found in ${repositoryPath}`);
}

async function collectFileLinks(repositoryPath: string, directory: string, linksByInode: Map<string, { count: number; linkCount: number; filePath: string }>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      if (!isPathInside(repositoryPath, await realpath(entryPath))) throw new Error(`external link at ${entryPath}`);
      continue;
    }
    if (metadata.isFile() && metadata.nlink > 1) {
      const inodeKey = `${metadata.dev}:${metadata.ino}`;
      const fileLinks = linksByInode.get(inodeKey) ?? { count: 0, linkCount: metadata.nlink, filePath: entryPath };
      fileLinks.count++;
      linksByInode.set(inodeKey, fileLinks);
    }
    if (metadata.isDirectory()) await collectFileLinks(repositoryPath, entryPath, linksByInode);
  }
}

async function assertIndependentFiles(repositoryPath: string): Promise<void> {
  const linksByInode = new Map<string, { count: number; linkCount: number; filePath: string }>();
  await collectFileLinks(repositoryPath, repositoryPath, linksByInode);
  for (const { count, linkCount, filePath } of linksByInode.values()) {
    if (count !== linkCount) throw new Error(`external hard link at ${filePath}`);
  }
}

export async function checkGate(target: SeededTarget, snapshot: BatchSnapshot): Promise<void> {
  try {
    await resolveInside(snapshot.batchDirectory, snapshot.snapshotPath);
    await resolveInside(target.runDirectory, target.projectPath);
    const originPath = await realpath(await resolveInside(target.runDirectory, target.originPath));
    if (!hasOnlyLocalOrigin(await readRemotes(target.projectPath), originPath)) throw new Error('working clone must have exactly one remote named origin pointing only to its per-run origin');
    for (const repositoryPath of [target.originPath, snapshot.snapshotPath]) {
      if ((await readRemotes(repositoryPath)).length !== 0) throw new Error(`bare repository has remotes: ${repositoryPath}`);
    }
    for (const repositoryPath of [target.projectPath, target.originPath, snapshot.snapshotPath]) await assertNoAlternates(repositoryPath);
    const modulesPath = path.join(target.projectPath, 'node_modules');
    if (!(await lstat(modulesPath)).isDirectory()) throw new Error('node_modules must be a real directory inside the working clone');
    await resolveInside(target.projectPath, modulesPath);
    for (const repositoryPath of [target.projectPath, target.originPath, snapshot.snapshotPath]) await assertIndependentFiles(await realpath(repositoryPath));
  } catch (error) {
    throw new Error(`Gate refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
