import { mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrepareSessionSandbox, SessionSandboxFacts } from '../../session/sessions.ts';
import { rawTextOr } from '../../shared/coerce.ts';
import { errorMessage } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { repositoryRootOfCommonGitDir } from '../core/claude-trust-core.ts';
import type { SandboxRole } from './core/sandbox-policy-core.ts';
import { sessionRole } from './core/sandbox-roles-core.ts';
import { expandTilde } from '../usage/core/usage-scan-core.ts';
import { allowSandboxedSpawn } from './sandbox-deps.ts';
import type { SandboxSpawnRefusal } from './sandbox-deps.ts';
import { prepareSandboxLaunch } from './sandbox-launch.ts';
import { existingRealPaths, readGitDirsOfOwnCheckout } from '../lanes/work-lane.ts';

interface SessionSandboxSettings {
  blockedPaths: readonly string[];
  unreadablePaths: readonly string[];
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
const OPT_OUT_HINT = 'Mark the session or its repository unguarded to start it without guardrails.';

async function readGithubCliToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (rawTextOr(env.GH_TOKEN, null) || rawTextOr(env.GITHUB_TOKEN, null)) return null;
  const token = await execFileAsync('gh', ['auth', 'token'], { timeout: GITHUB_TOKEN_TIMEOUT_MS, encoding: 'utf8' }).then(({ stdout }) => stdout.trim(), () => '');
  return token || null;
}

async function repositoryRootOf(cwd: string): Promise<string | null> {
  const gitDirs = await readGitDirsOfOwnCheckout(cwd).catch(() => null);
  return gitDirs === null ? null : repositoryRootOfCommonGitDir(gitDirs.commonGitDir);
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
    const ownRepositoryRoot = isWorkspace ? null : await repositoryRootOf(cwd);
    const expandedBlockedPaths = expandHome(settings.blockedPaths);
    const ignoredBlockedPaths = expandedBlockedPaths.filter((blockedPath) => !path.isAbsolute(blockedPath));
    if (ignoredBlockedPaths.length > 0) log.warn(`[guardrails] ignoring guardrails.blockedPaths entries that are not absolute paths: ${ignoredBlockedPaths.join(', ')}`);
    return {
      cwd,
      trustFolder: ownRepositoryRoot ?? cwd,
      role: sessionRole({
        writableRoots: await existingRealPaths(facts.writablePaths),
        readDenied: expandHome(settings.unreadablePaths).filter((unreadablePath) => path.isAbsolute(unreadablePath)),
        blockedPaths: expandedBlockedPaths.filter((blockedPath) => path.isAbsolute(blockedPath)),
        readablePaths: [...facts.readablePaths, ...await existingRealPaths([sessionUploads, githubCliConfigDir()])],
      }),
    };
  }

  async function recordClaudeFolderTrust(folder: string): Promise<void> {
    if (!trustClaudeFolder) return;
    await trustClaudeFolder(folder).catch((error: unknown) => log.warn(`[guardrails] ${errorMessage(error)}`));
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
