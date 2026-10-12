import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrepareSessionSandbox, SessionSandboxFacts } from '../session/sessions.ts';
import { rawTextOr } from '../shared/coerce.ts';
import { isPathInside } from '../shared/paths.ts';
import { errorMessage } from '../shared/text.ts';
import { execFileAsync } from './child-process-safe.ts';
import { repositoryRootOfCommonGitDir } from './core/claude-trust-core.ts';
import type { SandboxRole } from './core/sandbox-policy-core.ts';
import { sessionRole, UNSHARED_WORKTREE_ENTRIES } from './core/sandbox-roles-core.ts';
import { expandTilde } from './core/usage-scan-core.ts';
import { runHardenedGit } from './git-workspace.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { prepareSandboxLaunch } from './sandbox-launch.ts';
import { existingRealPath, readGitDirsOfOwnCheckout } from './work-lane.ts';

interface SessionSandboxSettings {
  writablePaths: readonly string[];
  unreadablePaths: readonly string[];
  worktreeShare: readonly string[];
}

interface SessionSandboxRequest {
  sessionId: string;
  isWorkspace: boolean;
}

interface SessionSandboxDependencies {
  getSettings: () => SessionSandboxSettings;
  uploadsRoot: string;
  sandboxRefusal?: SandboxSpawnRefusal;
  prepareSandbox?: typeof prepareSandboxLaunch;
  trustClaudeFolder?: (folder: string) => Promise<unknown>;
  readGithubToken?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
}

type SessionSandbox = ReturnType<typeof createSessionSandbox>;
type CommitCheckout = SandboxRole['commitCheckouts'][number];

const UNWRAPPED_PLATFORM = 'win32';
const GITHUB_TOKEN_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 30_000;
const OPT_OUT_HINT = 'Mark the session or its repository unconfined to start it outside the sandbox.';

async function readGithubCliToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (rawTextOr(env.GH_TOKEN, null) || rawTextOr(env.GITHUB_TOKEN, null)) return null;
  const token = await execFileAsync('gh', ['auth', 'token'], { timeout: GITHUB_TOKEN_TIMEOUT_MS, encoding: 'utf8' }).then(({ stdout }) => stdout.trim(), () => '');
  return token || null;
}

async function gitCheckoutOf(startFolder: string): Promise<string | null> {
  const toplevel = await runHardenedGit(['rev-parse', '--show-toplevel'], { cwd: startFolder, timeout: GIT_TIMEOUT_MS }).then(({ stdout }) => stdout.trim(), () => '');
  if (!toplevel) return null;
  const checkout = await existingRealPath(toplevel);
  if (checkout === null || !isPathInside(checkout, startFolder)) return null;
  return checkout;
}

async function isRegisteredGitEntry(gitEntry: string, worktreeAdminDir: string): Promise<boolean> {
  const registeredGitEntry = await readFile(path.join(worktreeAdminDir, 'gitdir'), 'utf8')
    .then((registeredPath) => realpath(path.resolve(worktreeAdminDir, registeredPath.trim())))
    .catch(() => null);
  return registeredGitEntry === gitEntry;
}

async function ownGitDirOf(checkout: string, startFolder: string): Promise<string | null> {
  const gitDirs = await readGitDirsOfOwnCheckout(startFolder).catch(() => null);
  if (gitDirs === null) return null;
  const { commonGitDir, worktreeAdminDir } = gitDirs;
  const gitEntry = path.join(checkout, '.git');
  const gitEntryStats = await lstat(gitEntry).catch(() => null);
  if (gitEntryStats?.isDirectory()) return worktreeAdminDir === gitEntry && commonGitDir === gitEntry ? commonGitDir : null;
  const isLinkedWorktree = worktreeAdminDir !== commonGitDir;
  if (!gitEntryStats?.isFile() || !isLinkedWorktree) return null;
  const gitDirsOfCheckout = checkout === startFolder ? gitDirs : await readGitDirsOfOwnCheckout(checkout).catch(() => null);
  if (gitDirsOfCheckout?.worktreeAdminDir !== worktreeAdminDir) return null;
  return await isRegisteredGitEntry(gitEntry, worktreeAdminDir) ? commonGitDir : null;
}

async function commitCheckoutOf(startFolder: string): Promise<CommitCheckout | null> {
  const checkout = await gitCheckoutOf(startFolder);
  if (checkout === null) return null;
  const gitDir = await ownGitDirOf(checkout, startFolder);
  return gitDir === null ? null : { checkout, gitDir };
}

async function memberCommitCheckoutOf(memberFolder: string): Promise<CommitCheckout | null> {
  const commitCheckout = await commitCheckoutOf(memberFolder);
  return commitCheckout?.checkout === memberFolder ? commitCheckout : null;
}

async function workspaceMemberCheckouts(workspaceFolder: string): Promise<CommitCheckout[]> {
  const entries = await readdir(workspaceFolder, { withFileTypes: true });
  const memberFolders = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(workspaceFolder, entry.name));
  const gitPointers = await Promise.all(memberFolders.map((memberFolder) => existingRealPath(path.join(memberFolder, '.git'))));
  const commitCheckouts = await Promise.all(memberFolders.filter((_memberFolder, index) => gitPointers[index] !== null).map(memberCommitCheckoutOf));
  return commitCheckouts.filter((commitCheckout) => commitCheckout !== null);
}

async function sessionCheckouts(cwd: string, isWorkspace: boolean): Promise<CommitCheckout[]> {
  if (isWorkspace) return workspaceMemberCheckouts(cwd);
  const commitCheckout = await commitCheckoutOf(cwd);
  return commitCheckout === null ? [] : [commitCheckout];
}

async function sharedFolderBehind(linkPath: string, repositoryFolder: string): Promise<string | null> {
  const linkStats = await lstat(linkPath).catch(() => null);
  if (!linkStats?.isSymbolicLink()) return null;
  const sharedPath = await existingRealPath(linkPath);
  if (sharedPath !== repositoryFolder) return null;
  return (await stat(sharedPath)).isDirectory() ? sharedPath : null;
}

async function sharedFoldersOf({ checkout, gitDir }: SandboxRole['commitCheckouts'][number], worktreeShare: readonly string[]): Promise<string[]> {
  const repositoryRoot = repositoryRootOfCommonGitDir(gitDir);
  if (repositoryRoot === null) return [];
  const sharedEntries = worktreeShare.filter((entry) => !UNSHARED_WORKTREE_ENTRIES.includes(entry));
  const sharedFolders = await Promise.all(sharedEntries.map((entry) => sharedFolderBehind(path.join(checkout, entry), path.resolve(path.join(repositoryRoot, entry)))));
  return sharedFolders.filter((sharedFolder) => sharedFolder !== null);
}

async function existingRealPaths(candidates: readonly string[]): Promise<string[]> {
  const realPaths = await Promise.all(candidates.filter((candidate) => path.isAbsolute(candidate)).map(existingRealPath));
  return realPaths.filter((realPath) => realPath !== null);
}

function createSessionSandbox({
  getSettings, uploadsRoot, sandboxRefusal = allowSandboxedSpawn, prepareSandbox = prepareSandboxLaunch, trustClaudeFolder, platform = process.platform,
  homeDir = os.homedir(), env = process.env, readGithubToken = () => readGithubCliToken(env), log = console,
}: SessionSandboxDependencies) {
  const expandHome = (candidates: readonly string[]) => candidates.map((candidate) => expandTilde(candidate.trim(), env, homeDir)).filter(Boolean);
  const githubCliConfigDir = () => rawTextOr(env.GH_CONFIG_DIR, null) ?? path.join(rawTextOr(env.XDG_CONFIG_HOME, null) ?? path.join(homeDir, '.config'), 'gh');

  async function describeSessionAccess(facts: SessionSandboxFacts, { sessionId, isWorkspace }: SessionSandboxRequest): Promise<{ role: SandboxRole; cwd: string; trustFolder: string }> {
    const settings = getSettings();
    const sessionUploads = path.join(uploadsRoot, sessionId);
    await mkdir(sessionUploads, { recursive: true });
    const cwd = await realpath(facts.cwd);
    const commitCheckouts = await sessionCheckouts(cwd, isWorkspace);
    const sharedFolders = (await Promise.all(commitCheckouts.map((commitCheckout) => sharedFoldersOf(commitCheckout, settings.worktreeShare)))).flat();
    const startFolderRoots = commitCheckouts.length === 0 ? [cwd] : [];
    const ownRepositoryRoot = isWorkspace || commitCheckouts[0] === undefined ? null : repositoryRootOfCommonGitDir(commitCheckouts[0].gitDir);
    return {
      cwd,
      trustFolder: ownRepositoryRoot ?? cwd,
      role: sessionRole({
        commitCheckouts,
        writableRoots: [...startFolderRoots, ...sharedFolders, ...await existingRealPaths(expandHome(settings.writablePaths))],
        readDenied: expandHome(settings.unreadablePaths).filter((unreadablePath) => path.isAbsolute(unreadablePath)),
        readablePaths: [...facts.readablePaths, ...await existingRealPaths([sessionUploads, githubCliConfigDir()])],
      }),
    };
  }

  async function recordClaudeFolderTrust(folder: string): Promise<void> {
    if (!trustClaudeFolder) return;
    await trustClaudeFolder(folder).catch((error: unknown) => log.warn(`[sandbox] ${errorMessage(error)}`));
  }

  function prepareFor(request: SessionSandboxRequest): PrepareSessionSandbox | null {
    if (platform === UNWRAPPED_PLATFORM) return null;
    return async (facts) => {
      const sandboxRefusalReason = sandboxRefusal();
      if (sandboxRefusalReason !== null) return { ok: false, reason: `${sandboxRefusalReason} ${OPT_OUT_HINT}` };
      try {
        const { role, cwd, trustFolder } = await describeSessionAccess(facts, request);
        const prepared = await prepareSandbox({ role, launchId: facts.launchId, enterDir: cwd });
        if (!prepared.ok) return { ok: false, reason: `${prepared.reason}. ${OPT_OUT_HINT}` };
        await recordClaudeFolderTrust(trustFolder);
        const githubToken = await readGithubToken();
        if (githubToken === null) return prepared;
        return { ok: true, launch: { ...prepared.launch, env: { ...prepared.launch.env, GH_TOKEN: githubToken } } };
      } catch (error) {
        return { ok: false, reason: errorMessage(error) };
      }
    };
  }

  return { prepareFor };
}

export { createSessionSandbox };
export type { SessionSandbox, SessionSandboxDependencies, SessionSandboxSettings };
