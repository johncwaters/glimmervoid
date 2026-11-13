import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hookLaunch } from "../../server/runtime-paths.ts";
import { glimmervoidHomeDir } from "../../server/core/config-path-core.ts";
import { writeTextAtomicSync } from "../../server/json-file.ts";
import { errorMessage } from "../../shared/text.ts";
import { openCodeConfigContent, openCodePluginFiles } from "../core/opencode-plugin-core.ts";
import type { AgentEnvProfile } from "../core/spawn-env.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentTitleProfile,
  GeneratedHomeLaunch,
} from "./index.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";

const ID = "opencode";
const COMMAND_NAME = "opencode";
const CONFIG_CONTENT_ENV_NAME = "OPENCODE_CONFIG_CONTENT";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const PLUGIN_FOLDER_MODE = 0o700;
const PLUGIN_FILE_MODE = 0o600;
const PLUGIN_REFUSAL = "the hook relay path cannot be written into an OpenCode plugin";
const CLEAN_HOME_REFUSAL = "OpenCode always reads the operator's own config, so it cannot run in a clean home";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
};

const SIGNAL_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  userpromptsubmit: "resume",
  turnstart: "working",
  stop: "ready",
  stopfailure: "ready",
  interrupt: "ready",
  permissionrequest: "awaiting-input",
  permissionresult: "working",
  elicitation: "awaiting-input",
  elicitationresult: "working",
  precompact: "compaction-start",
  postcompact: "compaction-end",
  subagentstart: "subagent-start",
  subagentstop: "subagent-stop",
});

const PROMPT_KIND_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  permissionrequest: "permission",
  elicitation: "elicitation",
});

function normalizedEventOf(event: string): string {
  return String(event || "").toLowerCase();
}

function mapHookToSignal(event: string): string | null {
  return SIGNAL_BY_EVENT[normalizedEventOf(event)] ?? null;
}

function mapHookPromptKind(event: string): string | null {
  return PROMPT_KIND_BY_EVENT[normalizedEventOf(event)] ?? null;
}

function mapHookConfidence(): string | null {
  return null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.session_id;
}

function classifyTitle(): string {
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: ["OpenCode", "OC"], agentSuffix: null, agentPrefix: "OC |", hookTitleField: "session_title" },
};

function pluginFolderPath(env: Record<string, string | undefined> = process.env, homedir: string = os.homedir()): string {
  return path.join(glimmervoidHomeDir(homedir, env), "agent-homes", ID);
}

function mcpUrlFor(listenerPort: number): string {
  return `http://127.0.0.1:${listenerPort}/mcp`;
}

function writePluginFolder(pluginFolder: string, files: Readonly<Record<string, string>>): string | null {
  try {
    fs.mkdirSync(pluginFolder, { recursive: true, mode: PLUGIN_FOLDER_MODE });
    for (const [fileName, content] of Object.entries(files)) {
      writeTextAtomicSync(path.join(pluginFolder, fileName), content, { mode: PLUGIN_FILE_MODE });
    }
    return null;
  } catch (error) {
    return `${pluginFolder} could not be written: ${errorMessage(error)}`;
  }
}

function prepareHome(env: Record<string, string | undefined>, { listenerPort, isCleanHome }: GeneratedHomeLaunch): { home: string; homeEnvValue: string } | { refusal: string } {
  if (isCleanHome) return { refusal: CLEAN_HOME_REFUSAL };
  const files = openCodePluginFiles(RELAY_LAUNCH);
  if (files === null) return { refusal: PLUGIN_REFUSAL };
  const pluginFolder = pluginFolderPath(env);
  const writeFailure = writePluginFolder(pluginFolder, files);
  if (writeFailure) return { refusal: writeFailure };
  return { home: pluginFolder, homeEnvValue: openCodeConfigContent(env[CONFIG_CONTENT_ENV_NAME], pathToFileURL(pluginFolder).href, mcpUrlFor(listenerPort)) };
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: CLEAN_HOME_REFUSAL };
}

function releaseHome(): void {}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = ["--standalone"];
  if (dangerouslySkipPermissions) args.push("--auto");
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt) args.push(`--prompt=${initialPrompt}`);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: {
    kind: "generated-home",
    homeEnvName: CONFIG_CONTENT_ENV_NAME,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayTurnHooksOff: () => false,
  },
};

const opencode = {
  id: ID,
  label: "OpenCode",
  usageVendor: ID,
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  sessionIdOf,
  mapHookToSignal,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    planLimits: false,
    saneYolo: false,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: false,
    subagentTurnStops: false,
  },
} satisfies AgentAdapterShape;

export default opencode;
