import path from "node:path";

import { COPILOT_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { COPILOT_HOME_PROFILE, doesProjectConfigTurnHooksOff } from "../core/agent-home-core.ts";
import { generatedAgentHomePath, holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import { copilotStateFileToTrust, ensureCopilotFolderTrust } from "../copilot-trust.ts";
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

const ID = "copilot";
const COMMAND_NAME = "copilot";
const SANE_YOLO_EVENT = "preToolUse";
const HOOK_EVENTS: readonly string[] = Object.freeze(["sessionStart", "sessionEnd", "userPromptSubmitted", "agentStop", "errorOccurred", "permissionRequest", "postToolUse", "notification"]);
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

const { hooksRefusal, expectedHooks, describeInstalledHooks, configFilePath } = settingsHomeHooks({
  agentId: ID,
  relayedEvents: HOOK_EVENTS,
  saneYoloEvent: SANE_YOLO_EVENT,
  saneYoloFlavor: COPILOT_SANE_YOLO_FLAVOR,
  homeProfile: COPILOT_HOME_PROFILE,
  hookEntryFor: (commandHook) => commandHook,
});

const COPILOT_STATE_NAME = "config.json";

function trustSessionFolder(env: Record<string, string | undefined>, folder: string, accountFolder: string | null): void {
  const realStatePath = path.join(realAgentHome(COPILOT_HOME_PROFILE, env), COPILOT_STATE_NAME);
  const sessionStatePath = path.join(accountFolder ?? generatedAgentHomePath(COPILOT_HOME_PROFILE, env), COPILOT_STATE_NAME);
  const trustWarning = ensureCopilotFolderTrust(copilotStateFileToTrust(realStatePath, sessionStatePath), folder);
  if (trustWarning) console.warn(`[copilot] ${trustWarning}`);
}

function prepareHome(env: Record<string, string | undefined>, launch: GeneratedHomeLaunch): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: hooksRefusal };
  trustSessionFolder(env, launch.folderTrustRoot, launch.accountFolder ?? null);
  return holdPreparedAgentHome(COPILOT_HOME_PROFILE, env, () => managedHooks, undefined, undefined, launch.accountFolder ?? null);
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: "copilot cannot run a lane" };
}

function releaseHome(envHome: string): void {
  releaseAgentHome(envHome);
}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

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
  accountHomeProfile: COPILOT_HOME_PROFILE,
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
