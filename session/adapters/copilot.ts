import fs from "node:fs";
import path from "node:path";

import { execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { COPILOT_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { COPILOT_HOME_PROFILE, doesProjectConfigTurnHooksOff } from "../core/agent-home-core.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import { generatedAgentHomePath, holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import { copilotStateFileToTrust, ensureCopilotFolderTrust } from "../copilot-trust.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
  GeneratedHomeLaunch,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import type { InstalledHooks } from "../core/user-hooks-core.ts";

const ID = "copilot";
const COMMAND_NAME = "copilot";
const RELAY_PATH = relayPath("hook-relay");
const HOOK_TOOL_RELAY_PATH = relayPath("hook-tool-relay");
const SANE_YOLO_EVENT = "preToolUse";
const HOOK_EVENTS: readonly string[] = Object.freeze(["sessionStart", "sessionEnd", "userPromptSubmitted", "agentStop", "errorOccurred", "permissionRequest", "postToolUse", "notification"]);
const HOOKS_REFUSAL = "the hook relay path cannot be written into copilot hooks";
const PERMISSION_NOTIFICATION = "permission_prompt";
const IDLE_NOTIFICATION = "agent_idle";
const QUESTION_NOTIFICATION = "elicitation_dialog";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: {},
};

const HOOK_EVENT_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  sessionend: "session-end",
  userpromptsubmitted: "resume",
  agentstop: "ready",
  permissionrequest: "awaiting-input",
  posttooluse: "working",
});

const NOTIFICATION_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  [PERMISSION_NOTIFICATION]: "awaiting-input",
  [QUESTION_NOTIFICATION]: "awaiting-input",
  [IDLE_NOTIFICATION]: "ready",
});

function notificationTypeOf(payload?: HookPayload): string {
  return String(payload?.notification_type ?? "");
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "notification") return NOTIFICATION_SIGNALS[notificationTypeOf(payload)] ?? null;
  if (normalizedEvent === "erroroccurred") return payload?.recoverable === false ? "ready" : null;
  return HOOK_EVENT_SIGNALS[normalizedEvent] ?? null;
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "permissionrequest") return "permission";
  if (normalizedEvent !== "notification") return null;
  return notificationTypeOf(payload) === PERMISSION_NOTIFICATION ? "permission" : null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.sessionId ?? payload?.session_id;
}

function classifyTitle(): string {
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID, "GitHub Copilot", "Copilot"], agentSuffix: null },
};

function expectedHooks(): string | null {
  const hooksByEvent: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const command = buildHookCommand(RELAY_PATH, event);
    if (!command) return null;
    hooksByEvent[event] = [{ type: "command", command }];
  }
  const saneYoloCommand = buildHookCommand(HOOK_TOOL_RELAY_PATH, "saneYolo", [COPILOT_SANE_YOLO_FLAVOR]);
  if (!saneYoloCommand) return null;
  hooksByEvent[SANE_YOLO_EVENT] = [{ type: "command", command: saneYoloCommand }];
  return JSON.stringify(hooksByEvent);
}

function describeInstalledHooks(): InstalledHooks {
  if (expectedHooks() === null) return { unavailableReason: HOOKS_REFUSAL, isBestEffort: false };
  return { version: null, isBestEffort: false, hooks: [...HOOK_EVENTS.map((event) => ({ event, matcher: null, route: null })), { event: SANE_YOLO_EVENT, matcher: null, route: "saneYolo" }] };
}

const COPILOT_STATE_NAME = "config.json";

function trustSessionFolder(env: Record<string, string | undefined>, folder: string): void {
  const realStatePath = path.join(realAgentHome(COPILOT_HOME_PROFILE, env), COPILOT_STATE_NAME);
  const sessionStatePath = path.join(generatedAgentHomePath(COPILOT_HOME_PROFILE, env), COPILOT_STATE_NAME);
  const trustWarning = ensureCopilotFolderTrust(copilotStateFileToTrust(realStatePath, sessionStatePath), folder);
  if (trustWarning) console.warn(`[copilot] ${trustWarning}`);
}

function prepareHome(env: Record<string, string | undefined>, launch: GeneratedHomeLaunch): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: HOOKS_REFUSAL };
  trustSessionFolder(env, launch.folderTrustRoot);
  return holdPreparedAgentHome(COPILOT_HOME_PROFILE, env, () => managedHooks);
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: "copilot cannot run a lane" };
}

function releaseHome(envHome: string): void {
  releaseAgentHome(envHome);
}

function configFilePath(env: Record<string, string | undefined> = process.env, homedir?: string): string {
  return path.join(realAgentHome(COPILOT_HOME_PROFILE, env, homedir), COPILOT_HOME_PROFILE.config.configName);
}

function resolveCommand(
  { platform, execFile = execFileSync, pathExists = fs.existsSync }: {
    platform?: NodeJS.Platform;
    execFile?: PathLookupExecFile;
    pathExists?: (candidate: string) => boolean;
  } = {},
): ResolvedCommand {
  return resolveAgentCommand({ name: COMMAND_NAME, platform: platform || process.platform, execFile, pathExists });
}

function buildSpawnCommand({ platform, resolved, settingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions): { file: string; args: string[] } {
  return buildAgentSpawnCommand({ name: COMMAND_NAME, platform, resolved, argGroups: [settingsArgs, agentArgs] });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

function buildArgs({ dangerouslySkipPermissions = false, resumeSessionId = null, extraArgs = [] }: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--yolo"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return [...args, ...extraArgs];
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  describeInstalledHooks,
  injection: {
    kind: "generated-home",
    homeEnvName: COPILOT_HOME_PROFILE.homeEnvName,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [{ relPath: path.join(".github", "copilot", "settings.json") }, { relPath: path.join(".github", "copilot", "settings.local.json") }],
    userConfigFolders: (env) => [realAgentHome(COPILOT_HOME_PROFILE, env)],
    mayTurnHooksOff: (configText) => doesProjectConfigTurnHooksOff(COPILOT_HOME_PROFILE, configText),
  },
};

const copilot = {
  id: ID,
  label: "Copilot CLI",
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
  configFilePath,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: false,
    resume: true,
    planLimits: false,
    saneYolo: true,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: false,
    ptyInitialPrompt: true,
  },
  promptContextReply: "message",
} satisfies AgentAdapterShape;

export default copilot;
