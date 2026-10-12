import fs from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { errorMessage, isMissingFileError } from '../shared/text.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { buildLanePosture, isWorktreeAdminDirOf, LANE_READABLE_HOME_FOLDERS, parseGitdirPointer } from './core/lane-posture-core.ts';
import type { LanePostureSpec } from './core/lane-posture-core.ts';
import { runHardenedGit } from './git-workspace.ts';
import { resolveRequiredSaneYoloHookTools } from './hook-tools.ts';

export type LanePostureInput = Omit<LanePostureSpec, 'network'> & {
  cwd: string;
  deferWorktree?: boolean;
  network: { domains: readonly string[] };
  getHookPort: () => number | null;
};

type LanePostureDependencies = {
  hookToolConfig?: { rtk?: boolean };
  resolveSaneYoloHookTools?: (config: { rtk?: boolean }) => ResolvedHookTool[] | null;
  homeDir?: string;
};

async function existingRealPath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return null;
  }
}

async function resolvePrivateHomePaths(homeDir: string): Promise<{ privateHome?: string; privateHomeToolFolders?: string[] }> {
  const privateHome = await existingRealPath(homeDir);
  if (!privateHome) return {};
  const toolFolders = await Promise.all(LANE_READABLE_HOME_FOLDERS.map((folder) => existingRealPath(path.join(privateHome, folder))));
  return { privateHome, privateHomeToolFolders: toolFolders.filter((folder) => folder !== null) };
}

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
  hookToolConfig = {}, resolveSaneYoloHookTools = resolveRequiredSaneYoloHookTools, homeDir = glimmervoidHomeDir(),
}: LanePostureDependencies = {}) {
  const hookTools = resolveSaneYoloHookTools(hookToolConfig);
  if (!hookTools?.some((tool) => tool.id === 'saneYolo')) return { ok: false as const, reason: 'Sane YOLO is unavailable' };
  try {
    const port = input.getHookPort();
    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false as const, reason: 'Hook listener port is unavailable' };
    const cwd = await realpath(input.cwd);
    const [writableRoots, tempDir, privateHomePaths] = await Promise.all([
      Promise.all(input.writableRoots.map((root) => realpath(root))), realpath(os.tmpdir()), resolvePrivateHomePaths(homeDir),
    ]);
    const spec: LanePostureSpec = { ...input, writableRoots, network: { hookEndpoint: { host: '127.0.0.1', port }, domains: input.network.domains } };
    let commonGitDir: string | undefined;
    if (input.access !== 'read-only' || input.deferWorktree || await hasGitDirectory(cwd)) {
      commonGitDir = await readLaneCommonGitDir(cwd);
      const { stdout: adminPath } = await runHardenedGit(['rev-parse', '--absolute-git-dir'], { cwd, timeout: 30_000 });
      const worktreeAdminDir = await realpath(adminPath.trim());
      const isLinkedWorktree = worktreeAdminDir !== commonGitDir;
      if (isLinkedWorktree && !isWorktreeAdminDirOf({ adminDir: worktreeAdminDir, commonGitDir })) throw new Error('Git admin directory is outside the linked worktree registry');
    }
    const posture = buildLanePosture(spec, { tempDir, commonGitDir, cwd, ...privateHomePaths });
    const { requiresSaneYolo: _requiresSaneYolo, ...sessionOverrides } = posture;
    const scopeWorktree = ({ worktreeDir, branch, base }: { worktreeDir: string; branch: string | null; base: string | null }): void => {
      if (!input.deferWorktree || !commonGitDir) throw new Error('Deferred worktree access was not requested');
      if (!branch) throw new Error('Worktree branch is invalid');
      if (!base || branch === base) throw new Error('Worktree integration branch is invalid');
      const gitdir = parseGitdirPointer(fs.readFileSync(path.join(worktreeDir, '.git'), 'utf8'));
      if (!gitdir) throw new Error('Checkout is not a linked worktree');
      if (!isWorktreeAdminDirOf({ adminDir: fs.realpathSync(gitdir), commonGitDir })) throw new Error('Worktree belongs to a different repository');
      const scopedPosture = buildLanePosture({ ...spec, writableRoots: [fs.realpathSync(worktreeDir)] }, { tempDir, commonGitDir, ...privateHomePaths });
      Object.assign(sessionOverrides.settingsSandbox, scopedPosture.settingsSandbox);
      Object.assign(sessionOverrides.settingsPermissions, scopedPosture.settingsPermissions);
    };
    return { ok: true as const, sessionOverrides: { ...sessionOverrides, hookTools, getHookTools: null }, scopeWorktree };
  } catch (error) {
    return { ok: false as const, reason: errorMessage(error) };
  }
}
