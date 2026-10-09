import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { DEFAULT_AGENT_ID } from '../session/adapters/index.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import { awaitSessionExit, registerEphemeralSession } from './ephemeral-session.ts';
import { writeJsonAtomic } from './json-file.ts';
import type { RecordLane, SpawnGate } from './ephemeral-session.ts';

const SETTINGS_DIR_PREFIX = 'glimmervoid-lane-settings-';

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
  createSession?: (options: SessionOptions) => Session;
}

async function writeStandaloneDenySettings(permissions: unknown): Promise<{ args: string[]; cleanup(): Promise<void> }> {
  const settingsDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), SETTINGS_DIR_PREFIX));
  const settingsPath = path.join(settingsDirectory, 'settings.json');
  const removeSettingsDirectory = () => fsPromises.rm(settingsDirectory, { recursive: true, force: true }).catch(() => {});
  try {
    await writeJsonAtomic(settingsPath, { permissions });
  } catch (error) {
    await removeSettingsDirectory();
    throw error;
  }
  return { args: ['--settings', settingsPath], cleanup: removeSettingsDirectory };
}

function createLaneSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null, laneName, allowTools = [],
  createSession = (options) => new Session(options),
}: LaneSpawnOptions): LaneSpawn {
  return async function spawnLaneSession({ id, name, prompt, cwd, agent = DEFAULT_AGENT_ID, extraArgs = [], model = null, signal = null }) {
    const isCodex = agent === 'codex';
    const posture = isCodex ? null : buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS, allowTools });
    const standalone = !hookRouter && posture ? await writeStandaloneDenySettings(posture.permissions) : null;
    const extraClaudeArgs = isCodex ? extraArgs : ['-p', ...(posture?.args ?? []), ...(standalone ? standalone.args : [])];
    if (!isCodex && model) extraClaudeArgs.push('--model', model);
    const options: SessionOptions = {
      id,
      name,
      path: cwd,
      agent,
      dangerouslySkipPermissions: false,
      extraClaudeArgs,
      initialPrompt: prompt,
      ephemeral: true,
      settingsPermissions: posture?.permissions ?? null,
      replayBufferKB,
      hookRouter,
      getHookPort,
    };
    try {
      const laneSession = createSession(options);
      registerEphemeralSession({
        map: sessions, id, sess: laneSession, closeSessionDataClients, logPrefix: laneName, name, recordLane,
      });
      await awaitSessionExit(laneSession, { signal, spawnGate });
    } finally {
      if (standalone) await standalone.cleanup();
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

export { LANE_SPAWN_DENY_TOOLS, createLaneSpawn, readLaneResultFile };
export type { LaneSpawn };
