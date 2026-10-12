import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrepareSessionSandbox, SessionSandboxFacts } from '../session/sessions.ts';
import { rawTextOr } from '../shared/coerce.ts';
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
import { existingRealPath, readLaneCommonGitDir } from './work-lane.ts';

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

const UNWRAPPED_PLATFORM = 'win32';
const GITHUB_TOKEN_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 30_000;
const OPT_OUT_HINT = 'Mark the session or its repository unconfined to start it outside the sandbox.';

async function readGithubCliToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (rawTextOr(env.GH_TOKEN, null) || rawTextOr(env.GITHUB_TOKEN, null)) return null;
  const token = await execFileAsync('gh', ['auth', 'token'], { timeout: GITHUB_TOKEN_TIMEOUT_MS, encoding: 'utf8' }).then(({ stdout }) => stdout.trim(), () => '');
  return token || null;
}

async function gitCheckoutOf(folder: string): Promise<string | null> {
  const toplevel = await runHardenedGit(['rev-parse', '--show-toplevel'], { cwd: folder, timeout: GIT_TIMEOUT_MS }).then(({ stdout }) => stdout.trim(), () => '');
  return toplevel ? realpath(toplevel) : null;
}

async function workspaceMemberCheckouts(workspaceFolder: string): Promise<string[]> {
  const entries = await readdir(workspaceFolder, { withFileTypes: true });
  const memberFolders = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(workspaceFolder, entry.name));
  const gitPointers = await Promise.all(memberFolders.map((memberFolder) => existingRealPath(path.join(memberFolder, '.git'))));
  return memberFolders.filter((_memberFolder, index) => gitPointers[index] !== null);
}

async function sessionCheckouts(cwd: string, isWorkspace: boolean): Promise<string[]> {
  if (isWorkspace) return workspaceMemberCheckouts(cwd);
  const checkout = await gitCheckoutOf(cwd);
  return checkout === null ? [] : [checkout];
}

async function sharedFolderBehind(linkPath: string): Promise<string | null> {
  const linkStats = await lstat(linkPath).catch(() => null);
  if (!linkStats?.isSymbolicLink()) return null;
  const sharedPath = await existingRealPath(linkPath);
  if (sharedPath === null) return null;
  return (await stat(sharedPath)).isDirectory() ? sharedPath : null;
}

async function sharedFoldersOf(checkout: string, worktreeShare: readonly string[]): Promise<string[]> {
  const sharedEntries = worktreeShare.filter((entry) => !UNSHARED_WORKTREE_ENTRIES.includes(entry));
  const sharedFolders = await Promise.all(sharedEntries.map((entry) => sharedFolderBehind(path.join(checkout, entry))));
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
    const checkouts = await sessionCheckouts(cwd, isWorkspace);
    const commitCheckouts = await Promise.all(checkouts.map(async (checkout) => ({ checkout, gitDir: await readLaneCommonGitDir(checkout) })));
    const sharedFolders = (await Promise.all(checkouts.map((checkout) => sharedFoldersOf(checkout, settings.worktreeShare)))).flat();
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
        await recordClaudeFolderTrust(trustFolder);
        const prepared = await prepareSandbox({ role, launchId: facts.launchId, enterDir: cwd });
        if (!prepared.ok) return { ok: false, reason: `${prepared.reason}. ${OPT_OUT_HINT}` };
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
