import fs from 'node:fs/promises';
import path from 'node:path';
import type { HookRouter } from '../../detection/hook-source.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { resolveHookTools as resolveSharedHookTools, resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import type { HookToolConfig } from '../hook-tools.ts';
import { trailStepFromHook } from '../core/investigation-trail-core.ts';
import { ACCEPT_EDITS_MODE, LANE_CONFIG_EDIT_DENY_RULES, LANE_CREDENTIAL_ENV, withAllowRules } from '../lanes/core/lane-permissions-core.ts';
import { prepareLaneMcp } from '../lanes/lane-mcp.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import * as core from './core/team-review-core.ts';
import { awaitSessionExit, registerEphemeralSession } from '../lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from '../lanes/ephemeral-session.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';

const TEAM_REVIEW_DENY_RULES = Object.freeze([
  'Bash(gh:*)',
  'Bash(git push:*)',
  'Bash(curl:*api.github.com*)',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
]);

const TEAM_REVIEW_SESSION_DENY_RULES = Object.freeze([...TEAM_REVIEW_DENY_RULES, ...LANE_CONFIG_EDIT_DENY_RULES]);

const EMPTY_GH_CONFIG_DIRNAME = 'gh-config';

const PUSH_DISABLED_URL = 'https://push-disabled.invalid/';

interface TeamReviewWorkDir {
  dir: string;
  cleanup(): Promise<void>;
}

type TeamReviewSpawn = (options: {
  id: string;
  name: string;
  cwd: string;
  spawnEnv: Record<string, string>;
  extraClaudeArgs: string[];
  settingsPermissions: { deny: string[]; defaultMode: string; allow?: string[] };
  signal: AbortSignal;
  onSessionId?: (id: string) => void;
  resumeSessionId?: string | null;
  initialPrompt?: string | null;
  agent?: string;
  onToolStep?: (step: { tool: string; detail: string }) => void;
  extraUserHooks?: UserHook[];
  prependPathDirs?: string[];
}) => Promise<void>;

function teamReviewAcceptEditsPermissions(): { deny: string[]; defaultMode: string } {
  return { deny: [...TEAM_REVIEW_SESSION_DENY_RULES], defaultMode: ACCEPT_EDITS_MODE };
}

function emptyGhConfigDir(workDir: string): string {
  return path.join(workDir, EMPTY_GH_CONFIG_DIRNAME);
}

function teamReviewSpawnEnv(workDir: string): Record<string, string> {
  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    GH_CONFIG_DIR: emptyGhConfigDir(workDir),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
    GIT_CONFIG_VALUE_1: PUSH_DISABLED_URL,
    GLIMMERVOID_POSTHOG_API_KEY: '',
    GLIMMERVOID_TELEGRAM_BOT_TOKEN: '',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
}

function hooksPathPinnedSpawnEnv(workDir: string): Record<string, string> {
  return {
    ...teamReviewSpawnEnv(workDir),
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: '',
  };
}

async function makeTeamReviewWorkDir(root: string, prefix: string): Promise<TeamReviewWorkDir> {
  const safePrefix = `glimmervoid-wt-${core.TEAM_REVIEW_LANE_ID}-${prefix}`.replace(/[^\w.-]+/g, '-');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, `${safePrefix}-`));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

function createTeamReviewSpawn({
  reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, recordLane = null, replayBufferKB,
  makeSession = (options: SessionOptions) => new Session(options),
  laneName = core.TEAM_REVIEW_LANE_ID,
  hookToolConfig = null,
  resolveHookTools = resolveSharedHookTools,
  prepareMcp = prepareLaneMcp,
}: {
  reviewSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  replayBufferKB?: number;
  makeSession?: (options: SessionOptions) => Session;
  laneName?: string;
  hookToolConfig?: HookToolConfig | null;
  resolveHookTools?: typeof resolveSharedHookTools;
  prepareMcp?: typeof prepareLaneMcp;
}): TeamReviewSpawn {
  return async function spawnTeamReviewSession({ id, name, cwd, spawnEnv, extraClaudeArgs, settingsPermissions, signal, onToolStep, onSessionId, resumeSessionId, initialPrompt, agent, extraUserHooks, prependPathDirs }) {
    const skipPermissions = settingsPermissions.defaultMode === 'bypassPermissions';
    const sharedHookTools = hookRouter ? resolveRequiredSaneYoloHookTools(hookToolConfig?.saneYoloUnreadablePaths ?? [], { resolve: resolveHookTools }) : [];
    if (sharedHookTools === null) throw new Error(`${laneName} lane cannot start: Sane YOLO is unavailable`);
    const laneMcp = hookRouter ? await prepareMcp({ laneArgs: extraClaudeArgs, agent: agent ?? DEFAULT_AGENT_ID }) : null;
    const sess = makeSession({
      id,
      name,
      path: cwd,
      ...(agent ? { agent } : {}),
      spawnEnv: { ...spawnEnv, ...LANE_CREDENTIAL_ENV },
      dangerouslySkipPermissions: skipPermissions,
      ...(laneMcp?.posture.bypassHookTrust ? { bypassHookTrust: true } : {}),
      hookTools: laneMcp ? [...sharedHookTools, laneMcp.posture.hookTool] : sharedHookTools,
      extraClaudeArgs: laneMcp ? [...extraClaudeArgs, ...laneMcp.posture.args] : extraClaudeArgs,
      ...(extraUserHooks ? { extraUserHooks } : {}),
      ...(prependPathDirs ? { prependPathDirs } : {}),
      initialPrompt: initialPrompt === undefined ? core.REVIEW_BOOTSTRAP_PROMPT : initialPrompt,
      resumeSessionId,
      ephemeral: true,
      requiresHooks: true,
      observeToolCalls: onToolStep !== undefined,
      settingsPermissions: laneMcp ? withAllowRules(settingsPermissions, laneMcp.posture.allowRules) : settingsPermissions,
      replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({
      map: reviewSessions, id, sess, closeSessionDataClients, logPrefix: laneName, name, recordLane,
    });
    if (onSessionId) sess.on('claude-session-id', ({ id: capturedId }: { id: string }) => onSessionId(capturedId));
    if (onToolStep) {
      sess.on('hook-event', ({ event, payload }: { event: string; payload: Record<string, unknown> }) => {
        const step = trailStepFromHook(event, payload);
        if (step) onToolStep(step);
      });
    }
    try {
      await awaitSessionExit(sess, { signal, spawnGate });
    } finally {
      if (laneMcp) await laneMcp.cleanup();
    }
  };
}

export { TEAM_REVIEW_SESSION_DENY_RULES, teamReviewAcceptEditsPermissions, emptyGhConfigDir, hooksPathPinnedSpawnEnv, makeTeamReviewWorkDir, createTeamReviewSpawn };
export type { TeamReviewWorkDir, TeamReviewSpawn };
