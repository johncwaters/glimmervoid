import path from "node:path";

import { QWEN_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { QWEN_HOME_PROFILE, doesProjectConfigTurnHooksOff } from "../core/agent-home-core.ts";
import { holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import type { AgentEnvProfile } from "../core/spawn-env.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";
import { settingsHomeHooks } from "./settings-home-hooks.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentTitleProfile,
  GeneratedHomeLaunch,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "qwen";
const COMMAND_NAME = "qwen";
const SANE_YOLO_EVENT = "PreToolUse";
const HOOK_EVENTS: readonly string[] = Object.freeze(["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest", "PostToolUse", "Notification"]);
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

const { hooksRefusal, expectedHooks, describeInstalledHooks, configFilePath } = settingsHomeHooks({
  agentId: ID,
  relayedEvents: HOOK_EVENTS,
  saneYoloEvent: SANE_YOLO_EVENT,
  saneYoloFlavor: QWEN_SANE_YOLO_FLAVOR,
  homeProfile: QWEN_HOME_PROFILE,
  hookEntryFor: (commandHook) => ({ hooks: [commandHook] }),
});

function prepareHome(env: Record<string, string | undefined>, launch: GeneratedHomeLaunch): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: hooksRefusal };
  return holdPreparedAgentHome(QWEN_HOME_PROFILE, env, () => managedHooks, undefined, undefined, launch.accountFolder ?? null);
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: "qwen cannot run a lane" };
}

function releaseHome(envHome: string): void {
  releaseAgentHome(envHome);
}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

function buildArgs({ dangerouslySkipPermissions = false, resumeSessionId = null, extraArgs = [] }: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["-y"] : [];
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
    homeEnvName: QWEN_HOME_PROFILE.homeEnvName,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [{ relPath: path.join(".qwen", "settings.json") }],
    userConfigFolders: (env) => [realAgentHome(QWEN_HOME_PROFILE, env)],
    mayTurnHooksOff: (configText) => doesProjectConfigTurnHooksOff(QWEN_HOME_PROFILE, configText),
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
  accountHomeProfile: QWEN_HOME_PROFILE,
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

export default qwen;
