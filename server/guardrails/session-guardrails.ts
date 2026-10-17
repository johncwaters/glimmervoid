import { mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrepareSessionGuardrails, SessionGuardrailsFacts } from '../../session/sessions.ts';
import { rawTextOr } from '../../shared/coerce.ts';
import { errorMessage } from '../../shared/text.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { repositoryRootOfCommonGitDir } from '../core/claude-trust-core.ts';
import type { GuardrailsRole } from './core/guardrails-policy-core.ts';
import { sessionRole } from './core/guardrails-roles-core.ts';
import { expandTilde } from '../usage/core/usage-scan-core.ts';
import { allowGuardedSpawn } from './guardrails-deps.ts';
import type { GuardrailsSpawnRefusal } from './guardrails-deps.ts';
import { prepareGuardrailsLaunch } from './guardrails-launch.ts';
import { existingRealPaths, readGitDirsOfOwnCheckout } from '../lanes/work-lane.ts';

interface SessionGuardrailsSettings {
  blockedPaths: readonly string[];
  unreadablePaths: readonly string[];
}

interface SessionGuardrailsRequest {
  sessionId: string;
  isWorkspace: boolean;
}

interface SessionGuardrailsDependencies {
  getSettings: () => SessionGuardrailsSettings;
  uploadsRoot: string;
  guardrailsRefusal?: GuardrailsSpawnRefusal;
  prepareGuardrails?: typeof prepareGuardrailsLaunch;
  trustClaudeFolder?: (folder: string) => Promise<unknown>;
  readGithubToken?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: Pick<Console, 'warn'>;
}

type SessionGuardrails = ReturnType<typeof createSessionGuardrails>;

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

function createSessionGuardrails({
  getSettings, uploadsRoot, guardrailsRefusal = allowGuardedSpawn, prepareGuardrails = prepareGuardrailsLaunch, trustClaudeFolder, platform = process.platform,
  homeDir = os.homedir(), env = process.env, readGithubToken = () => readGithubCliToken(env), log = console,
}: SessionGuardrailsDependencies) {
  const expandHome = (candidates: readonly string[]) => candidates.map((candidate) => expandTilde(candidate.trim(), env, homeDir)).filter(Boolean);
  const githubCliConfigDir = () => rawTextOr(env.GH_CONFIG_DIR, null) ?? path.join(rawTextOr(env.XDG_CONFIG_HOME, null) ?? path.join(homeDir, '.config'), 'gh');

  async function describeSessionAccess(facts: SessionGuardrailsFacts, { sessionId, isWorkspace }: SessionGuardrailsRequest): Promise<{ role: GuardrailsRole; cwd: string; trustFolder: string }> {
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

  function prepareFor(request: SessionGuardrailsRequest): PrepareSessionGuardrails | null {
    if (platform === UNWRAPPED_PLATFORM) return null;
    return async (facts) => {
      const guardrailsRefusalReason = guardrailsRefusal();
      if (guardrailsRefusalReason !== null) return { ok: false, reason: `${guardrailsRefusalReason} ${OPT_OUT_HINT}` };
      try {
        const { role, cwd, trustFolder } = await describeSessionAccess(facts, request);
        const prepared = await prepareGuardrails({ role, launchId: facts.launchId, keptTempFolderName: request.sessionId, enterDir: cwd });
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

export { createSessionGuardrails };
export type { SessionGuardrails };
