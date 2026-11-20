import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hookLaunch } from "../../server/runtime-paths.ts";
import { glimmervoidHomeDir } from "../../server/core/config-path-core.ts";
import { writeTextAtomicSync } from "../../server/json-file.ts";
import { errorMessage } from "../../shared/text.ts";
import { PI_LAUNCH_ENV_NAME, PI_SKIP_PERMISSIONS_FLAG, piLaunchConfigContent, renderPiExtension } from "../core/pi-extension-core.ts";
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
import { expandTilde } from "../../server/usage/core/usage-scan-core.ts";

const ID = "pi";
const COMMAND_NAME = "pi";
const EXTENSION_FILE_NAME = "glimmervoid.js";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const HOOK_TOOL_RELAY_LAUNCH = hookLaunch("hook-tool-relay");
const EXTENSION_FOLDER_MODE = 0o700;
const EXTENSION_FILE_MODE = 0o600;
const EXTENSION_REFUSAL = "the hook relay path cannot be written into a pi extension";
const CLEAN_HOME_REFUSAL = "pi always reads the operator's own settings, so it cannot run in a clean home";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { PI_SKIP_VERSION_CHECK: "1" },
};

const SIGNAL_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  userpromptsubmit: "resume",
  turnstart: "working",
  stop: "ready",
  interrupt: "ready",
  permissionrequest: "awaiting-input",
  permissionresult: "working",
  elicitation: "awaiting-input",
  elicitationresult: "working",
  precompact: "compaction-start",
  postcompact: "compaction-end",
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
  taskTitle: { readsTranscriptTitle: false, genericTitles: ["pi"], agentSuffix: null, hookTitleField: "session_title" },
};

function extensionFolderPath(env: Record<string, string | undefined> = process.env, homedir: string = os.homedir()): string {
  return path.join(glimmervoidHomeDir(homedir, env), "agent-homes", ID);
}

function extensionFilePath(env: Record<string, string | undefined> = process.env): string {
  return path.join(extensionFolderPath(env), EXTENSION_FILE_NAME);
}

function writeExtension(extensionFolder: string, extensionSource: string): string | null {
  try {
    fs.mkdirSync(extensionFolder, { recursive: true, mode: EXTENSION_FOLDER_MODE });
    writeTextAtomicSync(path.join(extensionFolder, EXTENSION_FILE_NAME), extensionSource, { mode: EXTENSION_FILE_MODE });
    return null;
  } catch (error) {
    return `${extensionFolder} could not be written: ${errorMessage(error)}`;
  }
}

function prepareHome(env: Record<string, string | undefined>, { listenerPort, isCleanHome, packSkillDirs = [], packServers = [] }: GeneratedHomeLaunch): { home: string; homeEnvValue: string } | { refusal: string } {
  if (isCleanHome) return { refusal: CLEAN_HOME_REFUSAL };
  const extensionSource = renderPiExtension(RELAY_LAUNCH, HOOK_TOOL_RELAY_LAUNCH);
  if (extensionSource === null) return { refusal: EXTENSION_REFUSAL };
  const extensionFolder = extensionFolderPath(env);
  const writeFailure = writeExtension(extensionFolder, extensionSource);
  if (writeFailure) return { refusal: writeFailure };
  return { home: extensionFolder, homeEnvValue: piLaunchConfigContent({ mcpUrl: `http://127.0.0.1:${listenerPort}/mcp`, skillPaths: packSkillDirs, packServers }) };
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
  const args = ["-e", extensionFilePath()];
  if (dangerouslySkipPermissions) args.push(`--${PI_SKIP_PERMISSIONS_FLAG}`);
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt) args.push("--", initialPrompt);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  injection: {
    kind: "generated-home",
    homeEnvName: PI_LAUNCH_ENV_NAME,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayTurnHooksOff: () => false,
  },
};

const pi = {
  id: ID,
  promptContextReply: "additional-context",
  label: "pi",
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
    backgroundAgents: false,
    resume: true,
    planLimits: false,
    saneYolo: false,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: false,
    subagentTurnStops: false,
  },
} satisfies AgentAdapterShape;

function piEnvDir(agentEnv: Record<string, string | undefined>, name: string): string {
  const configured = agentEnv[name]?.trim() ?? "";
  if (!configured) return "";
  const expanded = expandTilde(configured, agentEnv, os.homedir());
  return expanded ? path.resolve(expanded) : "";
}

function piSessionRoots(agentEnv: Record<string, string | undefined>): string[] {
  const agentDir = piEnvDir(agentEnv, "PI_CODING_AGENT_DIR") || path.join(agentEnv.HOME?.trim() || os.homedir(), ".pi", "agent");
  const sessionDirOverride = piEnvDir(agentEnv, "PI_CODING_AGENT_SESSION_DIR");
  return [...(sessionDirOverride ? [sessionDirOverride] : []), path.join(agentDir, "sessions")];
}

export default pi;
export { piSessionRoots };
