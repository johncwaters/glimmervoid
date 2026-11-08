import fs from "node:fs";
import path from "node:path";

import { execFileSync } from "../../server/child-process-safe.ts";
import { hookLaunch } from "../../server/runtime-paths.ts";
import { GEMINI_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { GEMINI_HOME_PROFILE, doesProjectConfigTurnHooksOff } from "../core/agent-home-core.ts";
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

const ID = "gemini";
const COMMAND_NAME = "gemini";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const HOOK_TOOL_RELAY_LAUNCH = hookLaunch("hook-tool-relay");
const SANE_YOLO_EVENT = "BeforeTool";
const HOOK_EVENTS: readonly string[] = Object.freeze(["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "AfterTool", "Notification"]);
const HOOKS_REFUSAL = "the hook relay path cannot be written into gemini hooks";
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

function expectedHooks(): string | null {
  const hooksByEvent: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const command = buildHookCommand(RELAY_LAUNCH, event);
    if (!command) return null;
    hooksByEvent[event] = [{ hooks: [{ type: "command", command }] }];
  }
  const saneYoloCommand = buildHookCommand(HOOK_TOOL_RELAY_LAUNCH, "saneYolo", [GEMINI_SANE_YOLO_FLAVOR]);
  if (!saneYoloCommand) return null;
  hooksByEvent[SANE_YOLO_EVENT] = [{ hooks: [{ type: "command", command: saneYoloCommand }] }];
  return JSON.stringify(hooksByEvent);
}

function describeInstalledHooks(): InstalledHooks {
  if (expectedHooks() === null) return { unavailableReason: HOOKS_REFUSAL, isBestEffort: false };
  return { version: null, isBestEffort: false, hooks: [...HOOK_EVENTS.map((event) => ({ event, matcher: null, route: null })), { event: SANE_YOLO_EVENT, matcher: null, route: "saneYolo" }] };
}

function prepareHome(env: Record<string, string | undefined>): { home: string } | { refusal: string } {
  const managedHooks = expectedHooks();
  if (managedHooks === null) return { refusal: HOOKS_REFUSAL };
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

function configFilePath(env: Record<string, string | undefined> = process.env, homedir?: string): string {
  return path.join(realAgentHome(GEMINI_HOME_PROFILE, env, homedir), GEMINI_HOME_PROFILE.config.configName);
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
