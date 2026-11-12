import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import { appendUserHooks } from '../../session/core/user-hooks-core.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import type { SessionAccountHome } from '../../session/core/agent-account-core.ts';
import { buildLanePermissions, CLOSED_LANE_ACCESS_CONFIG, laneAccess, withAllowRules, withLaneAccessRules } from './core/lane-permissions-core.ts';
import type { LaneAccessConfig } from './core/lane-permissions-core.ts';
import { prepareLaneMcp } from './lane-mcp.ts';
import { awaitSessionExit, registerEphemeralSession } from './ephemeral-session.ts';
import { resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { writeJsonAtomic } from '../json-file.ts';
import { choiceSelection, selectionArgs } from '../../shared/agent-models-core.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';

const SETTINGS_DIR_PREFIX = 'glimmervoid-lane-settings-';
const GH_CONFIG_DIR_PREFIX = 'glimmervoid-lane-gh-';
const KIMI_AGENT_ID = 'kimi';
const CODEX_AGENT_ID = 'codex';
const CODEX_LANE_PERMISSION_PROFILE = 'glimmervoid_lane';
const CODEX_PROMPT_FILENAME = 'lane-prompt.md';
const CODEX_PROMPT_BOOTSTRAP = `Read ${CODEX_PROMPT_FILENAME} in the current folder and follow its instructions.`;
const GUARD_HOOK_UNAVAILABLE_ERROR = 'Sane YOLO is unavailable';

const LANE_SPAWN_DENY_TOOLS = Object.freeze(['Edit', 'NotebookEdit', 'Task', 'Bash(git push:*)']);

type LaneSpawn = (options: {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  agent?: string;
  extraArgs?: string[];
  model?: string | null;
  signal?: AbortSignal | null;
  onOutput?: (chunk: string) => void;
}) => Promise<void>;

interface LaneSpawnOptions {
  sessions?: Map<string, unknown>;
  closeSessionDataClients?: (id: string) => void;
  hookRouter?: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort?: (() => number | null) | null;
  spawnGate?: SpawnGate | null;
  replayBufferKB?: number;
  recordLane?: RecordLane | null;
  laneName: string;
  getSaneYoloUnreadablePaths: () => readonly string[];
  allowTools?: readonly string[];
  settingsPermissions?: Record<string, unknown>;
  spawnEnv?: Readonly<Record<string, string>> | null;
  getLaneAccessConfig?: () => LaneAccessConfig;
  createSession?: (options: SessionOptions) => Session;
  prepareMcp?: typeof prepareLaneMcp;
  accountHomeFor?: ((agentId: string) => SessionAccountHome) | null;
}

async function writeStandaloneDenySettings(permissions: unknown, userHooks: readonly UserHook[]): Promise<{ args: string[]; cleanup(): Promise<void> }> {
  const settingsDirectory = await makeHostScratchDirectory(SETTINGS_DIR_PREFIX);
  const settingsPath = path.join(settingsDirectory, 'settings.json');
  const removeSettingsDirectory = () => fsPromises.rm(settingsDirectory, { recursive: true, force: true }).catch(() => {});
  try {
    await writeJsonAtomic(settingsPath, userHooks.length > 0 ? { permissions, hooks: appendUserHooks({}, userHooks) } : { permissions });
  } catch (error) {
    await removeSettingsDirectory();
    throw error;
  }
  return { args: ['--settings', settingsPath], cleanup: removeSettingsDirectory };
}

async function makeLaneGhConfigDirectory(): Promise<{ path: string; remove(): Promise<void> }> {
  const ghConfigDirectory = await makeHostScratchDirectory(GH_CONFIG_DIR_PREFIX);
  return { path: ghConfigDirectory, remove: () => fsPromises.rm(ghConfigDirectory, { recursive: true, force: true }).catch(() => {}) };
}

function headlessPromptLaunch(agent: string, prompt: string): { args: string[]; initialPrompt: string | null } {
  if (agent === KIMI_AGENT_ID) return { args: ['-p', prompt], initialPrompt: null };
  if (agent === CODEX_AGENT_ID) return { args: [CODEX_PROMPT_BOOTSTRAP], initialPrompt: null };
  return { args: [], initialPrompt: prompt };
}

function codexLaneExecArgs(laneDir: string, homeDir: string): string[] {
  const filesystem = [[':root', 'read'], [homeDir, 'none'], [laneDir, 'write']].map(([folder, access]) => `${JSON.stringify(folder)}=${JSON.stringify(access)}`).join(',');
  return [
    'exec', '--skip-git-repo-check',
    '-c', `default_permissions="${CODEX_LANE_PERMISSION_PROFILE}"`,
    '-c', `permissions.${CODEX_LANE_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
  ];
}

function laneAgentArgs({ agent, isClaude, isCodex, extraArgs, model, postureArgs, standaloneArgs, laneDir }: {
  agent: string; isClaude: boolean; isCodex: boolean; extraArgs: readonly string[]; model: string | null; postureArgs: readonly string[]; standaloneArgs: readonly string[]; laneDir: string;
}): string[] {
  const modelArgs = selectionArgs(choiceSelection(isClaude ? DEFAULT_AGENT_ID : agent, { model }));
  if (isClaude) return ['-p', ...postureArgs, ...extraArgs, ...standaloneArgs, ...modelArgs];
  if (isCodex) return [...codexLaneExecArgs(laneDir, os.homedir()), ...extraArgs, ...modelArgs];
  return [...extraArgs, ...modelArgs];
}

function createLaneSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null, laneName, getSaneYoloUnreadablePaths, allowTools = [],
  createSession = (options) => new Session(options), settingsPermissions, spawnEnv = null,
  prepareMcp = prepareLaneMcp, getLaneAccessConfig = () => CLOSED_LANE_ACCESS_CONFIG, accountHomeFor = null,
}: LaneSpawnOptions): LaneSpawn {
  return async function spawnLaneSession({ id, name, prompt, cwd, agent = DEFAULT_AGENT_ID, extraArgs = [], model = null, signal = null, onOutput }) {
    const isCodex = agent === CODEX_AGENT_ID;
    const isKimi = agent === KIMI_AGENT_ID;
    const isClaude = !isCodex && !isKimi;
    const guardHookTools = hookRouter ? resolveRequiredSaneYoloHookTools(getSaneYoloUnreadablePaths()) : [];
    if (guardHookTools === null) throw new Error(GUARD_HOOK_UNAVAILABLE_ERROR);
    const laneGhConfig = await makeLaneGhConfigDirectory();
    try {
      await runLaneSession(guardHookTools, laneGhConfig.path);
    } finally {
      await laneGhConfig.remove();
    }

    async function runLaneSession(saneYoloHookTools: readonly ResolvedHookTool[], laneGhConfigDir: string): Promise<void> {
      const { readToken, extraFetchDomains } = getLaneAccessConfig();
      const access = laneAccess({ agent, readToken, extraFetchDomains, ghConfigDir: laneGhConfigDir, inheritedEnv: process.env });
      const denyTools = [...LANE_SPAWN_DENY_TOOLS, ...(access.isOpen ? [] : ['Bash'])];
      const tools = allowTools.length > 0 ? [...new Set([...allowTools, ...access.tools])] : [];
      const posture = isClaude ? buildLanePermissions({ denyTools, allowTools: tools }) : null;
      const unscopedPermissions = settingsPermissions ?? posture?.permissions ?? null;
      const basePermissions = unscopedPermissions && isClaude ? withLaneAccessRules(unscopedPermissions, access) : unscopedPermissions;
      const laneMcp = hookRouter ? await prepareMcp({ laneArgs: posture?.args ?? [], agent }) : null;
      const permissions = basePermissions && laneMcp ? withAllowRules(basePermissions, laneMcp.posture.allowRules) : basePermissions;
      const standalone = !hookRouter && permissions ? await writeStandaloneDenySettings(permissions, []) : null;
      const hookTools = [...saneYoloHookTools, ...(laneMcp ? [laneMcp.posture.hookTool] : [])];
      const promptLaunch = headlessPromptLaunch(agent, prompt);
      if (isCodex) await fsPromises.writeFile(path.join(cwd, CODEX_PROMPT_FILENAME), prompt, 'utf8');
      const agentExtraArgs = isCodex && laneMcp ? [...extraArgs, ...laneMcp.posture.args] : extraArgs;
      const extraClaudeArgs = laneAgentArgs({ agent, isClaude, isCodex, extraArgs: agentExtraArgs, model, postureArgs: [...(posture?.args ?? []), ...(laneMcp?.posture.args ?? [])], standaloneArgs: standalone?.args ?? [], laneDir: cwd });
      extraClaudeArgs.push(...promptLaunch.args);
      const options: SessionOptions = {
        ...(hookTools.length > 0 ? { hookTools } : {}),
        id,
        name,
        path: cwd,
        agent,
        dangerouslySkipPermissions: false,
        ...(laneMcp?.posture.bypassHookTrust ? { bypassHookTrust: true } : {}),
        extraClaudeArgs,
        initialPrompt: promptLaunch.initialPrompt,
        ephemeral: true,
        requiresHooks: true,
        settingsPermissions: permissions,
        spawnEnv: { ...spawnEnv, ...access.env },
        replayBufferKB,
        hookRouter,
        getHookPort,
        ...(laneMcp?.scratchAgentHome ? { scratchAgentHome: laneMcp.scratchAgentHome } : {}),
        ...(isCodex ? { isCleanHome: true } : {}),
        ...(accountHomeFor && isClaude ? { resolveAccountHome: () => accountHomeFor(agent) } : {}),
      };
      try {
        const laneSession = createSession(options);
        if (onOutput) laneSession.on('data', onOutput);
        registerEphemeralSession({
          map: sessions, id, sess: laneSession, closeSessionDataClients, logPrefix: laneName, name, recordLane,
        });
        await awaitSessionExit(laneSession, { signal, spawnGate });
      } finally {
        if (standalone) await standalone.cleanup();
        if (laneMcp) await laneMcp.cleanup();
      }
    }
  };
}

async function readLaneResultFile(resultPath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fsPromises.readFile(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

export { LANE_SPAWN_DENY_TOOLS, createLaneSpawn, headlessPromptLaunch, makeLaneGhConfigDirectory, readLaneResultFile };
export type { LaneSpawn };
