import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execFileSync } from "../../server/child-process-safe.ts";
import { relayPath } from "../../server/runtime-paths.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";
import { classifyKimiConfig, renderKimiHooksBlock } from "../core/kimi-hooks-block-core.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
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
const SETUP_COMMAND = "glimmervoid agent setup kimi";
const RELAY_PATH = relayPath("hook-relay");
const HOOK_EVENTS: readonly string[] = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Interrupt",
  "PermissionRequest",
  "PermissionResult",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
]);
const ASK_TOOL_EVENTS: readonly string[] = Object.freeze(["PreToolUse", "PostToolUse"]);

const envProfile: AgentEnvProfile = {
  scrub: [],
  set: { KIMI_CODE_NO_AUTO_UPDATE: "1" },
};

function isAskUserQuestion(payload?: HookPayload): boolean {
  return payload?.tool_name === ASK_USER_QUESTION_TOOL_NAME;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  switch (String(event || "").toLowerCase()) {
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
      return isAskUserQuestion(payload) ? "awaiting-input" : null;
    case "posttooluse":
      return isAskUserQuestion(payload) ? "working" : null;
    case "subagentstart":
      return "subagent-start";
    case "subagentstop":
      return "subagent-stop";
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
  taskTitle: { readsTranscriptTitle: false, genericTitles: [ID, "Kimi Code"], agentSuffix: null },
};

function kimiHome(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir(),
): string {
  const configuredHome = typeof env.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  if (configuredHome) return path.resolve(configuredHome);
  return path.join(homedir, ".kimi-code");
}

function configFilePath(
  env: Record<string, string | undefined> = process.env,
  homedir: string = os.homedir(),
): string {
  return path.join(kimiHome(env, homedir), "config.toml");
}

function expectedHooksBlock(): string | null {
  return renderKimiHooksBlock({
    relayPath: RELAY_PATH,
    events: HOOK_EVENTS,
    askToolEvents: ASK_TOOL_EVENTS,
    askToolName: ASK_USER_QUESTION_TOOL_NAME,
  });
}

function classifyConfigContents(contents: string): string {
  const expectedBlock = expectedHooksBlock();
  if (expectedBlock === null) return "unrenderable";
  return classifyKimiConfig(contents, expectedBlock);
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
  injection: {
    kind: "home-hooks-file",
    setupCommand: SETUP_COMMAND,
    filePath: configFilePath,
    classifyContents: classifyConfigContents,
    isSaneYoloReady: () => false,
    projectConfigCandidates: [],
    userConfigFolders: () => [],
    mayContributeHooks: () => false,
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
  configFilePath,
  expectedHooksBlock,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    statusLine: false,
    rtk: false,
    saneYolo: false,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
  },
} satisfies AgentAdapterShape;

export default kimi;
