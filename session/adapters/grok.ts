import { isRecord } from "../../shared/coerce.ts";
import { errorMessage } from "../../shared/text.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { relayPath } from "../../server/runtime-paths.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { renderGrokHooksFile, classifyGrokHooksFile } from "../core/grok-hooks-file-core.ts";
import type { ResolvedCommand } from "../core/spawn-command.ts";
import { firstCharOfTitle, isBrailleChar, isPathLikeTitle } from "../core/title-classifier-core.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "grok";
const COMMAND_NAME = "grok";
const RELAY_PATH = relayPath("hook-relay");
const HOOK_TOOL_RELAY_PATH = relayPath("hook-tool-relay");
const HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "SubagentStart",
  "SubagentStop",
];
const MANAGED_HOOK_EVENT_SETS = [[
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
]];
const ACTION_REQUIRED_MARKER = String.fromCodePoint(0x26a0);
const CLAUDE_COMPAT_HOOKS_ENV = "GROK_CLAUDE_HOOKS_ENABLED";
const PROJECT_CONFIG_CANDIDATES = Object.freeze([
  Object.freeze({ relPath: ".claude/settings.json", presenceIsHit: false }),
  Object.freeze({ relPath: ".claude/settings.local.json", presenceIsHit: false }),
]);

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { [CLAUDE_COMPAT_HOOKS_ENV]: "false" },
};

function notificationType(payload: HookPayload | null | undefined): string {
  return String(payload?.notificationType || payload?.notification_type || "").toLowerCase();
}

function isMainSessionPayload(payload: HookPayload | null | undefined): boolean {
  return !payload?.subagentType && !payload?.subagent_type;
}

function mapBackgroundTask(task: unknown): unknown {
  if (!isRecord(task)) return task;
  return {
    ...task,
    ...(typeof task.agentType === "string" ? { agent_type: task.agentType } : {}),
  };
}

function mapHookPayload(_event: string, payload: HookPayload): HookPayload {
  if (!isRecord(payload)) return payload;
  return {
    ...payload,
    ...(typeof payload.subagentId === "string" ? { agent_id: payload.subagentId } : {}),
    ...(typeof payload.subagentType === "string" ? { agent_type: payload.subagentType } : {}),
    ...(Array.isArray(payload.backgroundTasks)
      ? { background_tasks: payload.backgroundTasks.map(mapBackgroundTask) }
      : {}),
  };
}

function mayContributeHooks(configText: unknown): boolean {
  if (typeof configText !== "string") return false;
  let settings: unknown;
  try {
    settings = JSON.parse(configText);
  } catch {
    return true;
  }
  if (!isRecord(settings)) return false;
  return Object.hasOwn(settings, "hooks");
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "subagentstart") return "subagent-start";
  if (normalizedEvent === "subagentstop") return "subagent-stop";
  if (!isMainSessionPayload(payload)) return null;
  switch (normalizedEvent) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return payload?.reason === "end_turn" ? "ready" : null;
    case "stopfailure":
    case "stopcancelled":
      return "ready";
    case "notification": {
      const type = notificationType(payload);
      if (type === "idle_prompt") return "ready";
      if (type === "permission_prompt" || type === "approval_required") return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

function mapHookConfidence(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  if (String(event || "").toLowerCase() !== "notification") return null;
  const type = notificationType(payload);
  if (type === "permission_prompt" || type === "approval_required") return "permission";
  return null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.sessionId;
}

function classifyTitle(title: string | null | undefined): string {
  const normalizedTitle = String(title || "");
  if (isPathLikeTitle(normalizedTitle)) return "ignore";
  if (isBrailleChar(firstCharOfTitle(normalizedTitle))) return "working";
  if (normalizedTitle.startsWith(ACTION_REQUIRED_MARKER)) return "awaiting-input";
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID], agentSuffix: ` - ${ID}` },
};

function grokHome(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  const configuredHome = typeof env.GROK_HOME === "string" ? env.GROK_HOME.trim() : "";
  if (configuredHome) return pathApi.resolve(configuredHome);
  return pathApi.join(homedir, ".grok");
}

function hooksFilePath(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir(),
): string {
  return path.join(grokHome(env, homedir), "hooks", "glimmervoid.json");
}

function nativeBinaryPath({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
}: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
} = {}): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  const binaryName = platform === "win32" ? "grok.exe" : "grok";
  return pathApi.join(grokHome(env, homedir, platform), "bin", binaryName);
}

function resolveCommand({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  warn = console.warn,
}: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
  existsSync?: (candidate: string) => boolean;
  realpathSync?: (candidate: string) => string;
  warn?: (message: string) => void;
} = {}): ResolvedCommand {
  const candidate = nativeBinaryPath({ platform, env, homedir });
  try {
    if (existsSync(candidate)) return { path: realpathSync(candidate), kind: "exe" };
  } catch (error) {
    warn(`[glimmervoid] could not resolve the native 'grok' binary at ${candidate}: ${errorMessage(error)}`);
    return { path: null, kind: "unresolved" };
  }
  warn(`[glimmervoid] could not resolve the native 'grok' binary at ${candidate}`);
  return { path: null, kind: "unresolved" };
}

function buildSpawnCommand(
  { resolved, settingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  if (!resolved?.path) throw new Error("the native grok binary is not resolved");
  return { file: resolved.path, args: [...settingsArgs, ...agentArgs] };
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = ["--no-auto-update"];
  if (dangerouslySkipPermissions) args.push("--always-approve");
  if (resumeSessionId) args.push("-r", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  mapPayload: mapHookPayload,
  injection: {
    kind: "home-hooks-file",
    filePath: hooksFilePath,
    expectedContents: () => renderGrokHooksFile({ relayPath: RELAY_PATH, events: HOOK_EVENTS, hookToolRelayPath: HOOK_TOOL_RELAY_PATH }),
    classifyContents: (contents: string) => classifyGrokHooksFile(contents, {
      relayPath: RELAY_PATH,
      events: HOOK_EVENTS,
      managedEventSets: MANAGED_HOOK_EVENT_SETS,
      hookToolRelayPath: HOOK_TOOL_RELAY_PATH,
    }),
    projectConfigCandidates: PROJECT_CONFIG_CANDIDATES,
    mayContributeHooks,
  },
};

const grok = {
  id: ID,
  label: "Grok Build",
  usageVendor: "grok",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  sessionIdOf,
  mapHookPayload,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  classifyTitle,
  grokHome,
  hooksFilePath,
  nativeBinaryPath,
  mayContributeHooks,
  PROJECT_CONFIG_CANDIDATES,
  CLAUDE_COMPAT_HOOKS_ENV,
  HOOK_TOOL_RELAY_PATH,
  HOOK_EVENTS,
  MANAGED_HOOK_EVENT_SETS,
  RELAY_PATH,
  ACTION_REQUIRED_MARKER,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    statusLine: false,
    rtk: false,
    saneYolo: true,
    antiSlop: false,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export default grok;
