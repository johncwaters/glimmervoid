import fs from "node:fs";
import path from "node:path";

import { execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { QWEN_HOME_PROFILE } from "../core/agent-home-core.ts";
import { buildHookCommand } from "../core/hook-command-core.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import { holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentSpawnCommandOptions,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import type { InstalledHooks } from "../core/user-hooks-core.ts";

const ID = "qwen";
const COMMAND_NAME = "qwen";
const RELAY_PATH = relayPath("hook-relay");
const HOOK_EVENTS: readonly string[] = Object.freeze(["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "PostToolUse", "Notification"]);
const HOOKS_REFUSAL = "the hook relay path cannot be written into qwen hooks";
const PERMISSION_NOTIFICATION = "permission_prompt";
const IDLE_NOTIFICATION = "idle_prompt";

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: {},
};

const HOOK_EVENT_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  sessionend: "session-end",
  userpromptsubmit: "resume",
  stop: "ready",
  stopfailure: "ready",
  permissionrequest: "awaiting-input",
  posttooluse: "working",
});

const NOTIFICATION_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  [PERMISSION_NOTIFICATION]: "awaiting-input",
  [IDLE_NOTIFICATION]: "ready",
});

function notificationTypeOf(payload?: HookPayload): string {
  return String(payload?.notification_type ?? "");
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "notification") return NOTIFICATION_SIGNALS[notificationTypeOf(payload)] ?? null;
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
  return payload?.session_id;
}

function classifyTitle(): string {
  return "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID, "Qwen Code"], agentSuffix: null },
};

function expectedHooks(): string | null {
  const hooksByEvent: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const command = buildHookCommand(RELAY_PATH, event);
    if (!command) return null;
    hooksByEvent[event] = [{ hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify(hooksByEvent);
}

function describeInstalledHooks(): InstalledHooks {
  if (expectedHooks() === null) return { unavailableReason: HOOKS_REFUSAL, isBestEffort: false };
  return { version: null, isBestEffort: false, hooks: HOOK_EVENTS.map((event) => ({ event, matcher: null, route: null })) };
}

function prepareHome(env: Record<string, string | undefined>): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: HOOKS_REFUSAL };
  return holdPreparedAgentHome(QWEN_HOME_PROFILE, env, () => managedHooks);
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: "qwen cannot run a lane" };
}

function releaseHome(envHome: string): void {
  releaseAgentHome(envHome);
}

function configFilePath(env: Record<string, string | undefined> = process.env, homedir?: string): string {
  return path.join(realAgentHome(QWEN_HOME_PROFILE, env, homedir), QWEN_HOME_PROFILE.config.configName);
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

function buildArgs({ resumeSessionId = null, extraArgs = [] }: AgentArgsOptions = {}): string[] {
  const args = resumeSessionId ? ["--resume", resumeSessionId] : [];
  return [...args, ...extraArgs];
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  describeInstalledHooks,
  injection: {
    kind: "generated-home",
    homeEnvName: QWEN_HOME_PROFILE.homeEnvName,
    prepareHome,
    prepareScratchHome,
    releaseHome,
  },
};

const qwen = {
  id: ID,
  label: "Qwen Code",
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
    saneYolo: false,
    compactQuiet: false,
    skipPermissionsFlag: false,
    headless: false,
    ptyInitialPrompt: true,
  },
  promptContextReply: "message",
} satisfies AgentAdapterShape;

export default qwen;
