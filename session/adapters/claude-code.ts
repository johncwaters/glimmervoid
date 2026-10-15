import fs from "node:fs";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import { isBrailleChar, isSpinnerChar } from "../core/title-classifier-core.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { supervisionLine } from "../core/session-routes.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { execFileSync } from "../../server/child-process-safe.ts";
import type { AgentAdapterShape, AgentArgsOptions, AgentHookProfile, AgentLaunchSession, AgentLaunchSessionOptions, AgentSpawnCommandOptions } from "./index.ts";
import { PLAN_TOOL_NAME } from "../../shared/contracts/index.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";

const ID = "claude-code";
const COMMAND_NAME = "claude";

const envProfile: AgentEnvProfile = {
  scrub: [
    "CLAUDECODE",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
  ],
  set: { CLAUDE_CODE_NO_FLICKER: "1", FORCE_HYPERLINK: "1" },
};

const KNOWN_IDLE_CODEPOINTS = new Set([0x2733]);

function isKnownIdleChar(char: string | null | undefined): boolean {
  if (!char) return false;
  return KNOWN_IDLE_CODEPOINTS.has(char.codePointAt(0) ?? 0);
}

const titleProfile = {
  isSpinnerChar,
  isIdleChar: isKnownIdleChar,
  dropsLeadingAscii: true,
  unknownGlyphHint: "If this is a new idle glyph, add it to KNOWN_IDLE_CODEPOINTS.",
  taskTitle: { readsTranscriptTitle: true, genericTitles: ["Claude Code"], agentSuffix: null },
};

function notificationType(payload: HookPayload | null | undefined): string {
  return String((payload && (payload.notification_type || payload.notificationType)) || "").toLowerCase();
}

function mapHookConfidence(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "permissionrequest") {
    if (String(payload?.tool_name || "") === PLAN_TOOL_NAME) return "plan";
    return "permission";
  }
  if (e === "notification") {
    const t = notificationType(payload);
    if (t === "permission_prompt") return "permission";
    if (t.startsWith("elicitation")) return "elicitation";
  }
  return null;
}

function mapHookPromptToolName(event: string, payload?: HookPayload): string | null {
  if (String(event || "").toLowerCase() !== "permissionrequest") return null;
  if (mapHookPromptKind(event, payload) !== "permission") return null;
  const toolName = payload?.tool_name;
  if (typeof toolName !== "string" || !toolName) return null;
  return toolName;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      return "session-start";
    case "precompact":
      return "compaction-start";
    case "postcompact":
      return "compaction-end";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return "ready";
    case "subagentstart":
      return "subagent-start";
    case "subagentstop":
      return "subagent-stop";
    case "taskcreated":
      return "task-created";
    case "taskcompleted":
      return "task-completed";
    case "teammateidle":
      return "teammate-idle";
    case "permissionrequest":
      return "awaiting-input";
    case "posttooluse": {
      const tool = String(payload?.tool_name || "");
      if (tool === "ScheduleWakeup") return "wakeup-scheduled";
      if (tool === "CronCreate") return "cron-created";
      if (tool === "CronDelete") return "cron-deleted";
      return null;
    }
    case "notification": {
      const t = notificationType(payload);
      if (t === "idle_prompt") return "ready";
      if (t === "permission_prompt" || t.startsWith("elicitation")) return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  mapPromptToolName: mapHookPromptToolName,
  injection: { kind: "settings-file" },
};

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
  { platform, resolved, settingsArgs: injectedSettingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [injectedSettingsArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

const settingsArgs = (settingsPath: string): string[] => ["--settings", settingsPath];

const SESSION_ID_FLAG = "--session-id";

function requestedSessionId(extraArgs: readonly string[]): string | null {
  const flagIndex = extraArgs.indexOf(SESSION_ID_FLAG);
  if (flagIndex !== -1) return extraArgs[flagIndex + 1] ?? null;
  const assignment = extraArgs.find((argument) => argument.startsWith(`${SESSION_ID_FLAG}=`));
  return assignment ? assignment.slice(SESSION_ID_FLAG.length + 1) : null;
}

function launchSessionId({ resumeSessionId, extraArgs, generatedId }: AgentLaunchSessionOptions): AgentLaunchSession {
  const knownSessionId = resumeSessionId ?? requestedSessionId(extraArgs);
  if (knownSessionId) return { agentSessionId: knownSessionId, extraArgs: [...extraArgs] };
  return { agentSessionId: generatedId, extraArgs: [...extraArgs, SESSION_ID_FLAG, generatedId] };
}

const APPEND_SYSTEM_PROMPT_FLAG = "--append-system-prompt";
const APPEND_SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file";
const APPENDED_SYSTEM_PROMPT_FLAGS = Object.freeze([APPEND_SYSTEM_PROMPT_FLAG, APPEND_SYSTEM_PROMPT_FILE_FLAG]);

function isAppendedSystemPromptArgument(launchArgument: string): boolean {
  return APPENDED_SYSTEM_PROMPT_FLAGS.some((flag) => launchArgument === flag || launchArgument.startsWith(`${flag}=`));
}

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
  hasOuterSandbox = false,
  canRunHelpCommand = true,
}: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (canRunHelpCommand && !extraArgs.some(isAppendedSystemPromptArgument)) args.push(APPEND_SYSTEM_PROMPT_FLAG, supervisionLine({ isSandboxed: hasOuterSandbox }));
  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index];
    if (resumeSessionId && argument === "--session-id") {
      index += 1;
      continue;
    }
    if (resumeSessionId && argument.startsWith("--session-id=")) continue;
    args.push(argument);
  }
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const claudeCode = {
  id: ID,
  label: "Claude Code",
  usageVendor: "claude",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  settingsArgs,
  launchSessionId,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    statusLine: true,
    rtk: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
  },
  isBrailleChar,
  isSpinnerChar,
  isKnownIdleChar,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  mapHookPromptToolName,
} satisfies AgentAdapterShape;

export default claudeCode;
