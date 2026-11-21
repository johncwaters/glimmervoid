import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MCP_URL_ENV } from "../../mcp/core/agent-config.ts";
import { hookLaunch, installedHookLaunch } from "../../server/runtime-paths.ts";
import { writeTextAtomicSync } from "../../server/json-file.ts";
import { canonicalizePath } from "../../shared/canonical-paths.ts";
import { errorMessage } from "../../shared/text.ts";
import { ANTIGRAVITY_PLUGIN_NAME, ANTIGRAVITY_QUESTION_TOOL_NAME, antigravitySessionSettings, createConversationTagger, hasRunningSubagent, packSkillWorkspacesOf, renderAntigravityPlugin } from "../core/antigravity-plugin-core.ts";
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

const ID = "antigravity";
const COMMAND_NAME = "agy";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const PLUGIN_FOLDER_MODE = 0o700;
const PLUGIN_FILE_MODE = 0o600;
const PLUGIN_REFUSAL = "the hook relay path cannot be written into an Antigravity plugin";
const SANDBOX_REFUSAL = "Antigravity reads its sign-in from the operator's own ~/.gemini, which a sandboxed session must not see";
const CLEAN_HOME_REFUSAL = "Antigravity always reads the operator's own ~/.gemini and sign-in, so it cannot run in a clean home";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: {},
};

const SIGNAL_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  pretooluse: "working",
  posttooluse: "working",
});

const SIGNAL_BY_AGENT_STATE: Readonly<Record<string, string>> = Object.freeze({
  tool_use: "awaiting-input",
  working: "working",
  idle: "ready",
});

function normalizedEventOf(event: string): string {
  return String(event || "").toLowerCase();
}

function isPermissionState(event: string, payload?: HookPayload): boolean {
  return normalizedEventOf(event) === "agentstate" && payload?.agent_state === "tool_use";
}

const SIGNAL_BY_SUBAGENT_EVENT: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "subagent-start",
  stop: "subagent-stop",
});

function isSubagentEvent(payload?: HookPayload): boolean {
  return typeof payload?.agent_id === "string";
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = normalizedEventOf(event);
  if (isSubagentEvent(payload)) return SIGNAL_BY_SUBAGENT_EVENT[normalizedEvent] ?? null;
  if (normalizedEvent === "agentstate" && payload?.agent_state === "idle" && hasRunningSubagent(payload?.subagents)) return "working";
  if (normalizedEvent === "agentstate" && payload?.agent_state === "idle" && payload?.isTurnOpen !== true) return null;
  if (normalizedEvent === "preinvocation") return payload?.invocationNum === 0 ? "resume" : "working";
  if (normalizedEvent === "stop") return payload?.fullyIdle === true ? "ready" : null;
  if (normalizedEvent === "agentstate") return SIGNAL_BY_AGENT_STATE[String(payload?.agent_state)] ?? null;
  return SIGNAL_BY_EVENT[normalizedEvent] ?? null;
}

function createPayloadEnricher(): (event: string, payload: HookPayload) => HookPayload {
  return createConversationTagger();
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  if (!isPermissionState(event, payload)) return null;
  return payload?.pendingToolName === ANTIGRAVITY_QUESTION_TOOL_NAME ? "elicitation" : "permission";
}

function mapHookConfidence(): string | null {
  return null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return isSubagentEvent(payload) ? undefined : payload?.conversationId || undefined;
}

function classifyTitle(): string {
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: ["agy", "Antigravity"], agentSuffix: null },
};

function pluginFolderPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "plugins", ANTIGRAVITY_PLUGIN_NAME);
}

function writePlugin(pluginFolder: string, pluginFiles: Readonly<Record<string, string>>): string | null {
  try {
    fs.mkdirSync(pluginFolder, { recursive: true, mode: PLUGIN_FOLDER_MODE });
    for (const [fileName, fileText] of Object.entries(pluginFiles)) {
      writeTextAtomicSync(path.join(pluginFolder, fileName), fileText, { mode: PLUGIN_FILE_MODE });
    }
    return null;
  } catch (error) {
    return `${pluginFolder} could not be written: ${errorMessage(error)}`;
  }
}

function prepareHome(
  _env: Record<string, string | undefined>,
  { listenerPort, sessionFolder, isCleanHome, isSandboxed = false, packSkillDirs = [], sharedPackServers = [], hasPackHooks = false }: GeneratedHomeLaunch,
): { home: string; homeEnvValue: string; args: string[] } | { refusal: string } {
  if (isCleanHome) return { refusal: CLEAN_HOME_REFUSAL };
  if (isSandboxed) return { refusal: SANDBOX_REFUSAL };
  const pluginFiles = renderAntigravityPlugin(installedHookLaunch("hook-relay"), installedHookLaunch("mcp-bridge"), sharedPackServers, hasPackHooks ? installedHookLaunch("hook-tool-relay") : null);
  const packSkillWorkspaces = packSkillWorkspacesOf(packSkillDirs);
  const sessionSettings = antigravitySessionSettings([...new Set([sessionFolder, canonicalizePath(sessionFolder)]), ...packSkillWorkspaces], RELAY_LAUNCH);
  if (pluginFiles === null || sessionSettings === null) return { refusal: PLUGIN_REFUSAL };
  const pluginFolder = pluginFolderPath();
  const writeFailure = writePlugin(pluginFolder, pluginFiles);
  if (writeFailure) return { refusal: writeFailure };
  return { home: pluginFolder, homeEnvValue: `http://127.0.0.1:${listenerPort}/mcp`, args: ["--settings", sessionSettings, ...packSkillWorkspaces.flatMap((workspace) => ["--add-dir", workspace])] };
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
  const args: string[] = [];
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (resumeSessionId) args.push("--conversation", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt) args.push("-i", initialPrompt);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  createPayloadEnricher,
  injection: {
    kind: "generated-home",
    homeEnvName: MCP_URL_ENV,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayTurnHooksOff: () => false,
  },
};

const antigravity = {
  id: ID,
  inputReady: "cursor-shown",
  promptContextReply: "inject-steps",
  questionDenyReply: "decision",
  label: "Antigravity CLI",
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

export default antigravity;
