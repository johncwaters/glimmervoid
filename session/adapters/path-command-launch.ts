import fs from "node:fs";

import { execFileSync } from "../../server/child-process-safe.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type { AgentCommandOptions, AgentSpawnCommandOptions } from "./index.ts";

interface PathCommandLaunch {
  resolveCommand(options?: AgentCommandOptions): ResolvedCommand;
  buildSpawnCommand(options: AgentSpawnCommandOptions): { file: string; args: string[] };
  buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv;
}

function pathCommandLaunch(commandName: string, envProfile: AgentEnvProfile): PathCommandLaunch {
  function resolveCommand(
    { platform, execFile = execFileSync, pathExists = fs.existsSync }: AgentCommandOptions = {},
  ): ResolvedCommand {
    return resolveAgentCommand({
      name: commandName,
      platform: platform || process.platform,
      execFile,
      pathExists,
    });
  }

  function buildSpawnCommand(
    { platform, resolved, settingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
  ): { file: string; args: string[] } {
    return buildAgentSpawnCommand({
      name: commandName,
      platform,
      resolved,
      argGroups: [settingsArgs, agentArgs],
    });
  }

  function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
    return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
  }

  return { resolveCommand, buildSpawnCommand, buildEnv };
}

export { pathCommandLaunch };
