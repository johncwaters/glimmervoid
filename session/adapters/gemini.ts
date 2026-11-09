import path from "node:path";

import { GEMINI_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { GEMINI_HOME_PROFILE, doesProjectConfigTurnHooksOff } from "../core/agent-home-core.ts";
import { holdPreparedAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import type { AgentEnvProfile } from "../core/spawn-env.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";
import { settingsHomeHooks } from "./settings-home-hooks.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentTitleProfile,
} from "./index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "gemini";
const COMMAND_NAME = "gemini";
const SANE_YOLO_EVENT = "BeforeTool";
const HOOK_EVENTS: readonly string[] = Object.freeze(["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "AfterTool", "Notification"]);
const TOOL_PERMISSION_NOTIFICATION = "ToolPermission";
const WORKING_TITLE_GLYPH = String.fromCodePoint(0x2726);
const ACTION_REQUIRED_TITLE_GLYPH = String.fromCodePoint(0x270b);
const READY_TITLE_GLYPH = String.fromCodePoint(0x25c7);

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
};

const HOOK_EVENT_SIGNALS: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: "session-start",
  sessionend: "session-end",
  beforeagent: "resume",
  afteragent: "ready",
  aftertool: "working",
});

function isToolPermission(payload?: HookPayload): boolean {
  return payload?.notification_type === TOOL_PERMISSION_NOTIFICATION;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "notification") return isToolPermission(payload) ? "awaiting-input" : null;
  return HOOK_EVENT_SIGNALS[normalizedEvent] ?? null;
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  if (String(event || "").toLowerCase() !== "notification") return null;
  return isToolPermission(payload) ? "permission" : null;
}

function sessionIdOf(payload: HookPayload): unknown {
  return payload?.session_id;
}

const TITLE_KIND_BY_GLYPH: Readonly<Record<string, string>> = Object.freeze({
  [WORKING_TITLE_GLYPH]: "working",
  [ACTION_REQUIRED_TITLE_GLYPH]: "awaiting-input",
  [READY_TITLE_GLYPH]: "ready",
});

function classifyTitle(title: string): string {
  const leadingGlyph = String.fromCodePoint(title.codePointAt(0) ?? 0);
  return TITLE_KIND_BY_GLYPH[leadingGlyph] ?? "unknown";
}

const titleProfile: AgentTitleProfile = {
  classifyTitle,
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID, "Gemini CLI"], agentSuffix: null },
};

const { hooksRefusal, expectedHooks, describeInstalledHooks, configFilePath } = settingsHomeHooks({
  agentId: ID,
  relayedEvents: HOOK_EVENTS,
  saneYoloEvent: SANE_YOLO_EVENT,
  saneYoloFlavor: GEMINI_SANE_YOLO_FLAVOR,
  homeProfile: GEMINI_HOME_PROFILE,
  hookEntryFor: (commandHook) => ({ hooks: [commandHook] }),
});

function prepareHome(env: Record<string, string | undefined>): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: hooksRefusal };
  const prepared = holdPreparedAgentHome(GEMINI_HOME_PROFILE, env, () => managedHooks);
  if ("refusal" in prepared) return prepared;
  return { home: path.dirname(prepared.home) };
}

function prepareScratchHome(): { refusal: string } {
  return { refusal: "gemini cannot run a lane" };
}

function releaseHome(envHome: string): void {
  releaseAgentHome(path.join(envHome, GEMINI_HOME_PROFILE.homeEnvSubfolder ?? ""));
}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

function buildArgs({ dangerouslySkipPermissions = false, resumeSessionId = null, extraArgs = [] }: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--approval-mode=yolo"] : [];
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
    homeEnvName: GEMINI_HOME_PROFILE.homeEnvName,
    prepareHome,
    prepareScratchHome,
    releaseHome,
    projectConfigCandidates: [{ relPath: path.join(".gemini", "settings.json") }],
    userConfigFolders: (env) => [realAgentHome(GEMINI_HOME_PROFILE, env)],
    mayTurnHooksOff: (configText) => doesProjectConfigTurnHooksOff(GEMINI_HOME_PROFILE, configText),
  },
};

const gemini = {
  id: ID,
  label: "Gemini CLI",
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

export default gemini;
