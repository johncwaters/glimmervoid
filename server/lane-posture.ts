import fs from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { buildLanePosture, isSafeBranchName, isWorktreeAdminDirOf, parseGitdirPointer } from './core/lane-posture-core.ts';
import type { LanePostureSpec } from './core/lane-posture-core.ts';
import { createGitWorkspace, runHardenedGit } from './git-workspace.ts';
import { resolveRequiredSaneYoloHookTools } from './hook-tools.ts';

export type LanePostureInput = Omit<LanePostureSpec, 'gitCommit' | 'network'> & {
  cwd: string;
  gitCommit?: boolean;
  deferWorktree?: boolean;
  integrationBranch?: string | null;
  network: { domains: readonly string[] };
  getHookPort: () => number | null;
};

type LanePostureDependencies = {
  hookToolConfig?: { rtk?: boolean };
  resolveSaneYoloHookTools?: (config: { rtk?: boolean }) => ResolvedHookTool[] | null;
};

export async function readLaneCommonGitDir(cwd: string): Promise<string> {
  const { stdout } = await runHardenedGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 30_000 });
  return realpath(stdout.trim());
}

async function hasGitDirectory(cwd: string): Promise<boolean> {
  let directory = cwd;
  for (;;) {
    try {
      await access(path.join(directory, '.git'));
      return true;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

export async function resolveLanePosture(input: LanePostureInput, {
  hookToolConfig = {}, resolveSaneYoloHookTools = resolveRequiredSaneYoloHookTools,
}: LanePostureDependencies = {}) {
  const hookTools = resolveSaneYoloHookTools(hookToolConfig);
  if (!hookTools?.some((tool) => tool.id === 'saneYolo')) return { ok: false as const, reason: 'Sane YOLO is unavailable' };
  try {
    const port = input.getHookPort();
    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false as const, reason: 'Hook listener port is unavailable' };
    const cwd = await realpath(input.cwd);
    const [writableRoots, tempDir] = await Promise.all([
      Promise.all(input.writableRoots.map((root) => realpath(root))), realpath(os.tmpdir()),
    ]);
    const spec: LanePostureSpec = { ...input, writableRoots, gitCommit: undefined, network: { hookEndpoint: { host: '127.0.0.1', port }, domains: input.network.domains } };
    let commonDir: string | undefined;
    let gitWorktree: { commonDir: string; integrationBranch: string } | undefined;
    if (input.access !== 'read-only' || input.gitCommit || input.deferWorktree || await hasGitDirectory(cwd)) {
      commonDir = await readLaneCommonGitDir(cwd);
      const { stdout: adminPath } = await runHardenedGit(['rev-parse', '--absolute-git-dir'], { cwd, timeout: 30_000 });
      const worktreeAdminDir = await realpath(adminPath.trim());
      const isLinkedWorktree = worktreeAdminDir !== commonDir;
      if (isLinkedWorktree && !isWorktreeAdminDirOf({ adminDir: worktreeAdminDir, commonGitDir: commonDir })) throw new Error('Git admin directory is outside the linked worktree registry');
      if (isLinkedWorktree || input.deferWorktree) {
        const integrationBranch = input.integrationBranch ?? await createGitWorkspace().detectDefaultBranch({ projectPath: cwd });
        if (!integrationBranch || !isSafeBranchName(integrationBranch)) throw new Error('Linked worktree integration branch is unavailable');
        gitWorktree = { commonDir, integrationBranch };
      }
      if (input.gitCommit && !input.deferWorktree) {
        if (!isLinkedWorktree) throw new Error('Git commit access requires a linked worktree');
        const { stdout: branchName } = await runHardenedGit(['symbolic-ref', '--short', 'HEAD'], { cwd, timeout: 30_000 });
        const branch = branchName.trim();
        if (!isSafeBranchName(branch)) throw new Error('Git commit branch is invalid');
        if (branch === gitWorktree?.integrationBranch) throw new Error('Git commit branch is the integration branch');
        spec.gitCommit = { commonDir, worktreeAdminDir, branch };
      }
    }
    const posture = buildLanePosture(spec, { tempDir, gitWorktree, cwd });
    const { requiresSaneYolo: _requiresSaneYolo, ...sessionOverrides } = posture;
    const scopeWorktree = ({ worktreeDir, branch, base }: { worktreeDir: string; branch: string | null; base: string | null }): void => {
      if (!input.deferWorktree || !commonDir) throw new Error('Deferred worktree access was not requested');
      if (!branch || !isSafeBranchName(branch)) throw new Error('Worktree branch is invalid');
      if (!base || !isSafeBranchName(base) || branch === base) throw new Error('Worktree integration branch is invalid');
      const gitdir = parseGitdirPointer(fs.readFileSync(path.join(worktreeDir, '.git'), 'utf8'));
      if (!gitdir) throw new Error('Checkout is not a linked worktree');
      const worktreeAdminDir = fs.realpathSync(gitdir);
      if (!isWorktreeAdminDirOf({ adminDir: worktreeAdminDir, commonGitDir: commonDir })) throw new Error('Worktree belongs to a different repository');
      const worktreePath = fs.realpathSync(worktreeDir);
      const scopedPosture = buildLanePosture({ ...spec, writableRoots: [worktreePath], gitCommit: { commonDir, worktreeAdminDir, branch } },
        { tempDir, gitWorktree: { commonDir, integrationBranch: base } });
      Object.assign(sessionOverrides.settingsSandbox, scopedPosture.settingsSandbox);
      Object.assign(sessionOverrides.settingsPermissions, scopedPosture.settingsPermissions);
    };
    return { ok: true as const, sessionOverrides: { ...sessionOverrides, hookTools, getHookTools: null }, scopeWorktree };
  } catch (error) {
    return { ok: false as const, reason: errorMessage(error) };
  }
}
