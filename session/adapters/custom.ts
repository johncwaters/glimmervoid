import fs from "node:fs";

import { execFileSync } from "../../server/child-process-safe.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { classifyAgentTitle, isSpinnerChar } from "../core/title-classifier-core.ts";
import type {
  AgentAdapter,
  AgentArgsOptions,
  AgentCapabilities,
  AgentCommandOptions,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { CustomAgentDeclaration } from "../../shared/contracts/index.ts";

const envProfile: AgentEnvProfile = { scrub: [], set: {} };

const TITLE_ONLY_CAPABILITIES: AgentCapabilities = Object.freeze({
  hooks: false,
  awaitingInput: false,
  backgroundAgents: false,
  resume: false,
  packs: false,
  packNotice: false,
  statusLine: false,
  rtk: false,
  antiSlop: false,
  compactQuiet: false,
  skipPermissionsFlag: false,
  headless: false,
});

function createCustomAdapter(declaration: CustomAgentDeclaration): AgentAdapter {
  const declaredArgs = Object.freeze([...declaration.args]);
  const busyTitle = declaration.busyTitle?.trim() || null;
  const idleTitle = declaration.idleTitle?.trim() || null;

  function classifyTitle(title: string, { cwdBasename = null }: { cwdBasename?: string | null } = {}): string {
    return classifyAgentTitle(title, { cwdBasename }, { isSpinnerChar, busyTitle, idleTitle });
  }

  const titleProfile: AgentTitleProfile = { classifyTitle };

  function resolveCommand(
    { platform, execFile = execFileSync, pathExists = fs.existsSync }: AgentCommandOptions = {},
  ): ResolvedCommand {
    return resolveAgentCommand({
      name: declaration.command,
      platform: platform || process.platform,
      execFile,
      pathExists,
    });
  }

  function buildSpawnCommand(
    { platform, resolved, settingsArgs = [], packArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
  ): { file: string; args: string[] } {
    return buildAgentSpawnCommand({
      name: declaration.command,
      platform,
      resolved,
      argGroups: [settingsArgs, packArgs, agentArgs],
    });
  }

  function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
    return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
  }

  function buildArgs({ initialPrompt = null }: AgentArgsOptions = {}): string[] {
    const args = [...declaredArgs];
    if (initialPrompt != null) args.push(initialPrompt);
    return args;
  }

  function renderPackArgs(): string[] | null {
    return null;
  }

  return {
    id: declaration.id,
    label: declaration.label,
    usageVendor: declaration.id,
    commandName: declaration.command,
    envProfile,
    titleProfile,
    hooks: null,
    capabilities: TITLE_ONLY_CAPABILITIES,
    packCarrier: "none",
    resolveCommand,
    buildSpawnCommand,
    buildEnv,
    buildArgs,
    renderPackArgs,
  };
}

export { createCustomAdapter };
