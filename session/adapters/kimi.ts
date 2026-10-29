import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";
import { KIMI_HOME_PROFILE, renderKimiHooksBlock } from "../core/agent-home-core.ts";
import { KIMI_SANE_YOLO_FLAVOR } from "../core/sane-yolo.ts";
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

const ID = "kimi";
const COMMAND_NAME = "kimi";
const HOME_ENV_NAME = "KIMI_CODE_HOME";
const RELAY_PATH = relayPath("hook-relay");
const HOOK_TOOL_RELAY_PATH = relayPath("hook-tool-relay");
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
const SANE_YOLO_TOOL_NAMES: readonly string[] = Object.freeze(["Bash", "Read", "ReadMediaFile", "Write", "Edit", "Glob", "Grep"]);

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { KIMI_CODE_NO_AUTO_UPDATE: "1" },
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
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    toolEvents: TOOL_EVENTS,
    matchedToolNames: MATCHED_TOOL_NAMES,
    saneYolo: { relayPath: HOOK_TOOL_RELAY_PATH, toolNames: SANE_YOLO_TOOL_NAMES, agentFlavor: KIMI_SANE_YOLO_FLAVOR },
  });
}

function prepareHome(env: Record<string, string | undefined>): { home: string } | { refusal: string } {
  const hooksBlock = expectedHooksBlock();
  if (hooksBlock === null) return { refusal: "the hook relay path cannot be written into a kimi hooks block" };
  return holdPreparedAgentHome(KIMI_HOME_PROFILE, env, () => hooksBlock);
}

const WINDOWS_SHAPED_ROOT = /^(?:[A-Za-z]:\/|\/\/)/;
const MAX_WORKSPACE_SLUG_LENGTH = 40;

function slugifyWorkspaceName(name: string): string {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "")
    .slice(0, MAX_WORKSPACE_SLUG_LENGTH).replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

function workspaceTrustKey(cwd: string): string {
  const resolved = path.resolve(cwd).replaceAll("\\", "/");
  const trimmed = resolved.replace(/\/+$/, "");
  const root = (WINDOWS_SHAPED_ROOT.test(resolved) ? trimmed.toLowerCase() : trimmed) || resolved;
  const normalized = root.replace(/\/+$/, "");
  const slug = slugifyWorkspaceName(normalized.split("/").pop() ?? normalized);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `wd_${slug}_${hash}`;
}

function physicalPathOf(cwd: string): string | null {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
}

function isWorkspaceTrusted(cwd: string, env: Record<string, string | undefined> = process.env): boolean {
  const physicalCwd = physicalPathOf(cwd);
  if (physicalCwd === null) return false;
  return fs.existsSync(path.join(realAgentHome(KIMI_HOME_PROFILE, env), "workspace-trust", workspaceTrustKey(physicalCwd)));
}

function resolveCommand(
  { platform, execFile = execFileSync, pathExists = fs.existsSync }: {
    platform?: NodeJS.Platform;
    execFile?: PathLookupExecFile;
    pathExists?: (candidate: string) => boolean;
  } = {},
): ResolvedCommand {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    platform: platform || process.platform,
    execFile,
    pathExists,
  });
}

function buildSpawnCommand(
  { platform, resolved, settingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [settingsArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

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
  injection: {
    kind: "generated-home",
    homeEnvName: HOME_ENV_NAME,
    prepareHome,
    releaseHome: releaseAgentHome,
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
  isWorkspaceTrusted,
  workspaceTrustKey,
  mapHookToSignal,
  mapHookPayload,
  configFilePath,
  expectedHooksBlock,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    statusLine: false,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
    subagentTurnStops: true,
    ptyInitialPrompt: true,
    promptContextSupervision: true,
  },
} satisfies AgentAdapterShape;

export default kimi;
