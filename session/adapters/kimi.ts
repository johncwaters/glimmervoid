import fs from "node:fs";
import path from "node:path";

import { hookLaunch } from "../../server/runtime-paths.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";
import { KIMI_MCP_BASE_NAME, KIMI_MCP_CONFIG_NAME, kimiMcpFiles } from "../../mcp/core/agent-config.ts";
import { KIMI_HOME_PROFILE, renderKimiHooksBlock } from "../core/agent-home-core.ts";
import { KIMI_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
import { generatedAgentHomePath, holdPreparedAgentHome, prepareScratchAgentHome, realAgentHome, releaseAgentHome } from "../agent-home.ts";
import type { AgentEnvProfile } from "../core/spawn-env.ts";
import type {
  AgentAdapterShape,
  AgentArgsOptions,
  AgentHookProfile,
  AgentTitleProfile,
  GeneratedHomeLaunch,
  ScratchAgentHome,
} from "./index.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import type { InstalledHooks } from "../core/user-hooks-core.ts";
import { QUESTION_TOOL_HOLD_HOOK_EVENT, QUESTION_TOOL_HOLD_TIMEOUT_MS } from "../../shared/contracts/question-manager.ts";

const ID = "kimi";
const COMMAND_NAME = "kimi";
const HOME_ENV_NAME = "KIMI_CODE_HOME";
const RELAY_LAUNCH = hookLaunch("hook-relay");
const HOOK_TOOL_RELAY_LAUNCH = hookLaunch("hook-tool-relay");
const HOOK_EVENTS: readonly string[] = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Interrupt",
  "PermissionRequest",
  "PermissionResult",
  "PreCompact",
  "PostCompact",
]);
const TOOL_EVENTS: readonly string[] = Object.freeze(["PreToolUse", "PostToolUse"]);
const SUBAGENT_TOOL_NAME = "Agent";
const MATCHED_TOOL_NAMES: readonly string[] = Object.freeze([ASK_USER_QUESTION_TOOL_NAME, SUBAGENT_TOOL_NAME]);
const HOOKS_BLOCK_REFUSAL = "the hook relay path cannot be written into a kimi hooks block";
const QUESTION_HOLD_HOOK_TIMEOUT_SECONDS = Math.ceil(QUESTION_TOOL_HOLD_TIMEOUT_MS / 1000) + 10;
const SANE_YOLO_TOOL_NAMES: readonly string[] = Object.freeze(["Bash", "Read", "ReadMediaFile", "Write", "Edit", "Glob", "Grep"]);

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CODE_TRUST_WORKSPACE: "1" },
};

function isAskUserQuestion(payload?: HookPayload): boolean {
  return payload?.tool_name === ASK_USER_QUESTION_TOOL_NAME;
}

function isSubagentToolCall(payload?: HookPayload): boolean {
  return payload?.tool_name === SUBAGENT_TOOL_NAME && typeof payload.tool_call_id === "string";
}

const TOOL_EVENT_SIGNALS: Record<string, { question: string; subagent: string }> = {
  pretooluse: { question: "awaiting-input", subagent: "subagent-start" },
  posttooluse: { question: "working", subagent: "subagent-stop" },
};

function mapToolEventSignal(normalizedEvent: string, payload?: HookPayload): string | null {
  const signals = TOOL_EVENT_SIGNALS[normalizedEvent];
  if (!signals) return null;
  if (isAskUserQuestion(payload)) return signals.question;
  if (isSubagentToolCall(payload)) return signals.subagent;
  return null;
}

function mapHookPayload(_event: string, payload: HookPayload): HookPayload {
  if (!isSubagentToolCall(payload)) return payload;
  return { ...payload, agent_id: payload.tool_call_id };
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  switch (normalizedEvent) {
    case "sessionstart":
      return "session-start";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
    case "stopfailure":
    case "interrupt":
      return "ready";
    case "permissionrequest":
      return "awaiting-input";
    case "permissionresult":
      return "working";
    case "pretooluse":
    case "posttooluse":
      return mapToolEventSignal(normalizedEvent, payload);
    case "precompact":
      return "compaction-start";
    case "postcompact":
      return "compaction-end";
    default:
      return null;
  }
}

function mapHookConfidence(): string | null {
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const normalizedEvent = String(event || "").toLowerCase();
  if (normalizedEvent === "permissionrequest") return "permission";
  if (normalizedEvent === "pretooluse" && isAskUserQuestion(payload)) return "elicitation";
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
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID, "Kimi Code", "New Session"], agentSuffix: null, hookTitleField: "session_title" },
};

function configFilePath(
  env: Record<string, string | undefined> = process.env,
  homedir?: string,
): string {
  return path.join(realAgentHome(KIMI_HOME_PROFILE, env, homedir), "config.toml");
}

function expectedHooksBlock(): string | null {
  return renderKimiHooksBlock({
    relayLaunch: RELAY_LAUNCH,
    events: HOOK_EVENTS,
    toolEvents: TOOL_EVENTS,
    matchedToolNames: MATCHED_TOOL_NAMES,
    questionHold: { toolName: ASK_USER_QUESTION_TOOL_NAME, event: QUESTION_TOOL_HOLD_HOOK_EVENT, timeoutSeconds: QUESTION_HOLD_HOOK_TIMEOUT_SECONDS },
    saneYolo: { relayLaunch: HOOK_TOOL_RELAY_LAUNCH, toolNames: SANE_YOLO_TOOL_NAMES, agentFlavor: KIMI_SANE_YOLO_FLAVOR },
  });
}

function describeInstalledHooks(): InstalledHooks {
  if (expectedHooksBlock() === null) return { unavailableReason: HOOKS_BLOCK_REFUSAL, isBestEffort: false };
  const relayedHooks = HOOK_EVENTS.map((event) => ({ event, matcher: null, route: null }));
  const matchedToolHooks = TOOL_EVENTS.flatMap((event) => MATCHED_TOOL_NAMES.map((toolName) => ({ event, matcher: `^${toolName}$`, route: null })));
  const questionHoldHook = { event: "PreToolUse", matcher: `^${ASK_USER_QUESTION_TOOL_NAME}$`, route: QUESTION_TOOL_HOLD_HOOK_EVENT };
  const saneYoloHooks = SANE_YOLO_TOOL_NAMES.map((toolName) => ({ event: "PreToolUse", matcher: `^${toolName}$`, route: "saneYolo" }));
  return { version: null, isBestEffort: false, hooks: [...relayedHooks, ...matchedToolHooks, questionHoldHook, ...saneYoloHooks] };
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isPlainFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

function mcpFilesFor(env: Record<string, string | undefined>, listenerPort: number, isCleanHome: boolean): Record<string, string> {
  const generatedHome = generatedAgentHomePath(KIMI_HOME_PROFILE, env, undefined, isCleanHome);
  const generatedMcpPath = path.join(generatedHome, KIMI_MCP_CONFIG_NAME);
  return kimiMcpFiles({
    realMcpJson: readTextOrNull(path.join(realAgentHome(KIMI_HOME_PROFILE, env), KIMI_MCP_CONFIG_NAME)),
    generatedMcpJson: isPlainFile(generatedMcpPath) ? readTextOrNull(generatedMcpPath) : null,
    baseMcpJson: readTextOrNull(path.join(generatedHome, KIMI_MCP_BASE_NAME)),
    listenerPort,
  });
}

function prepareHome(env: Record<string, string | undefined>, { listenerPort, isCleanHome, packSkillDirs = [] }: GeneratedHomeLaunch): { home: string } | { refusal: string } {
  const hooksBlock = expectedHooksBlock();
  if (hooksBlock === null) return { refusal: HOOKS_BLOCK_REFUSAL };
  return holdPreparedAgentHome(KIMI_HOME_PROFILE, env, () => hooksBlock, () => mcpFilesFor(env, listenerPort, isCleanHome), isCleanHome, packSkillDirs);
}

function prepareScratchHome(env: Record<string, string | undefined>, scratch: ScratchAgentHome): { home: string } | { refusal: string } {
  const hooksBlock = expectedHooksBlock();
  if (hooksBlock === null) return { refusal: HOOKS_BLOCK_REFUSAL };
  return prepareScratchAgentHome(KIMI_HOME_PROFILE, { env, renderBlock: () => hooksBlock, ...scratch });
}

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
}: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--yolo"] : [];
  if (resumeSessionId) args.push("-S", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  return args;
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  mapPayload: mapHookPayload,
  describeInstalledHooks,
  injection: {
    kind: "generated-home",
    homeEnvName: HOME_ENV_NAME,
    prepareHome,
    prepareScratchHome,
    releaseHome: releaseAgentHome,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayTurnHooksOff: () => false,
  },
};

const kimi = {
  id: ID,
  label: "Kimi Code",
  usageVendor: "kimi",
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
  mapHookPayload,
  configFilePath,
  expectedHooksBlock,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    planLimits: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
    subagentTurnStops: true,
    ptyInitialPrompt: true,
  },
  promptContextReply: "message",
} satisfies AgentAdapterShape;

export default kimi;
