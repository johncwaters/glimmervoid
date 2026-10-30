import fsPromises from 'node:fs/promises';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import { appendUserHooks } from '../../session/core/user-hooks-core.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { buildLanePermissions, LANE_CREDENTIAL_ENV, withAllowRules } from './core/lane-permissions-core.ts';
import { prepareLaneMcp } from './lane-mcp.ts';
import { awaitSessionExit, registerEphemeralSession } from './ephemeral-session.ts';
import { resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { writeJsonAtomic } from '../json-file.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';

const SETTINGS_DIR_PREFIX = 'glimmervoid-lane-settings-';
const KIMI_AGENT_ID = 'kimi';
const CODEX_READ_ONLY_ARGS = Object.freeze(['-s', 'read-only']);
const GUARD_HOOK_UNAVAILABLE_ERROR = 'Sane YOLO is unavailable';

const LANE_SPAWN_DENY_TOOLS = Object.freeze([
  'Bash', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Bash(git push:*)', 'Bash(gh:*)',
]);

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
  createSession?: (options: SessionOptions) => Session;
  prepareMcp?: typeof prepareLaneMcp;
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

function headlessPromptLaunch(agent: string, prompt: string): { args: string[]; initialPrompt: string | null } {
  if (agent === KIMI_AGENT_ID) return { args: ['-p', prompt], initialPrompt: null };
  return { args: [], initialPrompt: prompt };
}

function laneAgentArgs({ isClaude, isCodex, extraArgs, model, postureArgs, standaloneArgs }: {
  isClaude: boolean; isCodex: boolean; extraArgs: readonly string[]; model: string | null; postureArgs: readonly string[]; standaloneArgs: readonly string[];
}): string[] {
  if (isClaude) return ['-p', ...postureArgs, ...extraArgs, ...standaloneArgs, ...(model ? ['--model', model] : [])];
  if (isCodex) return [...CODEX_READ_ONLY_ARGS, ...extraArgs];
  return [...extraArgs];
}

function createLaneSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null, laneName, getSaneYoloUnreadablePaths, allowTools = [],
  createSession = (options) => new Session(options), settingsPermissions, spawnEnv = null,
  prepareMcp = prepareLaneMcp,
}: LaneSpawnOptions): LaneSpawn {
  return async function spawnLaneSession({ id, name, prompt, cwd, agent = DEFAULT_AGENT_ID, extraArgs = [], model = null, signal = null, onOutput }) {
    const isCodex = agent === 'codex';
    const isKimi = agent === KIMI_AGENT_ID;
    const isClaude = !isCodex && !isKimi;
    const guardHookTools = hookRouter ? resolveRequiredSaneYoloHookTools(getSaneYoloUnreadablePaths()) : [];
    if (guardHookTools === null) throw new Error(GUARD_HOOK_UNAVAILABLE_ERROR);
    await runLaneSession(guardHookTools);

    async function runLaneSession(saneYoloHookTools: readonly ResolvedHookTool[]): Promise<void> {
      const posture = isClaude ? buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS, allowTools }) : null;
      const basePermissions = settingsPermissions ?? posture?.permissions ?? null;
      const laneMcp = hookRouter ? await prepareMcp({ laneArgs: posture?.args ?? [], agent }) : null;
      const permissions = basePermissions && laneMcp ? withAllowRules(basePermissions, laneMcp.posture.allowRules) : basePermissions;
      const standalone = !hookRouter && permissions ? await writeStandaloneDenySettings(permissions, []) : null;
      const hookTools = [...saneYoloHookTools, ...(laneMcp ? [laneMcp.posture.hookTool] : [])];
      const promptLaunch = headlessPromptLaunch(agent, prompt);
      const agentExtraArgs = isCodex && laneMcp ? [...extraArgs, ...laneMcp.posture.args] : extraArgs;
      const extraClaudeArgs = laneAgentArgs({ isClaude, isCodex, extraArgs: agentExtraArgs, model, postureArgs: [...(posture?.args ?? []), ...(laneMcp?.posture.args ?? [])], standaloneArgs: standalone?.args ?? [] });
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
        spawnEnv: { ...spawnEnv, ...LANE_CREDENTIAL_ENV },
        replayBufferKB,
        hookRouter,
        getHookPort,
        ...(laneMcp?.scratchAgentHome ? { scratchAgentHome: laneMcp.scratchAgentHome } : {}),
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

export { LANE_SPAWN_DENY_TOOLS, createLaneSpawn, headlessPromptLaunch, readLaneResultFile };
export type { LaneSpawn };
