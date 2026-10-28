import fsPromises from 'node:fs/promises';
import path from 'node:path';

import type { HookRouter } from '../../detection/hook-source.ts';
import { appendUserHooks } from '../../session/core/user-hooks-core.ts';
import type { UserHook } from '../../session/core/user-hooks-core.ts';
import { DEFAULT_AGENT_ID } from '../../session/adapters/index.ts';
import { Session } from '../../session/sessions.ts';
import type { SessionOptions } from '../../session/sessions.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import { awaitSessionExit, registerEphemeralSession } from './ephemeral-session.ts';
import { judgeRole, LANE_CREDENTIAL_ENV } from '../guardrails/core/guardrails-roles-core.ts';
import { resolveRequiredSaneYoloHookTools } from '../hook-tools.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { writeJsonAtomic } from '../json-file.ts';
import { allowGuardedSpawn } from '../guardrails/guardrails-deps.ts';
import { prepareGuardrailsLaunch } from '../guardrails/guardrails-launch.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';
import type { GuardrailsSpawnRefusal } from '../guardrails/guardrails-deps.ts';
import type { GuardrailsRole } from '../guardrails/core/guardrails-policy-core.ts';

const SETTINGS_DIR_PREFIX = 'glimmervoid-lane-settings-';
const KIMI_AGENT_ID = 'kimi';
const UNWRAPPED_PLATFORM = 'win32';
const UNWRAPPED_CODEX_GUARDRAILS_ARGS = Object.freeze(['-s', 'read-only']);
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
  readablePaths?: readonly string[];
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
  allowTools?: readonly string[];
  settingsPermissions?: Record<string, unknown>;
  spawnEnv?: Readonly<Record<string, string>> | null;
  createSession?: (options: SessionOptions) => Session;
  prepareGuardrails?: typeof prepareGuardrailsLaunch;
  guardrailsRefusal?: GuardrailsSpawnRefusal;
  platform?: NodeJS.Platform;
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

function laneVendor(agent: string): GuardrailsRole['vendors'][number] {
  if (agent === 'codex' || agent === KIMI_AGENT_ID) return agent;
  return 'claude';
}

function laneAgentArgs({ isClaude, isWrapped, isCodex, extraArgs, model, postureArgs, standaloneArgs }: {
  isClaude: boolean; isWrapped: boolean; isCodex: boolean; extraArgs: readonly string[]; model: string | null; postureArgs: readonly string[]; standaloneArgs: readonly string[];
}): string[] {
  if (isClaude) return ['-p', ...postureArgs, ...extraArgs, ...standaloneArgs, ...(model ? ['--model', model] : [])];
  if (isCodex && !isWrapped) return [...UNWRAPPED_CODEX_GUARDRAILS_ARGS, ...extraArgs];
  return [...extraArgs];
}

function createLaneSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null, laneName, allowTools = [],
  createSession = (options) => new Session(options), settingsPermissions, spawnEnv = null,
  prepareGuardrails = prepareGuardrailsLaunch, guardrailsRefusal = allowGuardedSpawn, platform = process.platform,
}: LaneSpawnOptions): LaneSpawn {
  return async function spawnLaneSession({ id, name, prompt, cwd, agent = DEFAULT_AGENT_ID, extraArgs = [], model = null, signal = null, onOutput, readablePaths = [] }) {
    const isCodex = agent === 'codex';
    const isKimi = agent === KIMI_AGENT_ID;
    const isClaude = !isCodex && !isKimi;
    const hasClaudeShell = isClaude && settingsPermissions !== undefined;
    const isWrapped = platform !== UNWRAPPED_PLATFORM;
    if (!isWrapped && (hasClaudeShell || isKimi)) throw new Error(`${laneName} lane needs the sandbox runtime, which does not run on ${platform}`);
    const guardrailsRefusalReason = isWrapped ? guardrailsRefusal() : null;
    if (guardrailsRefusalReason !== null) throw new Error(guardrailsRefusalReason);
    const guardHookTools = hasClaudeShell && hookRouter ? resolveRequiredSaneYoloHookTools({}) ?? [] : null;
    if (guardHookTools && !guardHookTools.some((tool) => tool.id === 'saneYolo')) throw new Error(GUARD_HOOK_UNAVAILABLE_ERROR);
      await runLaneSession();

    async function runLaneSession(): Promise<void> {
      const posture = isClaude ? buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS, allowTools }) : null;
      const basePermissions = settingsPermissions ?? posture?.permissions ?? null;
      const permissions = basePermissions;
      const standalone = !hookRouter && permissions ? await writeStandaloneDenySettings(permissions, []) : null;
      const promptLaunch = headlessPromptLaunch(agent, prompt);
      const extraClaudeArgs = laneAgentArgs({ isClaude, isWrapped, isCodex, extraArgs, model, postureArgs: posture?.args ?? [], standaloneArgs: standalone?.args ?? [] });
      extraClaudeArgs.push(...promptLaunch.args);
      const options: SessionOptions = {
        ...(guardHookTools ? { hookTools: guardHookTools, getHookTools: null } : {}),
        id,
        name,
        path: cwd,
        agent,
        dangerouslySkipPermissions: false,
        extraClaudeArgs,
        initialPrompt: promptLaunch.initialPrompt,
        ephemeral: true,
        settingsPermissions: permissions,
        spawnEnv: spawnEnv || isWrapped ? { ...spawnEnv, ...(isWrapped ? LANE_CREDENTIAL_ENV : {}) } : null,
        replayBufferKB,
        hookRouter,
        getHookPort,
        prepareGuardrails: isWrapped ? (facts) => prepareGuardrails({
          role: judgeRole({
            vendor: laneVendor(agent), cwd: facts.cwd, hookPort: facts.hookPort, agentSessionId: facts.agentSessionId,
            readablePaths: [...facts.readablePaths, ...readablePaths],
          }),
          launchId: facts.launchId,
        }) : null,
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
