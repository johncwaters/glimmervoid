import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { DEFAULT_AGENT_ID } from '../session/adapters/index.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { buildLanePermissions } from './core/lane-permissions-core.ts';
import { awaitSessionExit, registerEphemeralSession } from './ephemeral-session.ts';
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

function writeStandaloneDenySettings(permissions: unknown): { args: string[]; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SETTINGS_DIR_PREFIX));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions }, null, 2), 'utf8');
  return {
    args: ['--settings', settingsPath],
    cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  } },
  };
}

function createLaneSpawn({
  sessions = new Map(), closeSessionDataClients = () => {}, hookRouter = null, getHookPort = null,
  spawnGate = null, replayBufferKB = undefined, recordLane = null, laneName, allowTools = [],
  createSession = (options) => new Session(options),
}: LaneSpawnOptions): LaneSpawn {
  return async function spawnLaneSession({ id, name, prompt, cwd, agent = DEFAULT_AGENT_ID, extraArgs = [], model = null, signal = null }) {
    const isCodex = agent === 'codex';
    const posture = isCodex ? null : buildLanePermissions({ denyTools: LANE_SPAWN_DENY_TOOLS, allowTools });
    const standalone = !hookRouter && posture ? writeStandaloneDenySettings(posture.permissions) : null;
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
    const laneSession = createSession(options);
    registerEphemeralSession({
      map: sessions, id, sess: laneSession, closeSessionDataClients, logPrefix: laneName, name, recordLane,
    });
    try {
      await awaitSessionExit(laneSession, { signal, spawnGate });
    } finally {
      if (standalone) standalone.cleanup();
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
