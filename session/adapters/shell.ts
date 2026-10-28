import fs from "node:fs";

import { execFileSync } from "../../server/child-process-safe.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentCommandOptions,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import { SHELL_AGENT_ID } from "../../shared/contracts/config.ts";

const envProfile: AgentEnvProfile = { scrub: [], set: {} };

const SHELL_CAPABILITIES: AgentCapabilities = Object.freeze({
  hooks: false,
  awaitingInput: false,
  backgroundAgents: false,
  resume: false,
  statusLine: false,
  saneYolo: false,
  compactQuiet: false,
  skipPermissionsFlag: false,
  headless: false,
});

const titleProfile: AgentTitleProfile = {
  classifyTitle: () => "ignore",
  taskTitle: { readsTranscriptTitle: false, genericTitles: [SHELL_AGENT_ID], agentSuffix: "" },
};

function shellCommandName(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return env.COMSPEC || "cmd.exe";
  return env.SHELL || "/bin/sh";
}

const commandName = shellCommandName(process.platform, process.env);

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

function buildSpawnCommand({ platform, resolved, agentArgs = [] }: AgentSpawnCommandOptions): { file: string; args: string[] } {
  return buildAgentSpawnCommand({ name: commandName, platform, resolved, argGroups: [agentArgs] });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function buildArgs(): string[] {
  return process.platform === "win32" ? [] : ["-l"];
}

const shell: AgentAdapter = {
  id: SHELL_AGENT_ID,
  label: "Shell",
  usageVendor: SHELL_AGENT_ID,
  commandName,
  envProfile,
  titleProfile,
  hooks: null,
  capabilities: SHELL_CAPABILITIES,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
};

export default shell;
