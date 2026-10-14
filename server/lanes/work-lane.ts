import fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import type { PrepareSessionSandbox, SessionSandboxFacts } from '../../session/sessions.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { LANE_ENVIRONMENT_ARGS, buildShellLanePermissions } from './core/lane-permissions-core.ts';
import type { SandboxRole } from '../core/sandbox-policy-core.ts';
import { isWorktreeAdminDirOf, LANE_CREDENTIAL_ENV, LANE_READABLE_HOME_FOLDERS, parseGitdirPointer, workRole } from '../core/sandbox-roles-core.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import { allowSandboxedSpawn } from '../sandbox-deps.ts';
import type { SandboxSpawnRefusal } from '../sandbox-deps.ts';
import { prepareSandboxLaunch } from '../sandbox-launch.ts';

const UNWRAPPED_PLATFORM = 'win32';
const GUARD_HOOK_UNAVAILABLE_ERROR = 'Sane YOLO is unavailable';

export type WorkLaneInput = {
  cwd: string;
  deferWorktree?: boolean;
  allowCommands: readonly string[];
  extraDeny: readonly string[];
};

export type WorkLaneDependencies = {
  hookToolConfig?: { rtk?: boolean };
  resolveSaneYoloHookTools?: (config: { rtk?: boolean }) => ResolvedHookTool[] | null;
  homeDir?: string;
  prepareSandbox?: typeof prepareSandboxLaunch;
  sandboxRefusal?: SandboxSpawnRefusal;
  platform?: NodeJS.Platform;
};

export type RoleSandboxDependencies = Pick<WorkLaneDependencies, 'prepareSandbox' | 'sandboxRefusal' | 'platform'>;

type ScopedWorktree = { worktreeDir: string; branch: string | null; base: string | null };

export function prepareRoleSandbox(describeRole: (facts: SessionSandboxFacts) => SandboxRole | Promise<SandboxRole>, {
  prepareSandbox = prepareSandboxLaunch, sandboxRefusal = allowSandboxedSpawn, platform = process.platform,
}: RoleSandboxDependencies = {}): PrepareSessionSandbox | null {
  if (platform === UNWRAPPED_PLATFORM) return null;
  return async (facts) => {
    const sandboxRefusalReason = sandboxRefusal();
    if (sandboxRefusalReason !== null) return { ok: false, reason: sandboxRefusalReason };
    try {
      return await prepareSandbox({ role: await describeRole(facts), launchId: facts.launchId });
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  };
}

export async function existingRealPath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return null;
  }
}

export async function existingRealPaths(candidates: readonly string[]): Promise<string[]> {
  const realPaths = await Promise.all(candidates.filter((candidate) => path.isAbsolute(candidate)).map(existingRealPath));
  return realPaths.filter((realPath) => realPath !== null);
}

function readableToolFolders(homeDir: string): Promise<string[]> {
  return existingRealPaths(LANE_READABLE_HOME_FOLDERS.map((folder) => path.join(homeDir, folder)));
}

export async function readLaneCommonGitDir(cwd: string): Promise<string> {
  const { stdout } = await runHardenedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 30_000 });
  return realpath(stdout.trim());
}

export async function readGitDirsOfOwnCheckout(cwd: string): Promise<{ commonGitDir: string; worktreeAdminDir: string }> {
  const commonGitDir = await readLaneCommonGitDir(cwd);
  const { stdout: adminPath } = await runHardenedGit(['rev-parse', '--absolute-git-dir'], { cwd, timeout: 30_000 });
  const worktreeAdminDir = await realpath(adminPath.trim());
  const isLinkedWorktree = worktreeAdminDir !== commonGitDir;
  if (isLinkedWorktree && !isWorktreeAdminDirOf({ adminDir: worktreeAdminDir, commonGitDir })) throw new Error('Git admin directory is outside the linked worktree registry');
  return { commonGitDir, worktreeAdminDir };
}

export async function resolveWorkLane(input: WorkLaneInput, {
  hookToolConfig = {}, resolveSaneYoloHookTools = resolveRequiredSaneYoloHookTools, homeDir = glimmervoidHomeDir(),
  prepareSandbox = prepareSandboxLaunch, sandboxRefusal = allowSandboxedSpawn, platform = process.platform,
}: WorkLaneDependencies = {}) {
  if (platform === UNWRAPPED_PLATFORM) return { ok: false as const, reason: `the sandbox runtime does not run on ${platform}` };
  const sandboxRefusalReason = sandboxRefusal();
  if (sandboxRefusalReason !== null) return { ok: false as const, reason: sandboxRefusalReason };
  const hookTools = resolveSaneYoloHookTools(hookToolConfig);
  if (!hookTools?.some((tool) => tool.id === 'saneYolo')) return { ok: false as const, reason: GUARD_HOOK_UNAVAILABLE_ERROR };
  try {
    const cwd = await realpath(input.cwd);
    const [{ commonGitDir }, toolFolders] = await Promise.all([readGitDirsOfOwnCheckout(cwd), readableToolFolders(homeDir)]);
    const permissionsFor = (editableRoots: readonly string[]) => buildShellLanePermissions({ editableRoots, allowCommands: input.allowCommands, extraDeny: input.extraDeny });
    let checkout = input.deferWorktree ? null : cwd;
    const settingsPermissions = permissionsFor(checkout === null ? [] : [checkout]);
    const scopeWorktree = ({ worktreeDir, branch, base }: ScopedWorktree): void => {
      if (!input.deferWorktree) throw new Error('Deferred worktree access was not requested');
      if (!branch) throw new Error('Worktree branch is invalid');
      if (!base || branch === base) throw new Error('Worktree integration branch is invalid');
      const gitdir = parseGitdirPointer(fs.readFileSync(path.join(worktreeDir, '.git'), 'utf8'));
      if (!gitdir) throw new Error('Checkout is not a linked worktree');
      if (!isWorktreeAdminDirOf({ adminDir: fs.realpathSync(gitdir), commonGitDir })) throw new Error('Worktree belongs to a different repository');
      checkout = fs.realpathSync(worktreeDir);
      Object.assign(settingsPermissions, permissionsFor([checkout]));
    };
    const prepareSessionSandbox: PrepareSessionSandbox = async (facts) => {
      if (checkout === null) return { ok: false, reason: 'the lane worktree was never scoped' };
      return prepareSandbox({
        role: workRole({ vendor: 'claude', cwd: facts.cwd, checkout, agentSessionId: facts.agentSessionId, readablePaths: [...facts.readablePaths, ...toolFolders], writablePaths: await existingRealPaths(facts.writablePaths) }),
        launchId: facts.launchId,
      });
    };
    return {
      ok: true as const,
      sessionOverrides: {
        settingsPermissions, extraClaudeArgs: [...LANE_ENVIRONMENT_ARGS], spawnEnv: { ...LANE_CREDENTIAL_ENV },
        hookTools, getHookTools: null, prepareSandbox: prepareSessionSandbox,
      },
      scopeWorktree,
    };
  } catch (error) {
    return { ok: false as const, reason: errorMessage(error) };
  }
}
