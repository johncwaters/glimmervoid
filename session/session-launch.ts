import fs from "node:fs";
import { AGENT_URL_ENV } from "../shared/contracts/session.ts";
import { commandFor } from "./adapters/index.ts";
import type { AgentAdapter } from "./adapters/index.ts";
import { commitSigningEnv } from "./core/commit-signing-env.ts";
import type { ResolvedCommand } from "./core/spawn-command.ts";
import type { SpawnEnv } from "./core/spawn-env.ts";
import type { createSessionHookLifecycle } from "./session-hook-lifecycle.ts";

interface SpawnCommand {
  file: string;
  args: string[];
}

type LaunchHooks = Pick<ReturnType<typeof createSessionHookLifecycle>, "listenerPort">;

interface LaunchPort {
  effectiveCwd: () => string;
  spawnEnv: () => Record<string, string> | null;
  spawnCommand: () => ResolvedCommand | null;
  agentToken: () => string | null;
  commitSigningToken: () => string | null;
  commitSigningProgram: () => string | null;
}

interface SessionLaunchOptions {
  id: string;
  adapter: AgentAdapter;
  platform: NodeJS.Platform;
  hooks: LaunchHooks;
  port: LaunchPort;
}

interface SessionLaunch {
  buildEnv(options?: { extraEnv?: Record<string, string> | null; prependPathDirs?: readonly string[] }): SpawnEnv;
  agentApiEnv(): Record<string, string>;
  commitSigningEnv(): Record<string, string>;
  spawnCwdSpellings(): string[];
  spawnCommandFor(input: { settingsArgs: string[]; agentArgs: string[] }): SpawnCommand;
}

function createSessionLaunch({ id, adapter, platform, hooks, port }: SessionLaunchOptions): SessionLaunch {
  function agentApiEnv(): Record<string, string> {
    const agentToken = port.agentToken();
    if (!agentToken) return {};
    const listenerPort = hooks.listenerPort();
    if (!listenerPort) return {};
    const url = `http://127.0.0.1:${listenerPort}/agent/${encodeURIComponent(id)}?t=${encodeURIComponent(agentToken)}`;
    return { [AGENT_URL_ENV]: url };
  }

  function signingEnv(): Record<string, string> {
    return commitSigningEnv({
      port: hooks.listenerPort(),
      sessionId: id,
      token: port.commitSigningToken(),
      signingProgram: port.commitSigningProgram(),
      inheritedConfigParameters: port.spawnEnv()?.GIT_CONFIG_PARAMETERS ?? process.env.GIT_CONFIG_PARAMETERS,
    });
  }

  function spawnCwdSpellings(): string[] {
    const spawnCwd = port.effectiveCwd();
    try {
      return Array.from(new Set([spawnCwd, fs.realpathSync.native(spawnCwd)]));
    } catch {
      return [spawnCwd];
    }
  }

  function spawnCommandFor({ settingsArgs, agentArgs }: { settingsArgs: string[]; agentArgs: string[] }): SpawnCommand {
    const command = adapter.buildSpawnCommand({
      platform: platform,
      resolved: port.spawnCommand() || commandFor(adapter),
      settingsArgs,
      agentArgs,
    });
    return { file: command.file, args: command.args };
  }

  function buildEnv({ extraEnv = port.spawnEnv(), ...options }: {
    extraEnv?: Record<string, string> | null;
    prependPathDirs?: readonly string[];
  } = {}) {
    return adapter.buildEnv(process.env, extraEnv, options);
  }

  return {
    buildEnv,
    agentApiEnv,
    commitSigningEnv: signingEnv,
    spawnCwdSpellings,
    spawnCommandFor,
  };
}

export { createSessionLaunch };
export type { SessionLaunch };
