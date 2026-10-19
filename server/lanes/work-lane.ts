import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PrepareSessionGuardrails, SessionGuardrailsFacts } from '../../session/sessions.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import type { GuardrailsRole } from '../guardrails/core/guardrails-policy-core.ts';
import { isWorktreeAdminDirOf } from '../guardrails/core/guardrails-roles-core.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { allowGuardedSpawn } from '../guardrails/guardrails-deps.ts';
import type { GuardrailsSpawnRefusal } from '../guardrails/guardrails-deps.ts';
import { prepareGuardrailsLaunch } from '../guardrails/guardrails-launch.ts';

const UNWRAPPED_PLATFORM = 'win32';

export type RoleGuardrailsDependencies = {
  prepareGuardrails?: typeof prepareGuardrailsLaunch;
  guardrailsRefusal?: GuardrailsSpawnRefusal;
  platform?: NodeJS.Platform;
};

export function prepareRoleGuardrails(describeRole: (facts: SessionGuardrailsFacts) => GuardrailsRole | Promise<GuardrailsRole>, {
  prepareGuardrails = prepareGuardrailsLaunch, guardrailsRefusal = allowGuardedSpawn, platform = process.platform,
}: RoleGuardrailsDependencies = {}): PrepareSessionGuardrails | null {
  if (platform === UNWRAPPED_PLATFORM) return null;
  return async (facts) => {
    const guardrailsRefusalReason = guardrailsRefusal();
    if (guardrailsRefusalReason !== null) return { ok: false, reason: guardrailsRefusalReason };
    try {
      return await prepareGuardrails({ role: await describeRole(facts), launchId: facts.launchId });
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  };
}

async function existingRealPath(candidate: string): Promise<string | null> {
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
